const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

module.exports = function(mediaDir) {
  const router = express.Router();

  // Configure multer for file uploads
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadPath = req.body.path || '';
      const fullPath = path.join(mediaDir, uploadPath);

      // Ensure directory exists
      if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
      }

      cb(null, fullPath);
    },
    filename: (req, file, cb) => {
      // Sanitize filename
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, safeName);
    }
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: 5 * 1024 * 1024 * 1024 // 5GB limit
    }
  });

  // List files and folders in a directory
  router.get('/list', (req, res) => {
    try {
      const relativePath = req.query.path || '';
      const fullPath = path.join(mediaDir, relativePath);

      // Security: ensure we're within mediaDir
      if (!fullPath.startsWith(mediaDir)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      if (!fs.existsSync(fullPath)) {
        return res.json({ items: [], path: relativePath });
      }

      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      const items = entries.map(entry => {
        const itemPath = path.join(fullPath, entry.name);
        const stat = fs.statSync(itemPath);

        return {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          size: entry.isDirectory() ? null : stat.size,
          modified: stat.mtime,
          path: path.join(relativePath, entry.name)
        };
      });

      // Sort: folders first, then files, alphabetically
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      res.json({ items, path: relativePath });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create a new folder
  router.post('/folder', (req, res) => {
    try {
      const { path: relativePath, name } = req.body;

      if (!name || name.includes('/') || name.includes('\\')) {
        return res.status(400).json({ error: 'Invalid folder name' });
      }

      const fullPath = path.join(mediaDir, relativePath || '', name);

      // Security check
      if (!fullPath.startsWith(mediaDir)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      if (fs.existsSync(fullPath)) {
        return res.status(400).json({ error: 'Folder already exists' });
      }

      fs.mkdirSync(fullPath, { recursive: true });
      res.json({ success: true, path: path.join(relativePath || '', name) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Upload files
  router.post('/upload', upload.array('files', 50), (req, res) => {
    try {
      const uploaded = req.files.map(f => ({
        name: f.filename,
        size: f.size,
        path: path.join(req.body.path || '', f.filename)
      }));
      res.json({ success: true, files: uploaded });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Rename a file or folder
  router.post('/rename', (req, res) => {
    try {
      const { path: itemPath, newName } = req.body;

      if (!newName || newName.includes('/') || newName.includes('\\')) {
        return res.status(400).json({ error: 'Invalid name' });
      }

      const oldFullPath = path.join(mediaDir, itemPath);
      const newFullPath = path.join(path.dirname(oldFullPath), newName);

      // Security check
      if (!oldFullPath.startsWith(mediaDir) || !newFullPath.startsWith(mediaDir)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      if (!fs.existsSync(oldFullPath)) {
        return res.status(404).json({ error: 'Item not found' });
      }

      if (fs.existsSync(newFullPath)) {
        return res.status(400).json({ error: 'An item with that name already exists' });
      }

      fs.renameSync(oldFullPath, newFullPath);
      res.json({ success: true, newPath: path.join(path.dirname(itemPath), newName) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Move files/folders
  router.post('/move', (req, res) => {
    try {
      const { items, destination } = req.body;

      const destFullPath = path.join(mediaDir, destination || '');

      // Security check
      if (!destFullPath.startsWith(mediaDir)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      if (!fs.existsSync(destFullPath)) {
        fs.mkdirSync(destFullPath, { recursive: true });
      }

      const moved = [];
      for (const itemPath of items) {
        const srcFullPath = path.join(mediaDir, itemPath);

        if (!srcFullPath.startsWith(mediaDir)) {
          continue;
        }

        if (!fs.existsSync(srcFullPath)) {
          continue;
        }

        const itemName = path.basename(itemPath);
        const newFullPath = path.join(destFullPath, itemName);

        // Don't move into self
        if (newFullPath.startsWith(srcFullPath + path.sep)) {
          continue;
        }

        fs.renameSync(srcFullPath, newFullPath);
        moved.push({ from: itemPath, to: path.join(destination || '', itemName) });
      }

      res.json({ success: true, moved });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete files/folders
  router.post('/delete', (req, res) => {
    try {
      const { items } = req.body;

      const deleted = [];
      for (const itemPath of items) {
        const fullPath = path.join(mediaDir, itemPath);

        // Security check
        if (!fullPath.startsWith(mediaDir) || fullPath === mediaDir) {
          continue;
        }

        if (!fs.existsSync(fullPath)) {
          continue;
        }

        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true });
        } else {
          fs.unlinkSync(fullPath);
        }
        deleted.push(itemPath);
      }

      res.json({ success: true, deleted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
