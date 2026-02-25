const dgram = require('dgram');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mime = require('mime-types');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;

class DLNAServer {
  constructor(options = {}) {
    this.name = options.name || 'Media Server';
    this.mediaDir = path.resolve(options.mediaDir || './media');
    this.httpPort = options.httpPort || 8200;
    this.webPort = options.webPort || 3000;
    this.uuid = null;
    this.ssdpSocket = null;
    this.httpServer = null;
    this.localIP = null;
    this.announceInterval = null;
    this.stopped = false;
    this.updateId = 1;

    // Load or create persistent UUID
    this.loadUUID();
  }

  loadUUID() {
    const uuidFile = path.join(this.mediaDir, '.server-uuid');
    try {
      if (fs.existsSync(uuidFile)) {
        const stored = fs.readFileSync(uuidFile, 'utf8').trim();
        // Validate UUID format
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stored)) {
          this.uuid = `uuid:${stored}`;
          return;
        }
      }
    } catch {
      // Ignore read errors
    }

    // Generate new UUID
    const newUuid = crypto.randomUUID();
    this.uuid = `uuid:${newUuid}`;

    // Try to persist it
    try {
      fs.writeFileSync(uuidFile, newUuid, 'utf8');
    } catch (err) {
      console.warn('Could not persist DLNA UUID:', err.message);
    }
  }

  getLocalIP() {
    const interfaces = os.networkInterfaces();

    // Prefer ethernet/wifi over other interfaces
    const preferred = ['eth0', 'eth1', 'en0', 'en1', 'wlan0', 'wlan1'];

    for (const name of preferred) {
      if (interfaces[name]) {
        for (const iface of interfaces[name]) {
          if (iface.family === 'IPv4' && !iface.internal) {
            return iface.address;
          }
        }
      }
    }

    // Fallback: any non-internal IPv4
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }

    return '127.0.0.1';
  }

  async start() {
    this.stopped = false;
    this.localIP = this.getLocalIP();

    try {
      await this.startHTTPServer();
    } catch (err) {
      console.error('Failed to start DLNA HTTP server:', err.message);
      throw err;
    }

    try {
      await this.startSSDP();
      this.startPeriodicAnnounce();
    } catch (err) {
      console.warn('SSDP discovery disabled:', err.message);
      console.warn('TVs may not auto-discover the server, but direct access still works.');
      // Continue without SSDP - server is still usable
    }
  }

  stop() {
    this.stopped = true;

    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }

    // Send bye-bye notification before closing
    if (this.ssdpSocket) {
      try {
        this.sendByebye();
      } catch {
        // Ignore errors during shutdown
      }

      setTimeout(() => {
        if (this.ssdpSocket) {
          try {
            this.ssdpSocket.close();
          } catch {
            // Ignore
          }
          this.ssdpSocket = null;
        }
      }, 200);
    }

    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }

  async startHTTPServer() {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        // Set timeout for requests
        req.setTimeout(30000);
        res.setTimeout(300000); // 5 min for large file transfers

        this.handleHTTPRequest(req, res);
      });

      this.httpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.httpPort} is already in use`));
        } else {
          reject(err);
        }
      });

      this.httpServer.listen(this.httpPort, '0.0.0.0', () => {
        resolve();
      });
    });
  }

  handleHTTPRequest(req, res) {
    // Basic request logging
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (duration > 1000 || res.statusCode >= 400) {
        console.log(`DLNA ${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
      }
    });

    try {
      const url = req.url.split('?')[0]; // Ignore query strings

      if (url === '/description.xml') {
        this.sendDeviceDescription(res);
      } else if (url === '/ContentDirectory.xml') {
        this.sendContentDirectoryDescription(res);
      } else if (url === '/ConnectionManager.xml') {
        this.sendConnectionManagerDescription(res);
      } else if (url === '/control/ContentDirectory') {
        this.handleContentDirectoryControl(req, res);
      } else if (url === '/control/ConnectionManager') {
        this.handleConnectionManagerControl(req, res);
      } else if (url === '/icon-120.png' || url === '/icon-48.png') {
        const iconPath = path.join(__dirname, '..', '..', 'public', url.slice(1));
        if (fs.existsSync(iconPath)) {
          const data = fs.readFileSync(iconPath);
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length });
          res.end(data);
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      } else if (url.startsWith('/media/')) {
        this.serveMediaFile(url, req, res);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    } catch (err) {
      console.error('DLNA HTTP error:', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    }
  }

  sendDeviceDescription(res) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion>
    <major>1</major>
    <minor>0</minor>
  </specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>${this.escapeXml(this.name)}</friendlyName>
    <manufacturer>Lobby TV Media Server</manufacturer>
    <modelName>Simple DLNA Server</modelName>
    <modelNumber>1.0</modelNumber>
    <UDN>${this.uuid}</UDN>
    <iconList>
      <icon>
        <mimetype>image/png</mimetype>
        <width>120</width>
        <height>120</height>
        <depth>32</depth>
        <url>/icon-120.png</url>
      </icon>
      <icon>
        <mimetype>image/png</mimetype>
        <width>48</width>
        <height>48</height>
        <depth>32</depth>
        <url>/icon-48.png</url>
      </icon>
    </iconList>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <SCPDURL>/ContentDirectory.xml</SCPDURL>
        <controlURL>/control/ContentDirectory</controlURL>
        <eventSubURL>/event/ContentDirectory</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <SCPDURL>/ConnectionManager.xml</SCPDURL>
        <controlURL>/control/ConnectionManager</controlURL>
        <eventSubURL>/event/ConnectionManager</eventSubURL>
      </service>
    </serviceList>
  </device>
