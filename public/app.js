// State
let currentPath = '';
let files = [];
let selectedItems = new Set();
let clipboard = { items: [], operation: null };
let history = { back: [], forward: [] };

// Elements
const fileList = document.getElementById('file-list');
const addressInput = document.getElementById('address');
const statusText = document.getElementById('status-text');
const selectionCount = document.getElementById('selection-count');
const contextMenu = document.getElementById('context-menu');

// Icons
const ICONS = {
  folder: `<svg viewBox="0 0 48 48"><path fill="currentColor" d="M4 8h16l4 4h20v28H4V8z"/><path fill="rgba(0,0,0,0.1)" d="M4 12h40v4H4z"/></svg>`,
  video: `<svg viewBox="0 0 48 48"><rect fill="currentColor" x="4" y="8" width="40" height="32" rx="2"/><path fill="#fff" d="M18 16v16l14-8z"/></svg>`,
  audio: `<svg viewBox="0 0 48 48"><circle fill="currentColor" cx="24" cy="24" r="20"/><circle fill="#fff" cx="24" cy="24" r="8"/><circle fill="currentColor" cx="24" cy="24" r="3"/></svg>`,
  image: `<svg viewBox="0 0 48 48"><rect fill="currentColor" x="4" y="8" width="40" height="32" rx="2"/><circle fill="#fff" cx="16" cy="20" r="4"/><path fill="#fff" d="M4 36l12-12 8 8 10-10 10 10v4H4z"/></svg>`,
  file: `<svg viewBox="0 0 48 48"><path fill="currentColor" d="M8 4h20l12 12v28H8V4z"/><path fill="rgba(255,255,255,0.3)" d="M28 4v12h12z"/></svg>`
};

// Initialize
document.addEventListener('DOMContentLoaded', init);

function init() {
  loadFiles('');
  setupEventListeners();
}

function setupEventListeners() {
  // Navigation
  document.getElementById('btn-back').addEventListener('click', goBack);
  document.getElementById('btn-forward').addEventListener('click', goForward);
  document.getElementById('btn-up').addEventListener('click', goUp);
  document.getElementById('btn-refresh').addEventListener('click', refresh);

  // Actions
  document.getElementById('btn-new-folder').addEventListener('click', showNewFolderDialog);
  document.getElementById('file-input').addEventListener('change', handleFileSelect);
  document.getElementById('btn-delete').addEventListener('click', showDeleteDialog);

  // File list interactions
  fileList.addEventListener('click', handleFileListClick);
  fileList.addEventListener('dblclick', handleFileListDblClick);
  fileList.addEventListener('contextmenu', handleContextMenu);

  // Context menu
  contextMenu.addEventListener('click', handleContextMenuAction);
  document.addEventListener('click', () => contextMenu.classList.remove('visible'));

  // Keyboard
  document.addEventListener('keydown', handleKeyDown);

  // Drag and drop
  setupDragDrop();

  // Dialogs
  setupDialogs();
}

async function loadFiles(path) {
  try {
    statusText.textContent = 'Loading...';
    const response = await fetch(`/api/files/list?path=${encodeURIComponent(path)}`);
    const data = await response.json();

    files = data.items;
    currentPath = data.path;
    selectedItems.clear();

    renderFiles();
    updateUI();
    statusText.textContent = `${files.length} item${files.length !== 1 ? 's' : ''}`;
  } catch (err) {
    statusText.textContent = 'Error loading files';
    console.error(err);
  }
}

