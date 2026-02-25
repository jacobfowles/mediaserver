const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fileRoutes = require('./src/routes/files');
const DLNAServer = require('./src/dlna/server');

// Configuration with sensible defaults
const PORT = parseInt(process.env.PORT, 10) || 3000;
const DLNA_PORT = parseInt(process.env.DLNA_PORT, 10) || 8200;
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || path.join(__dirname, 'media'));

// Validate ports
if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error('Invalid PORT. Must be between 1 and 65535.');
  process.exit(1);
}
if (isNaN(DLNA_PORT) || DLNA_PORT < 1 || DLNA_PORT > 65535) {
  console.error('Invalid DLNA_PORT. Must be between 1 and 65535.');
  process.exit(1);
}

// Ensure media directory exists
try {
  if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    console.log(`Created media directory: ${MEDIA_DIR}`);
  }
} catch (err) {
  console.error(`Failed to create media directory: ${err.message}`);
  process.exit(1);
}

const app = express();

// Security and reliability middleware
app.disable('x-powered-by');

// JSON body parser with size limit
app.use(express.json({ limit: '1mb' }));

// Cookie-based auth for web interface (not DLNA)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'velocitychurch1!';
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

function makeSessionToken() {
  const expires = Date.now() + COOKIE_MAX_AGE;
  const payload = `${expires}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifySessionToken(token) {
  if (!token) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  if (sig !== expected) return false;
  const expires = parseInt(payload, 10);
  return Date.now() < expires;
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  return cookies;
}

// Login endpoint
app.post('/api/login', (req, res) => {
  if (req.body && req.body.password === ADMIN_PASSWORD) {
    const token = makeSessionToken();
    res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE / 1000}`);
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Incorrect password' });
  }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

// Auth middleware
app.use((req, res, next) => {
  // Skip auth for DLNA media serving, health check, and login page
  if (req.url.startsWith('/media/') || req.url === '/api/health' || req.url === '/login.html') {
    return next();
  }
  const cookies = parseCookies(req.headers.cookie);
  if (verifySessionToken(cookies.session)) {
    return next();
  }
  // Serve login page for browser requests, 401 for API
  if (req.url.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Serve media files with proper headers
app.use('/media', express.static(MEDIA_DIR, {
  maxAge: '1h',
  etag: true,
  lastModified: true
}));

// File management API
app.use('/api/files', fileRoutes(MEDIA_DIR));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    mediaDir: MEDIA_DIR
  });
});

// Global error handler for Express
app.use((err, req, res, next) => {
  console.error('Express error:', err);

  // Don't expose internal errors to client
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Handle 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Track server and DLNA for cleanup
let server = null;
let dlnaServer = null;
let isShuttingDown = false;

// Graceful shutdown function
function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n${signal} received. Shutting down gracefully...`);

  // Stop accepting new connections
  if (server) {
    server.close(() => {
      console.log('HTTP server closed');
    });
  }

  // Stop DLNA server
  if (dlnaServer) {
    dlnaServer.stop();
    console.log('DLNA server stopped');
  }

  // Force exit after timeout
  setTimeout(() => {
    console.log('Forcing exit...');
    process.exit(0);
  }, 5000);
}

// Start the server
function start() {
  return new Promise((resolve, reject) => {
    server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n========================================`);
      console.log(`  Media Server Started`);
      console.log(`========================================`);
      console.log(`  Web Interface: http://localhost:${PORT}`);
      console.log(`  Media Directory: ${MEDIA_DIR}`);
      console.log(`========================================\n`);
      resolve();
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${PORT} is already in use`));
      } else if (err.code === 'EACCES') {
        reject(new Error(`Permission denied for port ${PORT}`));
      } else {
        reject(err);
      }
    });

    // Set timeouts to prevent hanging connections
    server.timeout = 300000; // 5 minutes for large uploads
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
  });
}

// Main startup
async function main() {
  try {
    // Start Express server
    await start();

    // Start DLNA server
    dlnaServer = new DLNAServer({
      name: 'Lobby Media Server',
      mediaDir: MEDIA_DIR,
      httpPort: DLNA_PORT,
      webPort: PORT
    });

    try {
      await dlnaServer.start();
      console.log(`  DLNA Server running on port ${DLNA_PORT}`);
      console.log(`  Your TVs should discover: "Lobby Media Server"`);
      console.log(`========================================\n`);
    } catch (err) {
      console.warn(`  DLNA auto-discovery disabled: ${err.message}`);
      console.warn(`  (Web interface still works at http://localhost:${PORT})`);
      console.log(`========================================\n`);
    }

  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

// Signal handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  // Don't exit - try to keep running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  // Don't exit - try to keep running
});

// Start the application
main();