</root>`;

    res.writeHead(200, {
      'Content-Type': 'text/xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(xml)
    });
    res.end(xml);
  }

  sendContentDirectoryDescription(res) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion>
    <major>1</major>
    <minor>0</minor>
  </specVersion>
  <actionList>
    <action>
      <name>Browse</name>
      <argumentList>
        <argument>
          <name>ObjectID</name>
          <direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable>
        </argument>
        <argument>
          <name>BrowseFlag</name>
          <direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_BrowseFlag</relatedStateVariable>
        </argument>
        <argument>
          <name>Filter</name>
          <direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_Filter</relatedStateVariable>
        </argument>
        <argument>
          <name>StartingIndex</name>
          <direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_Index</relatedStateVariable>
        </argument>
        <argument>
          <name>RequestedCount</name>
          <direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable>
        </argument>
        <argument>
          <name>SortCriteria</name>
          <direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_SortCriteria</relatedStateVariable>
        </argument>
        <argument>
          <name>Result</name>
          <direction>out</direction>
          <relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable>
        </argument>
        <argument>
          <name>NumberReturned</name>
          <direction>out</direction>
          <relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable>
        </argument>
        <argument>
          <name>TotalMatches</name>
          <direction>out</direction>
          <relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable>
        </argument>
        <argument>
          <name>UpdateID</name>
          <direction>out</direction>
          <relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable>
        </argument>
      </argumentList>
    </action>
    <action>
      <name>GetSystemUpdateID</name>
      <argumentList>
        <argument>
          <name>Id</name>
          <direction>out</direction>
          <relatedStateVariable>SystemUpdateID</relatedStateVariable>
        </argument>
      </argumentList>
    </action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_ObjectID</name>
      <dataType>string</dataType>
    </stateVariable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_Result</name>
      <dataType>string</dataType>
    </stateVariable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_BrowseFlag</name>
      <dataType>string</dataType>
      <allowedValueList>
        <allowedValue>BrowseMetadata</allowedValue>
        <allowedValue>BrowseDirectChildren</allowedValue>
      </allowedValueList>
    </stateVariable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_Filter</name>
      <dataType>string</dataType>
    </stateVariable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_SortCriteria</name>
      <dataType>string</dataType>
    </stateVariable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_Index</name>
      <dataType>ui4</dataType>
    </stateVariable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_Count</name>
      <dataType>ui4</dataType>
    </stateVariable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_UpdateID</name>
      <dataType>ui4</dataType>
    </stateVariable>
    <stateVariable sendEvents="yes">
      <name>SystemUpdateID</name>
      <dataType>ui4</dataType>
    </stateVariable>
  </serviceStateTable>
</scpd>`;

    res.writeHead(200, {
      'Content-Type': 'text/xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(xml)
    });
    res.end(xml);
  }

  sendConnectionManagerDescription(res) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion>
    <major>1</major>
    <minor>0</minor>
  </specVersion>
  <actionList>
    <action>
      <name>GetProtocolInfo</name>
      <argumentList>
        <argument>
          <name>Source</name>
          <direction>out</direction>
          <relatedStateVariable>SourceProtocolInfo</relatedStateVariable>
        </argument>
        <argument>
          <name>Sink</name>
          <direction>out</direction>
          <relatedStateVariable>SinkProtocolInfo</relatedStateVariable>
        </argument>
      </argumentList>
    </action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="yes">
      <name>SourceProtocolInfo</name>
      <dataType>string</dataType>
    </stateVariable>
    <stateVariable sendEvents="yes">
      <name>SinkProtocolInfo</name>
      <dataType>string</dataType>
    </stateVariable>
  </serviceStateTable>