function renderFiles() {
  if (files.length === 0) {
    fileList.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 48 48"><path fill="currentColor" d="M4 8h16l4 4h20v28H4V8z"/></svg>
        <p>This folder is empty</p>
        <p style="font-size: 12px; margin-top: 8px;">Drop files here or use the Upload button</p>
      </div>
    `;
    return;
  }

  fileList.innerHTML = files.map(file => {
    const iconType = getIconType(file);
    const isSelected = selectedItems.has(file.path);
    const isCut = clipboard.operation === 'cut' && clipboard.items.includes(file.path);

    return `
      <div class="file-item ${isSelected ? 'selected' : ''} ${isCut ? 'cut' : ''}"
           data-path="${escapeHtml(file.path)}"
           data-is-dir="${file.isDirectory}">
        <div class="file-icon ${iconType}">${ICONS[iconType]}</div>
        <div class="file-name">${escapeHtml(file.name)}</div>
      </div>
    `;
  }).join('');
}

function getIconType(file) {
  if (file.isDirectory) return 'folder';

  const ext = file.name.split('.').pop().toLowerCase();

  const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v'];
  const audioExts = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'];
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'];

  if (videoExts.includes(ext)) return 'video';
  if (audioExts.includes(ext)) return 'audio';
  if (imageExts.includes(ext)) return 'image';

  return 'file';
}

function updateUI() {
  // Address bar
  addressInput.value = '/' + currentPath;

  // Navigation buttons
  document.getElementById('btn-back').disabled = history.back.length === 0;
  document.getElementById('btn-forward').disabled = history.forward.length === 0;
  document.getElementById('btn-up').disabled = currentPath === '';

  // Delete button
  document.getElementById('btn-delete').disabled = selectedItems.size === 0;

  // Selection count
  if (selectedItems.size > 0) {
    selectionCount.textContent = `${selectedItems.size} selected`;
  } else {
    selectionCount.textContent = '';
  }

  // Paste menu item
  document.getElementById('menu-paste').classList.toggle('disabled', clipboard.items.length === 0);
}

function handleFileListClick(e) {
  const item = e.target.closest('.file-item');

  if (!item) {
    // Click on empty space - clear selection
    if (!e.ctrlKey && !e.metaKey) {
      selectedItems.clear();
      renderFiles();
      updateUI();
    }
    return;
  }

  const path = item.dataset.path;

  if (e.ctrlKey || e.metaKey) {
    // Toggle selection
    if (selectedItems.has(path)) {
      selectedItems.delete(path);
    } else {
      selectedItems.add(path);
    }
  } else if (e.shiftKey && selectedItems.size > 0) {
    // Range selection
    const paths = files.map(f => f.path);
    const lastSelected = Array.from(selectedItems).pop();
    const start = paths.indexOf(lastSelected);
    const end = paths.indexOf(path);

    const [from, to] = start < end ? [start, end] : [end, start];
    for (let i = from; i <= to; i++) {
      selectedItems.add(paths[i]);
    }
  } else {
    // Single selection
    selectedItems.clear();
    selectedItems.add(path);
  }

  renderFiles();
  updateUI();
}

function handleFileListDblClick(e) {
  const item = e.target.closest('.file-item');
  if (!item) return;

  const path = item.dataset.path;
  const isDir = item.dataset.isDir === 'true';

  if (isDir) {
    navigateTo(path);
  } else {
    // Open file in new tab
    window.open(`/media/${encodeURIComponent(path)}`, '_blank');
  }
}

function navigateTo(path) {
  history.back.push(currentPath);
  history.forward = [];
  loadFiles(path);
}

function goBack() {
  if (history.back.length === 0) return;
  history.forward.push(currentPath);
  loadFiles(history.back.pop());
}

function goForward() {
  if (history.forward.length === 0) return;
  history.back.push(currentPath);
  loadFiles(history.forward.pop());
}

function goUp() {
  if (currentPath === '') return;
  const parts = currentPath.split('/');
  parts.pop();
  navigateTo(parts.join('/'));
}

function refresh() {
  loadFiles(currentPath);
}

function handleContextMenu(e) {
  e.preventDefault();

  const item = e.target.closest('.file-item');

  if (item) {
    const path = item.dataset.path;
    if (!selectedItems.has(path)) {
      selectedItems.clear();
      selectedItems.add(path);
      renderFiles();
      updateUI();
    }
  }

  contextMenu.style.left = `${e.clientX}px`;
  contextMenu.style.top = `${e.clientY}px`;
  contextMenu.classList.add('visible');

  // Adjust position if menu goes off screen
  const rect = contextMenu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    contextMenu.style.left = `${window.innerWidth - rect.width - 8}px`;
  }
  if (rect.bottom > window.innerHeight) {
    contextMenu.style.top = `${window.innerHeight - rect.height - 8}px`;
  }
}

function handleContextMenuAction(e) {
  const action = e.target.dataset.action;
  if (!action) return;

  contextMenu.classList.remove('visible');

  switch (action) {
    case 'open':
      if (selectedItems.size === 1) {
        const path = Array.from(selectedItems)[0];
        const file = files.find(f => f.path === path);
        if (file.isDirectory) {
          navigateTo(path);
        } else {
          window.open(`/media/${encodeURIComponent(path)}`, '_blank');
        }
      }
      break;
    case 'rename':
      if (selectedItems.size === 1) {
        showRenameDialog();
      }
      break;
    case 'cut':
      clipboard = { items: Array.from(selectedItems), operation: 'cut' };
      renderFiles();
      updateUI();
      break;
    case 'copy':
      clipboard = { items: Array.from(selectedItems), operation: 'copy' };
      updateUI();
      break;
    case 'paste':
      handlePaste();
      break;
    case 'delete':
      showDeleteDialog();
      break;
  }
}

async function handlePaste() {
  if (clipboard.items.length === 0) return;

  try {
    statusText.textContent = 'Moving...';
    const response = await fetch('/api/files/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: clipboard.items,
        destination: currentPath
      })
    });

    const data = await response.json();
    if (data.success) {
      clipboard = { items: [], operation: null };
      loadFiles(currentPath);
    } else {
      alert('Error: ' + data.error);
    }
  } catch (err) {
    alert('Error moving files');
    console.error(err);
  }
}

function handleKeyDown(e) {
  // Delete key
  if (e.key === 'Delete' && selectedItems.size > 0) {
    showDeleteDialog();
  }

  // Ctrl+A - select all
  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    e.preventDefault();
    files.forEach(f => selectedItems.add(f.path));
    renderFiles();
    updateUI();
  }

  // F2 - rename
  if (e.key === 'F2' && selectedItems.size === 1) {
    showRenameDialog();
  }

  // Enter - open
  if (e.key === 'Enter' && selectedItems.size === 1) {
    const path = Array.from(selectedItems)[0];
    const file = files.find(f => f.path === path);
    if (file.isDirectory) {
      navigateTo(path);
    } else {
      window.open(`/media/${encodeURIComponent(path)}`, '_blank');
    }
  }

  // Backspace - go up
  if (e.key === 'Backspace' && !e.target.matches('input')) {
    e.preventDefault();
    goUp();
  }

  // Escape - clear selection
  if (e.key === 'Escape') {
    selectedItems.clear();
    renderFiles();
    updateUI();
    document.querySelectorAll('.dialog-overlay').forEach(d => d.classList.remove('visible'));
  }
}

// Drag and drop
function setupDragDrop() {
  const container = document.querySelector('.file-list-container');
  const overlay = document.getElementById('drop-overlay');

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(event => {
    container.addEventListener(event, e => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  container.addEventListener('dragenter', () => overlay.classList.add('active'));
  container.addEventListener('dragleave', e => {
    if (!container.contains(e.relatedTarget)) {
      overlay.classList.remove('active');
    }
  });
  container.addEventListener('drop', handleDrop);
}

async function handleDrop(e) {
  document.getElementById('drop-overlay').classList.remove('active');

  const files = e.dataTransfer.files;
  if (files.length === 0) return;

  uploadFiles(files);
}

async function handleFileSelect(e) {
  const files = e.target.files;
  if (files.length === 0) return;

  uploadFiles(files);
  e.target.value = ''; // Reset input
}

async function uploadFiles(fileList) {
  const progress = document.getElementById('upload-progress');
  const percent = document.getElementById('upload-percent');
  const bar = document.getElementById('upload-bar');

  progress.classList.add('visible');
  bar.style.width = '0%';

  const formData = new FormData();
  formData.append('path', currentPath);

  for (const file of fileList) {
    formData.append('files', file);
  }

  try {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        percent.textContent = pct + '%';
        bar.style.width = pct + '%';
      }
    });

    xhr.addEventListener('load', () => {
      progress.classList.remove('visible');
      if (xhr.status === 200) {
        loadFiles(currentPath);
      } else {
        alert('Upload failed');
      }
    });

    xhr.addEventListener('error', () => {
      progress.classList.remove('visible');
      alert('Upload failed');
    });

    xhr.open('POST', '/api/files/upload');
    xhr.send(formData);
  } catch (err) {
    progress.classList.remove('visible');
    alert('Upload failed');
    console.error(err);
  }
}

// Dialogs
function setupDialogs() {
  // Rename dialog
  document.getElementById('rename-cancel').addEventListener('click', () => {
    document.getElementById('rename-dialog').classList.remove('visible');
  });
  document.getElementById('rename-confirm').addEventListener('click', handleRename);
  document.getElementById('rename-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleRename();
  });

  // New folder dialog
  document.getElementById('folder-cancel').addEventListener('click', () => {
    document.getElementById('folder-dialog').classList.remove('visible');
  });
  document.getElementById('folder-confirm').addEventListener('click', handleCreateFolder);
  document.getElementById('folder-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleCreateFolder();
  });

  // Delete dialog
  document.getElementById('delete-cancel').addEventListener('click', () => {
    document.getElementById('delete-dialog').classList.remove('visible');
  });
  document.getElementById('delete-confirm').addEventListener('click', handleDelete);
}

function showRenameDialog() {
  if (selectedItems.size !== 1) return;

  const path = Array.from(selectedItems)[0];
  const file = files.find(f => f.path === path);

  const input = document.getElementById('rename-input');
  input.value = file.name;

  document.getElementById('rename-dialog').classList.add('visible');
  input.focus();
  input.select();
}

async function handleRename() {
  const path = Array.from(selectedItems)[0];
  const newName = document.getElementById('rename-input').value.trim();

  if (!newName) return;

  document.getElementById('rename-dialog').classList.remove('visible');

  try {
    const response = await fetch('/api/files/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, newName })
    });

    const data = await response.json();
    if (data.success) {
      loadFiles(currentPath);
    } else {
      alert('Error: ' + data.error);
    }
  } catch (err) {
    alert('Error renaming');
    console.error(err);
  }
}

function showNewFolderDialog() {
  const input = document.getElementById('folder-input');
  input.value = 'New Folder';

  document.getElementById('folder-dialog').classList.add('visible');
  input.focus();
  input.select();
}

async function handleCreateFolder() {
  const name = document.getElementById('folder-input').value.trim();

  if (!name) return;

  document.getElementById('folder-dialog').classList.remove('visible');

  try {
    const response = await fetch('/api/files/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentPath, name })
    });

    const data = await response.json();
    if (data.success) {
      loadFiles(currentPath);
    } else {
      alert('Error: ' + data.error);
    }
  } catch (err) {
    alert('Error creating folder');
    console.error(err);
  }
}

function showDeleteDialog() {
  if (selectedItems.size === 0) return;

  const count = selectedItems.size;
  document.getElementById('delete-message').textContent =
    count === 1
      ? 'Are you sure you want to delete this item?'
      : `Are you sure you want to delete ${count} items?`;

  document.getElementById('delete-dialog').classList.add('visible');
}

async function handleDelete() {
  document.getElementById('delete-dialog').classList.remove('visible');

  try {
    statusText.textContent = 'Deleting...';
    const response = await fetch('/api/files/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: Array.from(selectedItems) })
    });

    const data = await response.json();
    if (data.success) {
      selectedItems.clear();
      loadFiles(currentPath);
    } else {
      alert('Error: ' + data.error);
    }
  } catch (err) {
    alert('Error deleting');
    console.error(err);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
