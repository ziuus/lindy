# Lindy

> *"Dual-boot made simple. One click to sync your Windows and Linux folders."*

**A desktop application for managing Linux filesystem mounts with automatic Windows partition detection and folder mapping.**

---

## Overview

Lindy simplifies filesystem mount management for Linux users in dual-boot environments, making it easy to access Windows partitions and user folders.

## Key Features

### 🚀 Smart Auto-Map
**One-click Windows partition detection and folder mapping**

- Automatically scans for Windows partitions (NTFS/exFAT)
- Detects Windows usernames and folder structures
- Creates complete folder mappings without manual configuration
- Secure mounting with proper permissions

### ⚙️ Manual Auto-Map
**Custom control for advanced users**

- Specify custom mount points and paths
- Manual Windows username override
- Choose specific folders to map

### 📁 Supported Folder Mappings

| Linux Folder | Windows Folder |
|--------------|----------------|
| Desktop | Desktop |
| Documents | Documents |
| Downloads | Downloads |
| Pictures | Pictures |
| Music | Music |
| Videos | Videos |


## Installation

You can download the latest installers (.deb, .rpm, .AppImage) from the [Installers](./docs/Installers) folder.

## System Requirements

- Linux desktop distribution
- **Dependencies**: `psmisc` (for fuser) and `polkit` (for pkexec)
- Windows partition (NTFS/exFAT) for dual-boot scenarios

## Development

### Prerequisites
- Node.js 18+ with pnpm
- Rust toolchain (latest stable)
- Tauri CLI

### Setup
```bash
# Install dependencies
pnpm install

# Development server
pnpm dev

# Build application
pnpm build
```

## License

This project is licensed under the MIT License.

---

*Lindy: Simplifying Linux mount management for the modern desktop user.*
