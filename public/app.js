// State
let currentPath = '';
let files = [];
let selectedItems = new Set();
let clipboard = { items: [], operation: null };
let history = { back: [], forward: [] };
const MAX_HISTORY = 50; // Prevent memory growth

// Elements (cached for performance)
let fileList, addressInput, statusText, selectionCount, contextMenu;

// Icons
const ICONS = {
  folder: `<svg viewBox="0 0 48 48"><path fill="currentColor" d="M4 8h16l4 4h20v28H4V8z"/><path fill="rgba(0,0,0,0.1)" d="M4 12h40v4H4z"/></svg>`,
  video: `<svg viewBox="0 0 48 48"><rect fill="currentColor" x="4" y="8" width="40" height="32" rx="2"/><path fill="#fff" d="M18 16v16l14-8z"/></svg>`,
  audio: `<svg viewBox="0 0 48 48"><circle fill="currentColor" cx="24" cy="24" r="20"/><circle fill="#fff" cx="24" cy="24" r="8"/><circle fill="currentColor" cx="24" cy="24" r="3"/></svg>`,
  image: `<svg viewBox="0 0 48 48"><rect fill="currentColor" x="4" y="8" width="40" height="32" rx="2"/><circle fill="#fff" cx="16" cy="20" r="4"/><path fill="#fff" d="M4 36l12-12 8 8 10-10 10 10v4H4z"/></svg>`,
  file: `<svg viewBox="0 0 48 48"><path fill="currentColor" d="M8 4h20l12 12v28H8V4z"/><path fill="rgba(255,255,255,0.3)" d="M28 4v12h12z"/></svg>`
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function init() {
  // Cache DOM elements
  fileList = document.getElementById('file-list');
  addressInput = document.getElementById('address');
  statusText = document.getElementById('status-text');
  selectionCount = document.getElementById('selection-count');
  contextMenu = document.getElementById('context-menu');

  if (!fileList || !addressInput || !statusText || !selectionCount || !contextMenu) {
    console.error('Required DOM elements not found');
    return;
  }

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
  document.addEventListener('click', hideContextMenu);

  // Keyboard
  document.addEventListener('keydown', handleKeyDown);

  // Drag and drop
  setupDragDrop();

  // Dialogs
  setupDialogs();
}

function hideContextMenu() {
  if (contextMenu) {
    contextMenu.classList.remove('visible');
  }
}

async function loadFiles(path) {
  try {
    statusText.textContent = 'Loading...';

    const response = await fetch(`/api/files/list?path=${encodeURIComponent(path)}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error);
    }

    files = data.items || [];
    currentPath = data.path || '';
    selectedItems.clear();

    renderFiles();
    updateUI();
    statusText.textContent = `${files.length} item${files.length !== 1 ? 's' : ''}`;
  } catch (err) {
    statusText.textContent = 'Error loading files';
    console.error('Load error:', err);
    // Show empty state on error
    files = [];
    renderFiles();
    updateUI();
  }
}

function renderFiles() {
  if (!fileList) return;

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

  const ext = (file.name.split('.').pop() || '').toLowerCase();

  const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpeg', 'mpg'];
  const audioExts = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus'];
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'];

  if (videoExts.includes(ext)) return 'video';
  if (audioExts.includes(ext)) return 'audio';
  if (imageExts.includes(ext)) return 'image';

  return 'file';
}

function updateUI() {
  // Address bar
  if (addressInput) {
    addressInput.value = '/' + currentPath;
  }

  // Navigation buttons
  const backBtn = document.getElementById('btn-back');
  const fwdBtn = document.getElementById('btn-forward');
  const upBtn = document.getElementById('btn-up');
  const delBtn = document.getElementById('btn-delete');

  if (backBtn) backBtn.disabled = history.back.length === 0;
  if (fwdBtn) fwdBtn.disabled = history.forward.length === 0;
  if (upBtn) upBtn.disabled = currentPath === '';
  if (delBtn) delBtn.disabled = selectedItems.size === 0;

  // Selection count
  if (selectionCount) {
    selectionCount.textContent = selectedItems.size > 0 ? `${selectedItems.size} selected` : '';
  }

  // Paste menu item
  const pasteItem = document.getElementById('menu-paste');
  if (pasteItem) {
    pasteItem.classList.toggle('disabled', clipboard.items.length === 0);
  }
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

    if (start !== -1 && end !== -1) {
      const [from, to] = start < end ? [start, end] : [end, start];
      for (let i = from; i <= to; i++) {
        selectedItems.add(paths[i]);
      }
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
  // Limit history size
  history.back.push(currentPath);
  if (history.back.length > MAX_HISTORY) {
    history.back.shift();
  }
  history.forward = [];
  loadFiles(path);
}

function goBack() {
  if (history.back.length === 0) return;
  history.forward.push(currentPath);
  if (history.forward.length > MAX_HISTORY) {
    history.forward.shift();
  }
  loadFiles(history.back.pop());
}

function goForward() {
  if (history.forward.length === 0) return;
  history.back.push(currentPath);
  if (history.back.length > MAX_HISTORY) {
    history.back.shift();
  }
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
  requestAnimationFrame(() => {
    const rect = contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      contextMenu.style.left = `${window.innerWidth - rect.width - 8}px`;
    }
    if (rect.bottom > window.innerHeight) {
      contextMenu.style.top = `${window.innerHeight - rect.height - 8}px`;
    }
  });
}

function handleContextMenuAction(e) {
  const action = e.target.dataset.action;
  if (!action) return;

  e.stopPropagation();
  hideContextMenu();

  switch (action) {
    case 'open':
      if (selectedItems.size === 1) {
        const path = Array.from(selectedItems)[0];
        const file = files.find(f => f.path === path);
        if (file) {
          if (file.isDirectory) {
            navigateTo(path);
          } else {
            window.open(`/media/${encodeURIComponent(path)}`, '_blank');
          }
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

  const operation = clipboard.operation;
  const endpoint = operation === 'copy' ? '/api/files/copy' : '/api/files/move';
  const verb = operation === 'copy' ? 'Copying' : 'Moving';

  try {
    statusText.textContent = `${verb}...`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: clipboard.items,
        destination: currentPath
      })
    });

    const data = await response.json();

    if (data.success) {
      // Clear clipboard for cut, keep for copy
      if (operation === 'cut') {
        clipboard = { items: [], operation: null };
      }
      loadFiles(currentPath);
    } else {
      showError(data.error || `${verb} failed`);
      statusText.textContent = 'Error';
    }
  } catch (err) {
    showError(`${verb} failed`);
    console.error(err);
    statusText.textContent = 'Error';
  }
}

function handleKeyDown(e) {
  // Ignore if typing in input
  if (e.target.matches('input')) {
    if (e.key === 'Escape') {
      e.target.blur();
      document.querySelectorAll('.dialog-overlay').forEach(d => d.classList.remove('visible'));
    }
    return;
  }

  // Delete key
  if (e.key === 'Delete' && selectedItems.size > 0) {
    e.preventDefault();
    showDeleteDialog();
  }

  // Ctrl+A - select all
  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    e.preventDefault();
    files.forEach(f => selectedItems.add(f.path));
    renderFiles();
    updateUI();
  }

  // Ctrl+C - copy
  if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selectedItems.size > 0) {
    e.preventDefault();
    clipboard = { items: Array.from(selectedItems), operation: 'copy' };
    updateUI();
  }

  // Ctrl+X - cut
  if ((e.ctrlKey || e.metaKey) && e.key === 'x' && selectedItems.size > 0) {
    e.preventDefault();
    clipboard = { items: Array.from(selectedItems), operation: 'cut' };
    renderFiles();
    updateUI();
  }

  // Ctrl+V - paste
  if ((e.ctrlKey || e.metaKey) && e.key === 'v' && clipboard.items.length > 0) {
    e.preventDefault();
    handlePaste();
  }

  // F2 - rename
  if (e.key === 'F2' && selectedItems.size === 1) {
    e.preventDefault();
    showRenameDialog();
  }

  // F5 - refresh
  if (e.key === 'F5') {
    e.preventDefault();
    refresh();
  }

  // Enter - open
  if (e.key === 'Enter' && selectedItems.size === 1) {
    e.preventDefault();
    const path = Array.from(selectedItems)[0];
    const file = files.find(f => f.path === path);
    if (file) {
      if (file.isDirectory) {
        navigateTo(path);
      } else {
        window.open(`/media/${encodeURIComponent(path)}`, '_blank');
      }
    }
  }

  // Backspace - go up
  if (e.key === 'Backspace') {
    e.preventDefault();
    goUp();
  }

  // Escape - clear selection and close dialogs
  if (e.key === 'Escape') {
    selectedItems.clear();
    renderFiles();
    updateUI();
    document.querySelectorAll('.dialog-overlay').forEach(d => d.classList.remove('visible'));
    hideContextMenu();
  }
}

// Drag and drop
function setupDragDrop() {
  const container = document.querySelector('.file-list-container');
  const overlay = document.getElementById('drop-overlay');

  if (!container || !overlay) return;

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
  const overlay = document.getElementById('drop-overlay');
  if (overlay) overlay.classList.remove('active');

  const droppedFiles = e.dataTransfer.files;
  if (droppedFiles.length === 0) return;

  uploadFiles(droppedFiles);
}

async function handleFileSelect(e) {
  const selectedFiles = e.target.files;
  if (selectedFiles.length === 0) return;

  uploadFiles(selectedFiles);
  e.target.value = ''; // Reset input
}

async function uploadFiles(fileList) {
  const progress = document.getElementById('upload-progress');
  const percent = document.getElementById('upload-percent');
  const bar = document.getElementById('upload-bar');

  if (!progress || !percent || !bar) return;

  progress.classList.add('visible');
  bar.style.width = '0%';
  percent.textContent = '0%';

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
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.success) {
            loadFiles(currentPath);
          } else {
            showError(data.error || 'Upload failed');
          }
        } catch {
          showError('Upload failed');
        }
      } else {
        showError('Upload failed');
      }
    });

    xhr.addEventListener('error', () => {
      progress.classList.remove('visible');
      showError('Upload failed - network error');
    });

    xhr.addEventListener('abort', () => {
      progress.classList.remove('visible');
    });

    xhr.open('POST', '/api/files/upload');
    xhr.send(formData);
  } catch (err) {
    progress.classList.remove('visible');
    showError('Upload failed');
    console.error(err);
  }
}

// Dialogs
function setupDialogs() {
  // Rename dialog
  const renameCancel = document.getElementById('rename-cancel');
  const renameConfirm = document.getElementById('rename-confirm');
  const renameInput = document.getElementById('rename-input');

  if (renameCancel) renameCancel.addEventListener('click', () => {
    document.getElementById('rename-dialog').classList.remove('visible');
  });
  if (renameConfirm) renameConfirm.addEventListener('click', handleRename);
  if (renameInput) renameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleRename();
    if (e.key === 'Escape') document.getElementById('rename-dialog').classList.remove('visible');
  });

  // New folder dialog
  const folderCancel = document.getElementById('folder-cancel');
  const folderConfirm = document.getElementById('folder-confirm');
  const folderInput = document.getElementById('folder-input');

  if (folderCancel) folderCancel.addEventListener('click', () => {
    document.getElementById('folder-dialog').classList.remove('visible');
  });
  if (folderConfirm) folderConfirm.addEventListener('click', handleCreateFolder);
  if (folderInput) folderInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleCreateFolder();
    if (e.key === 'Escape') document.getElementById('folder-dialog').classList.remove('visible');
  });

  // Delete dialog
  const deleteCancel = document.getElementById('delete-cancel');
  const deleteConfirm = document.getElementById('delete-confirm');

  if (deleteCancel) deleteCancel.addEventListener('click', () => {
    document.getElementById('delete-dialog').classList.remove('visible');
  });
  if (deleteConfirm) deleteConfirm.addEventListener('click', handleDelete);
}

function showRenameDialog() {
  if (selectedItems.size !== 1) return;

  const path = Array.from(selectedItems)[0];
  const file = files.find(f => f.path === path);
  if (!file) return;

  const input = document.getElementById('rename-input');
  const dialog = document.getElementById('rename-dialog');

  if (input && dialog) {
    input.value = file.name;
    dialog.classList.add('visible');
    input.focus();
    // Select filename without extension for files
    if (!file.isDirectory && file.name.includes('.')) {
      const dotIndex = file.name.lastIndexOf('.');
      input.setSelectionRange(0, dotIndex);
    } else {
      input.select();
    }
  }
}

async function handleRename() {
  const path = Array.from(selectedItems)[0];
  const input = document.getElementById('rename-input');
  const dialog = document.getElementById('rename-dialog');

  if (!input || !dialog) return;

  const newName = input.value.trim();
  if (!newName) return;

  dialog.classList.remove('visible');

  try {
    statusText.textContent = 'Renaming...';

    const response = await fetch('/api/files/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, newName })
    });

    const data = await response.json();

    if (data.success) {
      loadFiles(currentPath);
    } else {
      showError(data.error || 'Rename failed');
      statusText.textContent = 'Error';
    }
  } catch (err) {
    showError('Rename failed');
    console.error(err);
    statusText.textContent = 'Error';
  }
}

function showNewFolderDialog() {
  const input = document.getElementById('folder-input');
  const dialog = document.getElementById('folder-dialog');

  if (input && dialog) {
    input.value = 'New Folder';
    dialog.classList.add('visible');
    input.focus();
    input.select();
  }
}

async function handleCreateFolder() {
  const input = document.getElementById('folder-input');
  const dialog = document.getElementById('folder-dialog');

  if (!input || !dialog) return;

  const name = input.value.trim();
  if (!name) return;

  dialog.classList.remove('visible');

  try {
    statusText.textContent = 'Creating folder...';

    const response = await fetch('/api/files/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentPath, name })
    });

    const data = await response.json();

    if (data.success) {
      loadFiles(currentPath);
    } else {
      showError(data.error || 'Failed to create folder');
      statusText.textContent = 'Error';
    }
  } catch (err) {
    showError('Failed to create folder');
    console.error(err);
    statusText.textContent = 'Error';
  }
}

function showDeleteDialog() {
  if (selectedItems.size === 0) return;

  const message = document.getElementById('delete-message');
  const dialog = document.getElementById('delete-dialog');

  if (message && dialog) {
    const count = selectedItems.size;
    message.textContent = count === 1
      ? 'Are you sure you want to delete this item?'
      : `Are you sure you want to delete ${count} items?`;
    dialog.classList.add('visible');
  }
}

async function handleDelete() {
  const dialog = document.getElementById('delete-dialog');
  if (dialog) dialog.classList.remove('visible');

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
      showError(data.error || 'Delete failed');
      statusText.textContent = 'Error';
    }
  } catch (err) {
    showError('Delete failed');
    console.error(err);
    statusText.textContent = 'Error';
  }
}

function showError(message) {
  // Use a simple alert for now - could be replaced with a nicer notification
  alert(message);
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
