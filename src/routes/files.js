const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Safely resolve and validate a path is within the media directory
function safePath(mediaDir, relativePath) {
  const resolved = path.resolve(mediaDir, relativePath || '');
  const normalizedMediaDir = path.resolve(mediaDir);

  // Ensure the resolved path starts with mediaDir + separator (or is exactly mediaDir)
  if (resolved !== normalizedMediaDir && !resolved.startsWith(normalizedMediaDir + path.sep)) {
    return null;
  }

  // Check for symlinks that might escape
  try {
    const realPath = fs.realpathSync(resolved);
    const realMediaDir = fs.realpathSync(normalizedMediaDir);
    if (realPath !== realMediaDir && !realPath.startsWith(realMediaDir + path.sep)) {
      return null;
    }
  } catch {
    // Path doesn't exist yet, that's okay for some operations
    // But we still need to check the parent exists and is safe
    const parentDir = path.dirname(resolved);
    if (fs.existsSync(parentDir)) {
      try {
        const realParent = fs.realpathSync(parentDir);
        const realMediaDir = fs.realpathSync(normalizedMediaDir);
        if (realParent !== realMediaDir && !realParent.startsWith(realMediaDir + path.sep)) {
          return null;
        }
      } catch {
        return null;
      }
    }
  }

  return resolved;
}

// Generate unique filename if file exists
function uniqueFilename(dir, filename) {
  let filePath = path.join(dir, filename);

  if (!fs.existsSync(filePath)) {
    return filename;
  }

  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let counter = 1;

  while (fs.existsSync(filePath)) {
    const newName = `${base} (${counter})${ext}`;
    filePath = path.join(dir, newName);
    counter++;

    // Safety limit
    if (counter > 1000) {
      return `${base}_${Date.now()}${ext}`;
    }
  }

  return path.basename(filePath);
}

