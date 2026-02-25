# Project Roadmap

> Last Updated: February 2026

## Current Status: v0.9.0

Loom is a VS Code extension for MCP (Model Context Protocol) context management. It provides unified configuration sync across multiple AI coding assistant platforms.

### v0.9.0 Highlights

- **Onboarding wizard**: Welcome walkthrough for new users
- **Deep search framework**: Search across MCP resources
- **Skill recommendations**: Context-aware skill suggestions
- **Server metrics**: Performance monitoring and health tracking

### v0.8.0 Highlights

- **Error recovery**: Better handling of daemon/CLI failures
- **Offline mode**: Graceful degradation when hub unreachable
- **Config templates**: Quick-start templates for common setups
- **Bulk operations**: Select multiple platforms for sync

### v0.7.0 Highlights

- **Multi-platform support**: VS Code, Antigravity, Gemini, Claude, Codex, Kilocode
- **Platform detection**: Auto-detects VS Code vs Antigravity
- **Sync dashboard**: Visual status grid across all platforms
- **Skills filtering**: Filter by target platform

## Implemented Features

### Onboarding & Discovery (v0.9.0)
- [x] Welcome wizard with first-run detection
- [x] Workspace environment snapshot
- [x] Guided setup for registry and daemon
- [x] Deep search framework for MCP resources
- [x] Context-aware skill recommendations
- [x] Server metrics and performance tracking

### Error Handling & Resilience (v0.8.0)
- [x] Daemon error recovery with notifications
- [x] Offline mode with pending sync queue
- [x] Config templates for quick setup
- [x] Bulk platform operations
- [x] Config drift detection

### Platform Management (v0.7.0)
- [x] Platform detection (VS Code vs Antigravity)
- [x] Loom Platforms tree view
- [x] Sync dashboard webview
- [x] Platform sync commands (sync, diff, open, regenerate)
- [x] Profile platforms support
- [x] Skills platform filtering

### Server Health (v0.6.0)
- [x] Health monitoring dashboard
- [x] Profile manager with quick switching
- [x] Hub vs local routing status

### Agent Context (v0.5.0)
- [x] Session management (start/end)
- [x] Context entries (decisions, findings, questions)
- [x] Task tracking
- [x] Knowledge graph visualization
- [x] Code annotations with gutter decorations

### Skills Registry (v0.4.0)
- [x] Skills browser with categories
- [x] Script execution from VS Code
- [x] Skill search and filtering
- [x] Resource and asset access

### Secrets Management (v0.3.0)
- [x] Secrets view and management
- [x] Config validation for missing secrets
- [x] Keychain integration

### Core Features (v0.1.0-0.2.0)
- [x] MCP Hub integration
- [x] Server status polling
- [x] Tools browser
- [x] Daemon control (start/stop/restart)
- [x] Config sync from registry

## Upcoming Work

### v1.0.0 Release

- [ ] **Test coverage**: Increase to 40%+ coverage
- [ ] **Marketplace publishing**: VS Code Marketplace release
- [ ] **API stability**: Document stable vs internal APIs
- [ ] **Daemon failure recovery**: Retry logic with user notification
- [ ] **Offline mode completion**: Full pending sync processing

### Post-1.0 Features

- [ ] **Antigravity store**: Publish to Antigravity extension store
- [x] **Plugin system**: Allow custom providers and views
- [ ] **Theme support**: Light/dark theme awareness
- [ ] **Remote tunnels**: Secure tunneling to remote K8s MCP servers
- [ ] **Usage analytics**: Track tool usage patterns

## Non-Goals

These are intentionally out of scope:

- **MCP server implementation**: Handled by loom-core
- **Registry editing**: Use `registry.yaml` directly
- **IDE-agnostic UI**: Extension is VS Code-specific

## Architecture

```
Loom Extension (TypeScript)
├── UI Layer
│   ├── Tree Views (platforms, servers, skills, etc.)
│   ├── Webviews (dashboard, knowledge graph)
│   └── Status Bar
├── Client Layer
│   ├── Platform Config Client
│   ├── Hub Client (WebSocket)
│   ├── Daemon Client (HTTP)
│   └── Skills Client
└── Manager Layer
    ├── Profile Manager
    ├── Config Sync Manager
    ├── Deep Search Manager
    ├── Skill Recommendation Manager
    └── Health Monitor

loom CLI (Go) - loom-core
├── sync command (platform configs)
├── proxy command (MCP aggregation)
├── daemon command (background service)
└── generate command (config generation)
```

## References

| Document | Purpose |
|----------|---------|
| [README.md](README.md) | Installation and usage |
| [AGENTS.md](AGENTS.md) | Agent working notes |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