</scpd>`;

    res.writeHead(200, {
      'Content-Type': 'text/xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(xml)
    });
    res.end(xml);
  }

  handleContentDirectoryControl(req, res) {
    let body = '';
    let bodySize = 0;
    const maxSize = 64 * 1024; // 64KB max for SOAP requests

    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > maxSize) {
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      try {
        if (body.includes('Browse')) {
          this.handleBrowse(body, res);
        } else if (body.includes('GetSystemUpdateID')) {
          this.handleGetSystemUpdateID(res);
        } else {
          res.writeHead(500);
          res.end('Unknown action');
        }
      } catch (err) {
        console.error('ContentDirectory control error:', err);
        res.writeHead(500);
        res.end('Internal error');
      }
    });

    req.on('error', () => {
      // Request aborted, nothing to do
    });
  }

  handleConnectionManagerControl(req, res) {
    let body = '';
    let bodySize = 0;
    const maxSize = 64 * 1024;

    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > maxSize) {
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      try {
        if (body.includes('GetProtocolInfo')) {
          const xml = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetProtocolInfoResponse xmlns:u="urn:schemas-upnp-org:service:ConnectionManager:1">
      <Source>http-get:*:video/mp4:*,http-get:*:video/mpeg:*,http-get:*:video/x-matroska:*,http-get:*:video/avi:*,http-get:*:video/webm:*,http-get:*:audio/mpeg:*,http-get:*:audio/mp4:*,http-get:*:audio/flac:*,http-get:*:audio/wav:*,http-get:*:image/jpeg:*,http-get:*:image/png:*,http-get:*:image/gif:*</Source>
      <Sink></Sink>
    </u:GetProtocolInfoResponse>
  </s:Body>
</s:Envelope>`;
          res.writeHead(200, {
            'Content-Type': 'text/xml; charset=utf-8',
            'Content-Length': Buffer.byteLength(xml)
          });
          res.end(xml);
        } else {
          res.writeHead(500);
          res.end('Unknown action');
        }
      } catch (err) {
        console.error('ConnectionManager control error:', err);
        res.writeHead(500);
        res.end('Internal error');
      }
    });

    req.on('error', () => {
      // Request aborted
    });
  }

  handleBrowse(body, res) {
    // Parse ObjectID from SOAP request
    const objectIdMatch = body.match(/<ObjectID>([^<]*)<\/ObjectID>/);
    const objectId = objectIdMatch ? objectIdMatch[1] : '0';

    const items = this.getMediaItems(objectId);
    const didl = this.buildDIDL(items, objectId);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <Result>${this.escapeXml(didl)}</Result>
      <NumberReturned>${items.length}</NumberReturned>
      <TotalMatches>${items.length}</TotalMatches>
      <UpdateID>${this.updateId}</UpdateID>
    </u:BrowseResponse>
  </s:Body>
</s:Envelope>`;

    res.writeHead(200, {
      'Content-Type': 'text/xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(xml)
    });
    res.end(xml);
  }

  handleGetSystemUpdateID(res) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetSystemUpdateIDResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <Id>${this.updateId}</Id>
    </u:GetSystemUpdateIDResponse>
  </s:Body>
</s:Envelope>`;

    res.writeHead(200, {
      'Content-Type': 'text/xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(xml)
    });
    res.end(xml);
  }

  // Safely decode object ID to path
  decodeObjectId(objectId) {
    if (objectId === '0') {
      return '';
    }

    try {
      const decoded = Buffer.from(objectId, 'base64').toString('utf8');

      // Security: check for path traversal
      if (decoded.includes('..') || decoded.startsWith('/') || decoded.includes('\0')) {
        return null;
      }

      // Verify the path exists and is within media dir
      const fullPath = path.join(this.mediaDir, decoded);
      const resolved = path.resolve(fullPath);

      if (!resolved.startsWith(this.mediaDir + path.sep) && resolved !== this.mediaDir) {
        return null;
      }

      return decoded;
    } catch {
      return null;
    }
  }

  getMediaItems(objectId) {
    const items = [];

    const relativePath = this.decodeObjectId(objectId);
    if (relativePath === null) {
      return items;
    }

    const dirPath = relativePath ? path.join(this.mediaDir, relativePath) : this.mediaDir;

    if (!fs.existsSync(dirPath)) {
      return items;
    }

    try {
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) {
        return items;
      }
    } catch {
      return items;
    }

    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return items;
    }

    for (const entry of entries) {
      // Skip hidden files
      if (entry.name.startsWith('.')) {
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);
      const itemRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;

      try {
        // Skip symlinks
        const lstat = fs.lstatSync(fullPath);
        if (lstat.isSymbolicLink()) {
          continue;
        }

        const id = Buffer.from(itemRelativePath).toString('base64');

        if (entry.isDirectory()) {
          items.push({
            id,
            parentId: objectId,
            title: entry.name,
            type: 'container'
          });
        } else {
          const mimeType = mime.lookup(entry.name) || 'application/octet-stream';
          if (this.isMediaFile(mimeType)) {
            items.push({
              id,
              parentId: objectId,
              title: entry.name,
              type: 'item',
              mimeType,
              size: lstat.size,
              path: itemRelativePath
            });
          }
        }
      } catch {
        // Skip files we can't access
        continue;
      }
    }

    // Sort: folders first, then alphabetically
    items.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'container' ? -1 : 1;
      }
      return a.title.localeCompare(b.title);
    });

    return items;
  }

  isMediaFile(mimeType) {
    return mimeType.startsWith('video/') ||
           mimeType.startsWith('audio/') ||
           mimeType.startsWith('image/');
  }

  buildDIDL(items, parentId) {
    let didl = '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">';

    for (const item of items) {
      if (item.type === 'container') {
        didl += `<container id="${this.escapeXml(item.id)}" parentID="${this.escapeXml(parentId)}" restricted="1">`;
        didl += `<dc:title>${this.escapeXml(item.title)}</dc:title>`;
        didl += `<upnp:class>object.container.storageFolder</upnp:class>`;
        didl += `</container>`;
      } else {
        const upnpClass = this.getUpnpClass(item.mimeType);
        // Encode path components individually for proper URL encoding
        const encodedPath = item.path.split('/').map(encodeURIComponent).join('/');
        didl += `<item id="${this.escapeXml(item.id)}" parentID="${this.escapeXml(parentId)}" restricted="1">`;
        didl += `<dc:title>${this.escapeXml(item.title)}</dc:title>`;
        didl += `<upnp:class>${upnpClass}</upnp:class>`;
        didl += `<res protocolInfo="http-get:*:${item.mimeType}:*" size="${item.size}">`;
        didl += `http://${this.localIP}:${this.httpPort}/media/${encodedPath}`;
        didl += `</res>`;
        didl += `</item>`;
      }
    }

    didl += '</DIDL-Lite>';
    return didl;
  }

  getUpnpClass(mimeType) {
    if (mimeType.startsWith('video/')) return 'object.item.videoItem';
    if (mimeType.startsWith('audio/')) return 'object.item.audioItem.musicTrack';
    if (mimeType.startsWith('image/')) return 'object.item.imageItem.photo';
    return 'object.item';
  }

  serveMediaFile(url, req, res) {
    // Decode URL path
    let relativePath;
    try {
      relativePath = decodeURIComponent(url.replace('/media/', ''));
    } catch {
      res.writeHead(400);
      res.end('Invalid URL');
      return;
    }

    // Security checks
    if (relativePath.includes('..') || relativePath.includes('\0') || relativePath.startsWith('/')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const filePath = path.join(this.mediaDir, relativePath);
    const resolved = path.resolve(filePath);

    // Ensure within media directory
    if (!resolved.startsWith(this.mediaDir + path.sep) && resolved !== this.mediaDir) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Check file exists and is not a symlink
    let stat;
    try {
      const lstat = fs.lstatSync(resolved);
      if (lstat.isSymbolicLink()) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        res.writeHead(400);
        res.end('Cannot serve directory');
        return;
      }
    } catch {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      // Parse and validate range request
      const rangeMatch = range.match(/bytes=(\d*)-(\d*)/);
      if (!rangeMatch) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end('Invalid range');
        return;
      }

      let start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0;
      let end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : stat.size - 1;

      // Validate range values
      if (isNaN(start) || isNaN(end) || start < 0 || end < start || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end('Range not satisfiable');
        return;
      }

      // Clamp end to file size
      if (end >= stat.size) {
        end = stat.size - 1;
      }

      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType
      });

      const stream = fs.createReadStream(resolved, { start, end });

      stream.on('error', (err) => {
        console.error('Stream error:', err);
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      });

      stream.pipe(res);

      res.on('close', () => {
        stream.destroy();
      });
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes'
      });

      const stream = fs.createReadStream(resolved);

      stream.on('error', (err) => {
        console.error('Stream error:', err);
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      });

      stream.pipe(res);

      res.on('close', () => {
        stream.destroy();
      });
    }
  }

  async startSSDP() {
    return new Promise((resolve, reject) => {
      this.ssdpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.ssdpSocket.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error('SSDP port 1900 already in use (another DLNA server running?)'));
        } else if (err.code === 'EACCES') {
          reject(new Error('Permission denied for SSDP port 1900 (try running as root or use a different port)'));
        } else {
          reject(err);
        }
      });

      this.ssdpSocket.on('message', (msg, rinfo) => {
        if (this.stopped) return;
        try {
          this.handleSSDPMessage(msg, rinfo);
        } catch (err) {
          console.error('SSDP message handling error:', err);
        }
      });

      this.ssdpSocket.bind(SSDP_PORT, () => {
        try {
          this.ssdpSocket.addMembership(SSDP_ADDRESS);
          this.ssdpSocket.setMulticastTTL(4);
          resolve();
        } catch (err) {
          this.ssdpSocket.close();
          reject(err);
        }
      });
    });
  }

  handleSSDPMessage(msg, rinfo) {
    const message = msg.toString();

    if (message.includes('M-SEARCH') && message.includes('ssdp:discover')) {
      // Check if searching for our device type
      if (message.includes('upnp:rootdevice') ||
          message.includes('ssdp:all') ||
          message.includes('MediaServer') ||
          message.includes('ContentDirectory')) {
        // Random delay to prevent network flooding
        setTimeout(() => {
          if (!this.stopped && this.ssdpSocket) {
            this.sendSSDPResponse(rinfo);
          }
        }, Math.random() * 100);
      }
    }
  }

  sendSSDPResponse(rinfo) {
    if (!this.ssdpSocket || this.stopped) return;

    const response = [
      'HTTP/1.1 200 OK',
      'CACHE-CONTROL: max-age=1800',
      `DATE: ${new Date().toUTCString()}`,
      'EXT:',
      `LOCATION: http://${this.localIP}:${this.httpPort}/description.xml`,
      'SERVER: Linux/1.0 UPnP/1.0 MediaServer/1.0',
      'ST: upnp:rootdevice',
      `USN: ${this.uuid}::upnp:rootdevice`,
      '',
      ''
    ].join('\r\n');

    const buf = Buffer.from(response);

    try {
      this.ssdpSocket.send(buf, 0, buf.length, rinfo.port, rinfo.address);
    } catch (err) {
      // Socket might be closed, ignore
    }
  }

  startPeriodicAnnounce() {
    // Announce presence immediately
    this.announcePresence();

    // Then announce every 5 minutes (less than half the max-age)
    this.announceInterval = setInterval(() => {
      if (!this.stopped) {
        // Update local IP in case network changed
        this.localIP = this.getLocalIP();
        this.announcePresence();
      }
    }, 5 * 60 * 1000);
  }

  announcePresence() {
    if (!this.ssdpSocket || this.stopped) return;

    const notify = [
      'NOTIFY * HTTP/1.1',
      `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
      'CACHE-CONTROL: max-age=1800',
      `LOCATION: http://${this.localIP}:${this.httpPort}/description.xml`,
      'NT: upnp:rootdevice',
      'NTS: ssdp:alive',
      'SERVER: Linux/1.0 UPnP/1.0 MediaServer/1.0',
      `USN: ${this.uuid}::upnp:rootdevice`,
      '',
      ''
    ].join('\r\n');

    const buf = Buffer.from(notify);

    // Send multiple times for reliability (UDP is unreliable)
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        if (this.ssdpSocket && !this.stopped) {
          try {
            this.ssdpSocket.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDRESS);
          } catch {
            // Ignore send errors
          }
        }
      }, i * 100);
    }
  }

  sendByebye() {
    if (!this.ssdpSocket) return;

    const notify = [
      'NOTIFY * HTTP/1.1',
      `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
      'NT: upnp:rootdevice',
      'NTS: ssdp:byebye',
      `USN: ${this.uuid}::upnp:rootdevice`,
      '',
      ''
    ].join('\r\n');

    const buf = Buffer.from(notify);

    try {
      this.ssdpSocket.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDRESS);
    } catch {
      // Ignore
    }
  }

  escapeXml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

module.exports = DLNAServer;
