# Lind-Mount

> *"Dual-boot made simple. One click to sync your Windows and Linux folders."*

**A modern desktop application for managing Linux filesystem mounts with intelligent Windows partition detection and automatic folder mapping.**

Built with Tauri, React, and TypeScript, Lind-Mount simplifies the complex task of setting up persistent mount configurations for dual-boot systems and shared storage scenarios.

---

## Overview

Lind-Mount is designed for Linux users who need to manage filesystem mounts, particularly in dual-boot environments where seamless access to Windows partitions and user folders is essential. The application provides both automated and manual approaches to mount management, with comprehensive error handling and user-friendly interfaces.

## Key Features

### 🚀 Smart Auto-Map
**Intelligent one-click Windows partition detection and folder mapping**

- **Automatic Detection**: Scans system for Windows partitions (NTFS/exFAT) using `lsblk`
- **Secure Mounting**: Uses privileged operations (pkexec/polkit) for safe partition mounting
- **User Recognition**: Automatically detects Windows usernames and folder structures
- **Zero Configuration**: Creates complete folder mappings without user input
- **Error Recovery**: Comprehensive error handling with user-friendly explanations

**Workflow:**
1. System scans for available Windows partitions
2. Identifies the primary Windows installation
3. Securely mounts the partition with appropriate permissions
4. Detects Windows user accounts and standard folders
5. Creates bidirectional folder mappings
6. Updates application settings automatically

### ⚙️ Manual Auto-Map
**Granular control for advanced users and custom configurations**

- **Custom Mount Points**: Specify exact partition locations and mount paths
- **Username Override**: Manual Windows username specification
- **Selective Mapping**: Choose specific folders to map
- **Validation**: Path verification before mapping creation

### 📁 Supported Folder Mappings

| Linux Folder | Windows Folder | Variants Supported |
|--------------|----------------|-------------------|
| Desktop | Desktop | Desktop |
| Documents | Documents | Documents, My Documents |
| Downloads | Downloads | Downloads |
| Pictures | Pictures | Pictures, My Pictures |
| Music | Music | Music, My Music |
| Videos | Videos | Videos, My Videos |

## Error Handling & User Experience

### Intelligent Error Detection
The application provides context-aware error messages that translate technical issues into actionable solutions:

- **Filesystem Corruption**: Detects NTFS inconsistencies and provides Windows repair guidance
- **Permission Issues**: Guides users through privilege elevation processes
- **Resource Conflicts**: Identifies busy partitions and suggests resolution steps
- **Configuration Problems**: Offers alternative approaches when automatic detection fails

### User-Friendly Interface
- **Plain Language**: Technical jargon replaced with clear explanations
- **Progressive Disclosure**: Technical details available for advanced users
- **Fallback Options**: Alternative methods provided when primary approaches fail
- **Operation Logging**: Comprehensive activity tracking for troubleshooting

## Technical Architecture

### Backend (Rust/Tauri)
- **System Integration**: Direct interaction with Linux mount subsystem
- **Security**: Privileged operations handled through pkexec/polkit
- **Partition Detection**: Advanced parsing of `lsblk` output for Windows partition identification
- **Error Handling**: Structured error responses with detailed diagnostic information

### Frontend (React/TypeScript)
- **Modern UI**: Material-UI components with responsive design
- **State Management**: Comprehensive application state handling
- **Error Presentation**: User-friendly error dialogs with progressive disclosure
- **Theme Support**: Dark/light mode with customizable accent colors

### Key Benefits

- **Efficiency**: Reduces mount configuration time from minutes to seconds
- **Reliability**: Validates all operations before execution
- **Safety**: Comprehensive backup and rollback mechanisms
- **Accessibility**: Suitable for both novice and expert users
- **Maintainability**: Clean separation between detection, mounting, and configuration

## System Requirements

- **Operating System**: Linux (desktop distribution)
- **Permissions**: User account with sudo privileges
- **Dependencies**: pkexec/polkit for privilege elevation
- **Storage**: Windows partition (NTFS/exFAT) for dual-boot scenarios

## Development

### Prerequisites
- Node.js 18+ with pnpm package manager
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

# Run tests
pnpm test
```

### IDE Configuration
- **Recommended**: [VS Code](https://code.visualstudio.com/)
- **Extensions**: 
  - [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
  - [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
  - [TypeScript and JavaScript Language Features](https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-typescript-next)

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Contributing

Contributions are welcome! Please read our contributing guidelines and submit pull requests for any improvements.

---

*Lind-Mount: Simplifying Linux mount management for the modern desktop user.*
