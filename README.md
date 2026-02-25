# Lobby TV Media Server

A simple, lightweight DLNA media server with a web-based file manager. Designed to run on a Raspberry Pi and display media on TVs in a lobby or similar space.

## Features

- **DLNA/UPnP Server**: TVs and media players can discover and play media automatically
- **Web File Manager**: Windows Explorer-style interface for managing media files
  - Upload files (drag & drop supported)
  - Create folders
  - Rename files and folders
  - Move files between folders
  - Delete files and folders
- **Lightweight**: Minimal dependencies, runs well on Raspberry Pi
- **Simple**: No database required, works directly with the filesystem

## Requirements

- Node.js 18 or later
- Network access (for DLNA discovery)

## Installation

```bash
# Clone or download the project
cd mediaserver

# Install dependencies
npm install

# Start the server
npm start
```

## Usage

Once started, you'll see:

```
========================================
  Media Server Started
========================================
  Web Interface: http://localhost:3000
  Media Directory: /path/to/mediaserver/media
========================================
  DLNA Server running on port 8200
  Your TVs should discover: "Lobby TV Media Server"
========================================
```

### Web Interface

Open `http://<raspberry-pi-ip>:3000` in a browser to access the file manager.

- **Upload**: Click "Upload" or drag files onto the window
- **Navigate**: Double-click folders to open them
- **Select**: Click to select, Ctrl+click for multiple, Shift+click for range
- **Rename**: Right-click > Rename, or press F2
- **Delete**: Right-click > Delete, or press Delete key
- **Move**: Right-click > Cut, navigate to destination, right-click > Paste

### DLNA

Your TV or media player should automatically discover "Lobby TV Media Server". Browse to it to see your media files organized by folder.

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Web interface port |
| `DLNA_PORT` | `8200` | DLNA HTTP server port |
| `MEDIA_DIR` | `./media` | Directory for media files |

Example:
```bash
PORT=8080 MEDIA_DIR=/mnt/usb/media npm start
```

## Running on Raspberry Pi

### As a systemd service

Create `/etc/systemd/system/mediaserver.service`:

```ini
[Unit]
Description=Lobby Media Server
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/mediaserver
ExecStart=/usr/bin/node server.js
Restart=on-failure
Environment=MEDIA_DIR=/home/pi/media

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable mediaserver
sudo systemctl start mediaserver
```

### Check status
```bash
sudo systemctl status mediaserver
```

### View logs
```bash
journalctl -u mediaserver -f
```

## Supported Media Formats

The DLNA server advertises support for common formats. Actual playback depends on your TV's capabilities:

- **Video**: MP4, MKV, AVI, MOV, WebM
- **Audio**: MP3, WAV, FLAC, AAC, OGG
- **Images**: JPEG, PNG, GIF, WebP

## Troubleshooting

### TV doesn't find the server

1. Ensure both devices are on the same network
2. Check if UDP port 1900 (SSDP) is not blocked
3. Try restarting both the server and TV
4. Some TVs need a few minutes to discover new DLNA servers

### Can't upload large files

The default upload limit is 5GB. For larger files, copy them directly to the media directory.

### Permission errors

Ensure the user running the server has read/write access to the media directory:
```bash
chown -R pi:pi /home/pi/media
```

## License

MIT
