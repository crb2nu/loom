# Changelog

All notable changes to the Loom extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.7.0] - 2026-01-31

### Added

- **Multi-platform support**: VS Code, Antigravity, Gemini, Claude, Codex, Kilocode
- **Platform detection**: Auto-detects VS Code vs Antigravity via `vscode.env.appName`
- **Loom Platforms view**: Tree view showing sync status for all platforms
- **Sync Dashboard webview**: Visual grid of platform sync status with actions
- **Platform sync commands**:
  - `Loom: Show Platform Configs`
  - `Loom: Sync Platform Config`
  - `Loom: Sync All Platforms`
  - `Loom: Diff Platform Config`
  - `Loom: Open Platform Config`
  - `Loom: Regenerate Platform Config`
  - `Loom: Pull Config from Home`
  - `Loom: Backup All Configs`
  - `Loom: Show Sync Dashboard`
- **Skills platform filtering**: Filter skills by target platform (codex, claude, gemini)
- **Profile platforms support**: Profiles can now specify which platforms they apply to
- **New settings**:
  - `loom.platform`: Platform mode (auto, vscode, antigravity)
  - `loom.enabledPlatforms`: Platforms to manage
  - `loom.syncOnStartup`: Auto-sync on extension start
  - `loom.syncStatusPollingInterval`: Polling interval for sync status

### Changed

- Profile structure now includes optional `platforms` array
- Skills provider shows target platform badges

## [0.6.0] - 2026-01-15

### Added

- **Server health monitoring**: Dashboard with per-server metrics
- **Profile manager**: Quick switching between server sets
- **Routing status**: View hub vs local routing

### Changed

- Improved hub connection handling
- Better error messages for daemon communication

## [0.5.0] - 2026-01-01

### Added

- **Agent context integration**: Sessions, context entries, tasks
- **Knowledge graph view**: Visual context relationships
- **Code annotations**: Gutter decorations for agent context
- **Memory dashboard**: Webview for context exploration

### Changed

- Renamed from "Codex Context Manager" to "Loom"
- Updated all command prefixes from `codexContextManager` to `loom`

## [0.4.0] - 2025-12-15

### Added

- **Skills registry**: Browse and manage agent skills
- **Skill scripts**: Execute skill scripts from VS Code
- **Category filtering**: Filter skills by category
- **Skill search**: Search skills by name

## [0.3.0] - 2025-12-01

### Added

- **Secrets management**: View, set, and validate secrets
- **Config validation**: Check for missing secrets in MCP configs
- **Keychain integration**: Support for `${keychain:KEY}` pattern

## [0.2.0] - 2025-11-15

### Added

- **Daemon integration**: Start, stop, restart loom daemon
- **Tools view**: Browse available MCP tools
- **Tool search**: Search tools across all servers

### Changed

- Migrated from Python generator to Go-based loom CLI

## [0.1.0] - 2025-11-01

### Added

- **Hub integration**: Connect to MCP gateway
- **Hub Overview view**: Registry metadata display
- **Servers view**: List running MCP servers
- **Health checks**: Server connectivity testing
- **Config sync**: Generate mcp.json from registry

## [0.0.1] - 2025-10-04

### Added

- Initial extension scaffold
- Basic commands and project structure
- Documentation and metadata

[0.7.0]: https://gitlab.flexinfer.ai/services/loom/-/compare/v0.6.0...v0.7.0
[0.6.0]: https://gitlab.flexinfer.ai/services/loom/-/compare/v0.5.0...v0.6.0
[0.5.0]: https://gitlab.flexinfer.ai/services/loom/-/compare/v0.4.0...v0.5.0
[0.4.0]: https://gitlab.flexinfer.ai/services/loom/-/compare/v0.3.0...v0.4.0
[0.3.0]: https://gitlab.flexinfer.ai/services/loom/-/compare/v0.2.0...v0.3.0
[0.2.0]: https://gitlab.flexinfer.ai/services/loom/-/compare/v0.1.0...v0.2.0
[0.1.0]: https://gitlab.flexinfer.ai/services/loom/-/compare/v0.0.1...v0.1.0
[0.0.1]: https://gitlab.flexinfer.ai/services/loom/-/releases/v0.0.1
