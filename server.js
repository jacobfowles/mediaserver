const express = require('express');
const path = require('path');
const fs = require('fs');
const fileRoutes = require('./src/routes/files');
const DLNAServer = require('./src/dlna/server');

const app = express();
const PORT = process.env.PORT || 3000;
const DLNA_PORT = process.env.DLNA_PORT || 8200;
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'media');

// Ensure media directory exists
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  console.log(`Created media directory: ${MEDIA_DIR}`);
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve media files
app.use('/media', express.static(MEDIA_DIR));

// File management API
app.use('/api/files', fileRoutes(MEDIA_DIR));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', mediaDir: MEDIA_DIR });
});

// Start HTTP server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`  Media Server Started`);
  console.log(`========================================`);
  console.log(`  Web Interface: http://localhost:${PORT}`);
  console.log(`  Media Directory: ${MEDIA_DIR}`);
  console.log(`========================================\n`);
});

// Start DLNA server
const dlnaServer = new DLNAServer({
  name: 'Lobby Media Server',
  mediaDir: MEDIA_DIR,
  httpPort: DLNA_PORT,
  webPort: PORT
});

dlnaServer.start().then(() => {
  console.log(`  DLNA Server running on port ${DLNA_PORT}`);
  console.log(`  Your TVs should discover: "Lobby Media Server"`);
  console.log(`========================================\n`);
}).catch(err => {
  console.error('Failed to start DLNA server:', err.message);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  dlnaServer.stop();
  server.close(() => {
    console.log('Server stopped');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  dlnaServer.stop();
  server.close(() => {
    console.log('Server stopped');
    process.exit(0);
  });
});