module.exports = function(mediaDir) {
  const router = express.Router();
  const normalizedMediaDir = path.resolve(mediaDir);

  // Configure multer for file uploads
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      // Note: req.body may not be fully populated yet for multipart
      // We'll use a temp location and move later, or parse path from fields
      cb(null, normalizedMediaDir);
    },
    filename: (req, file, cb) => {
      // Sanitize filename - allow unicode but remove dangerous chars
      let safeName = file.originalname
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') // Remove Windows-illegal chars
        .replace(/^\.+/, '_') // Don't start with dots
        .trim();

      if (!safeName || safeName === '') {
        safeName = 'unnamed_file';
      }

      // Truncate if too long
      if (safeName.length > 200) {
        const ext = path.extname(safeName);
        safeName = safeName.substring(0, 200 - ext.length) + ext;
      }

      cb(null, safeName);
    }
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: 5 * 1024 * 1024 * 1024, // 5GB limit
      files: 50
    }
  });

  // List files and folders in a directory
  router.get('/list', (req, res) => {
    try {
      const relativePath = req.query.path || '';
      const fullPath = safePath(normalizedMediaDir, relativePath);

      if (!fullPath) {
        return res.status(403).json({ error: 'Access denied' });
      }

      if (!fs.existsSync(fullPath)) {
        return res.json({ items: [], path: relativePath });
      }

      // Ensure it's a directory
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'Not a directory' });
      }

      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      const items = [];

      for (const entry of entries) {
        // Skip hidden files
        if (entry.name.startsWith('.')) {
          continue;
        }

        const itemPath = path.join(fullPath, entry.name);

        // Skip symlinks for security
        try {
          const itemStat = fs.lstatSync(itemPath);
          if (itemStat.isSymbolicLink()) {
            continue;
          }

          items.push({
            name: entry.name,
            isDirectory: entry.isDirectory(),
            size: entry.isDirectory() ? null : itemStat.size,
            modified: itemStat.mtime,
            path: path.join(relativePath, entry.name)
          });
        } catch {
          // Skip files we can't stat
          continue;
        }
      }

      // Sort: folders first, then files, alphabetically
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      res.json({ items, path: relativePath });
    } catch (err) {
      console.error('List error:', err);
      res.status(500).json({ error: 'Failed to list directory' });
    }
  });

  // Create a new folder
  router.post('/folder', (req, res) => {
    try {
      const { path: relativePath, name } = req.body;

      if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'Invalid folder name' });
      }

      // Sanitize folder name
      const safeName = name
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/^\.+/, '_')
        .trim();

      if (!safeName || safeName.length > 200) {
        return res.status(400).json({ error: 'Invalid folder name' });
      }

      const parentPath = safePath(normalizedMediaDir, relativePath || '');
      if (!parentPath) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const fullPath = path.join(parentPath, safeName);

      // Verify the new path is still within bounds
      if (!fullPath.startsWith(normalizedMediaDir + path.sep) && fullPath !== normalizedMediaDir) {
        return res.status(403).json({ error: 'Access denied' });
      }

      if (fs.existsSync(fullPath)) {
        return res.status(400).json({ error: 'Folder already exists' });
      }

      fs.mkdirSync(fullPath, { recursive: true });
      res.json({ success: true, path: path.join(relativePath || '', safeName) });
    } catch (err) {
      console.error('Create folder error:', err);
      res.status(500).json({ error: 'Failed to create folder' });
    }
  });

  // Upload files
  router.post('/upload', upload.array('files', 50), (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const destPath = req.body.path || '';
      const destFullPath = safePath(normalizedMediaDir, destPath);

      if (!destFullPath) {
        // Clean up uploaded files
        req.files.forEach(f => {
          try { fs.unlinkSync(f.path); } catch {}
        });
        return res.status(403).json({ error: 'Access denied' });
      }

      // Ensure destination exists
      if (!fs.existsSync(destFullPath)) {
        fs.mkdirSync(destFullPath, { recursive: true });
      }

      const uploaded = [];

      for (const file of req.files) {
        try {
          const finalName = uniqueFilename(destFullPath, file.filename);
          const finalPath = path.join(destFullPath, finalName);

          // Move file if destination is different from temp location
          if (file.path !== finalPath) {
            fs.renameSync(file.path, finalPath);
          }

          uploaded.push({
            name: finalName,
            size: file.size,
            path: path.join(destPath, finalName)
          });
        } catch (err) {
          console.error('Error moving uploaded file:', err);
          // Try to clean up
          try { fs.unlinkSync(file.path); } catch {}
        }
      }

      res.json({ success: true, files: uploaded });
    } catch (err) {
      console.error('Upload error:', err);
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  // Rename a file or folder
  router.post('/rename', (req, res) => {
    try {
      const { path: itemPath, newName } = req.body;

      if (!itemPath || typeof itemPath !== 'string') {
        return res.status(400).json({ error: 'Invalid path' });
      }

      if (!newName || typeof newName !== 'string') {
        return res.status(400).json({ error: 'Invalid name' });
      }

      // Sanitize new name
      const safeName = newName
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/^\.+/, '_')
        .trim();

      if (!safeName || safeName.length > 200) {
        return res.status(400).json({ error: 'Invalid name' });
      }

      const oldFullPath = safePath(normalizedMediaDir, itemPath);
      if (!oldFullPath) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const newFullPath = path.join(path.dirname(oldFullPath), safeName);

      // Verify new path is still within bounds
      if (!newFullPath.startsWith(normalizedMediaDir + path.sep)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      if (!fs.existsSync(oldFullPath)) {
        return res.status(404).json({ error: 'Item not found' });
      }

      // Check it's not a symlink
      if (fs.lstatSync(oldFullPath).isSymbolicLink()) {
        return res.status(403).json({ error: 'Cannot rename symlinks' });
      }

      if (fs.existsSync(newFullPath)) {
        return res.status(400).json({ error: 'An item with that name already exists' });
      }

      fs.renameSync(oldFullPath, newFullPath);

      const relativePath = path.relative(normalizedMediaDir, newFullPath);
      res.json({ success: true, newPath: relativePath });
    } catch (err) {
      console.error('Rename error:', err);
      res.status(500).json({ error: 'Failed to rename' });
    }
  });

  // Move files/folders
  router.post('/move', (req, res) => {
    try {
      const { items, destination } = req.body;

      if (!Array.isArray(items)) {
        return res.status(400).json({ error: 'Invalid items' });
      }

      const destFullPath = safePath(normalizedMediaDir, destination || '');
      if (!destFullPath) {
        return res.status(403).json({ error: 'Access denied' });
      }

      if (!fs.existsSync(destFullPath)) {
        fs.mkdirSync(destFullPath, { recursive: true });
      }

      if (!fs.statSync(destFullPath).isDirectory()) {
        return res.status(400).json({ error: 'Destination is not a directory' });
      }

      const moved = [];
      const errors = [];

      for (const itemPath of items) {
        if (typeof itemPath !== 'string') continue;

        const srcFullPath = safePath(normalizedMediaDir, itemPath);
        if (!srcFullPath) {
          errors.push({ path: itemPath, error: 'Access denied' });
          continue;
        }

        if (!fs.existsSync(srcFullPath)) {
          errors.push({ path: itemPath, error: 'Not found' });
          continue;
        }

        // Check it's not a symlink
        if (fs.lstatSync(srcFullPath).isSymbolicLink()) {
          errors.push({ path: itemPath, error: 'Cannot move symlinks' });
          continue;
        }

        const itemName = path.basename(srcFullPath);
        const newFullPath = path.join(destFullPath, itemName);

        // Don't move into self
        if (newFullPath === srcFullPath || newFullPath.startsWith(srcFullPath + path.sep)) {
          errors.push({ path: itemPath, error: 'Cannot move into itself' });
          continue;
        }

        try {
          // Handle name collision
          const finalName = uniqueFilename(destFullPath, itemName);
          const finalPath = path.join(destFullPath, finalName);

          fs.renameSync(srcFullPath, finalPath);
          moved.push({
            from: itemPath,
            to: path.relative(normalizedMediaDir, finalPath)
          });
        } catch (err) {
          errors.push({ path: itemPath, error: err.message });
        }
      }

      res.json({ success: true, moved, errors: errors.length > 0 ? errors : undefined });
    } catch (err) {
      console.error('Move error:', err);
      res.status(500).json({ error: 'Move failed' });
    }
  });

  // Copy files/folders
  router.post('/copy', (req, res) => {
    try {
      const { items, destination } = req.body;

      if (!Array.isArray(items)) {
        return res.status(400).json({ error: 'Invalid items' });
      }

      const destFullPath = safePath(normalizedMediaDir, destination || '');
      if (!destFullPath) {
        return res.status(403).json({ error: 'Access denied' });
      }

      if (!fs.existsSync(destFullPath)) {
        fs.mkdirSync(destFullPath, { recursive: true });
      }

      if (!fs.statSync(destFullPath).isDirectory()) {
        return res.status(400).json({ error: 'Destination is not a directory' });
      }

      const copied = [];
      const errors = [];

      for (const itemPath of items) {
        if (typeof itemPath !== 'string') continue;

        const srcFullPath = safePath(normalizedMediaDir, itemPath);
        if (!srcFullPath) {
          errors.push({ path: itemPath, error: 'Access denied' });
          continue;
        }

        if (!fs.existsSync(srcFullPath)) {
          errors.push({ path: itemPath, error: 'Not found' });
          continue;
        }

        // Check it's not a symlink
        if (fs.lstatSync(srcFullPath).isSymbolicLink()) {
          errors.push({ path: itemPath, error: 'Cannot copy symlinks' });
          continue;
        }

        const itemName = path.basename(srcFullPath);

        try {
          const finalName = uniqueFilename(destFullPath, itemName);
          const finalPath = path.join(destFullPath, finalName);

          // Copy file or directory
          if (fs.statSync(srcFullPath).isDirectory()) {
            fs.cpSync(srcFullPath, finalPath, { recursive: true });
          } else {
            fs.copyFileSync(srcFullPath, finalPath);
          }

          copied.push({
            from: itemPath,
            to: path.relative(normalizedMediaDir, finalPath)
          });
        } catch (err) {
          errors.push({ path: itemPath, error: err.message });
        }
      }

      res.json({ success: true, copied, errors: errors.length > 0 ? errors : undefined });
    } catch (err) {
      console.error('Copy error:', err);
      res.status(500).json({ error: 'Copy failed' });
    }
  });

  // Delete files/folders
  router.post('/delete', (req, res) => {
    try {
      const { items } = req.body;

      if (!Array.isArray(items)) {
        return res.status(400).json({ error: 'Invalid items' });
      }

      const deleted = [];
      const errors = [];

      for (const itemPath of items) {
        if (typeof itemPath !== 'string') continue;

        const fullPath = safePath(normalizedMediaDir, itemPath);
        if (!fullPath) {
          errors.push({ path: itemPath, error: 'Access denied' });
          continue;
        }

        // Prevent deleting the media directory itself
        if (fullPath === normalizedMediaDir) {
          errors.push({ path: itemPath, error: 'Cannot delete root directory' });
          continue;
        }

        if (!fs.existsSync(fullPath)) {
          // Already gone, consider it deleted
          deleted.push(itemPath);
          continue;
        }

        // Check it's not a symlink
        if (fs.lstatSync(fullPath).isSymbolicLink()) {
          errors.push({ path: itemPath, error: 'Cannot delete symlinks' });
          continue;
        }

        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true });
          } else {
            fs.unlinkSync(fullPath);
          }
          deleted.push(itemPath);
        } catch (err) {
          errors.push({ path: itemPath, error: err.message });
        }
      }

      res.json({ success: true, deleted, errors: errors.length > 0 ? errors : undefined });
    } catch (err) {
      console.error('Delete error:', err);
      res.status(500).json({ error: 'Delete failed' });
    }
  });

  return router;
};
