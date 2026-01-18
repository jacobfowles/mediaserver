const dgram = require('dgram');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;

class DLNAServer {
  constructor(options = {}) {
    this.name = options.name || 'Media Server';
    this.mediaDir = options.mediaDir || './media';
    this.httpPort = options.httpPort || 8200;
    this.webPort = options.webPort || 3000;
    this.uuid = `uuid:${uuidv4()}`;
    this.ssdpSocket = null;
    this.httpServer = null;
    this.localIP = this.getLocalIP();
  }

  getLocalIP() {
    const interfaces = os.networkInterfaces();
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
    await this.startHTTPServer();
    await this.startSSDP();
    this.startPeriodicAnnounce();
  }

  stop() {
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
    }
    if (this.ssdpSocket) {
      this.ssdpSocket.close();
    }
    if (this.httpServer) {
      this.httpServer.close();
    }
  }

  async startHTTPServer() {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        this.handleHTTPRequest(req, res);
      });

      this.httpServer.listen(this.httpPort, '0.0.0.0', () => {
        resolve();
      });

      this.httpServer.on('error', reject);
    });
  }

  handleHTTPRequest(req, res) {
    const url = req.url;

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
    } else if (url.startsWith('/media/')) {
      this.serveMediaFile(url, req, res);
    } else {
      res.writeHead(404);
      res.end('Not Found');
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
    <manufacturer>Lobby Media Server</manufacturer>
    <modelName>Simple DLNA Server</modelName>
    <modelNumber>1.0</modelNumber>
    <UDN>${this.uuid}</UDN>
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
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (body.includes('Browse')) {
        this.handleBrowse(body, res);
      } else if (body.includes('GetSystemUpdateID')) {
        this.handleGetSystemUpdateID(res);
      } else {
        res.writeHead(500);
        res.end('Unknown action');
      }
    });
  }

  handleConnectionManagerControl(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (body.includes('GetProtocolInfo')) {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetProtocolInfoResponse xmlns:u="urn:schemas-upnp-org:service:ConnectionManager:1">
      <Source>http-get:*:video/mp4:*,http-get:*:video/mpeg:*,http-get:*:video/x-matroska:*,http-get:*:video/avi:*,http-get:*:audio/mpeg:*,http-get:*:audio/mp4:*,http-get:*:image/jpeg:*,http-get:*:image/png:*</Source>
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
      <UpdateID>1</UpdateID>
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
      <Id>1</Id>
    </u:GetSystemUpdateIDResponse>
  </s:Body>
</s:Envelope>`;

    res.writeHead(200, {
      'Content-Type': 'text/xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(xml)
    });
    res.end(xml);
  }

  getMediaItems(objectId) {
    const items = [];
    let dirPath = this.mediaDir;

    if (objectId !== '0') {
      // Decode the object ID to get the relative path
      dirPath = path.join(this.mediaDir, Buffer.from(objectId, 'base64').toString('utf8'));
    }

    if (!fs.existsSync(dirPath)) {
      return items;
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(this.mediaDir, fullPath);
      const id = Buffer.from(relativePath).toString('base64');

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
          const stat = fs.statSync(fullPath);
          items.push({
            id,
            parentId: objectId,
            title: entry.name,
            type: 'item',
            mimeType,
            size: stat.size,
            path: relativePath
          });
        }
      }
    }

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
        didl += `<container id="${item.id}" parentID="${parentId}" restricted="1">`;
        didl += `<dc:title>${this.escapeXml(item.title)}</dc:title>`;
        didl += `<upnp:class>object.container.storageFolder</upnp:class>`;
        didl += `</container>`;
      } else {
        const upnpClass = this.getUpnpClass(item.mimeType);
        didl += `<item id="${item.id}" parentID="${parentId}" restricted="1">`;
        didl += `<dc:title>${this.escapeXml(item.title)}</dc:title>`;
        didl += `<upnp:class>${upnpClass}</upnp:class>`;
        didl += `<res protocolInfo="http-get:*:${item.mimeType}:*" size="${item.size}">`;
        didl += `http://${this.localIP}:${this.httpPort}/media/${encodeURIComponent(item.path)}`;
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
    const filePath = path.join(this.mediaDir, decodeURIComponent(url.replace('/media/', '')));

    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const stat = fs.statSync(filePath);
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      // Support range requests for video seeking
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType
      });

      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes'
      });

      fs.createReadStream(filePath).pipe(res);
    }
  }

  async startSSDP() {
    return new Promise((resolve, reject) => {
      this.ssdpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.ssdpSocket.on('error', (err) => {
        console.error('SSDP error:', err);
        reject(err);
      });

      this.ssdpSocket.on('message', (msg, rinfo) => {
        this.handleSSDPMessage(msg, rinfo);
      });

      this.ssdpSocket.bind(SSDP_PORT, () => {
        this.ssdpSocket.addMembership(SSDP_ADDRESS);
        this.ssdpSocket.setMulticastTTL(4);
        resolve();
      });
    });
  }

  handleSSDPMessage(msg, rinfo) {
    const message = msg.toString();

    if (message.includes('M-SEARCH') && message.includes('ssdp:discover')) {
      // Check if searching for our device type
      if (message.includes('upnp:rootdevice') ||
          message.includes('ssdp:all') ||
          message.includes('MediaServer')) {
        setTimeout(() => {
          this.sendSSDPResponse(rinfo);
        }, Math.random() * 100);
      }
    }
  }

  sendSSDPResponse(rinfo) {
    const response = [
      'HTTP/1.1 200 OK',
      `CACHE-CONTROL: max-age=1800`,
      `DATE: ${new Date().toUTCString()}`,
      `EXT:`,
      `LOCATION: http://${this.localIP}:${this.httpPort}/description.xml`,
      `SERVER: Linux/1.0 UPnP/1.0 MediaServer/1.0`,
      `ST: upnp:rootdevice`,
      `USN: ${this.uuid}::upnp:rootdevice`,
      '',
      ''
    ].join('\r\n');

    const buf = Buffer.from(response);
    this.ssdpSocket.send(buf, 0, buf.length, rinfo.port, rinfo.address);
  }

  startPeriodicAnnounce() {
    // Announce presence immediately
    this.announcePresence();

    // Then announce every 5 minutes
    this.announceInterval = setInterval(() => {
      this.announcePresence();
    }, 5 * 60 * 1000);
  }

  announcePresence() {
    const notify = [
      'NOTIFY * HTTP/1.1',
      `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
      `CACHE-CONTROL: max-age=1800`,
      `LOCATION: http://${this.localIP}:${this.httpPort}/description.xml`,
      `NT: upnp:rootdevice`,
      `NTS: ssdp:alive`,
      `SERVER: Linux/1.0 UPnP/1.0 MediaServer/1.0`,
      `USN: ${this.uuid}::upnp:rootdevice`,
      '',
      ''
    ].join('\r\n');

    const buf = Buffer.from(notify);

    // Send a few times for reliability
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        if (this.ssdpSocket) {
          this.ssdpSocket.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDRESS);
        }
      }, i * 100);
    }
  }

  escapeXml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

module.exports = DLNAServer;
