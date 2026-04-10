# Project Roadmap

> Last Updated: April 2026

## Current Status: v1.0.0 readiness

Loom is a VS Code extension for MCP (Model Context Protocol) context management. It provides unified configuration sync across multiple AI coding assistant platforms.

### v0.9.0 Highlights

- **Onboarding wizard**: Welcome walkthrough for new users
- **Deep search framework**: Search across MCP resources
- **Skill recommendations**: Context-aware skill suggestions
- **Server metrics**: Performance monitoring and health tracking
- **Usage analytics**: Tool invocation tracking and report generation
- **Remote tunnels**: Managed `kubectl` port-forward workflows for remote K8s MCP services

The extension is now beyond the original `v0.9.0` baseline. The remaining work is about stabilizing contracts, aligning docs, and tightening release gates rather than adding another isolated feature tier.

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
- [x] Usage analytics report command
- [x] Remote tunnel start/stop/status commands

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

## 1.0.0 Release Focus

Tracking issue: [#1](https://gitlab.flexinfer.ai/services/loom/-/issues/1)

- [ ] **Contract-first profile/runtime adapters**: Prefer Loom resources and JSON-first paths where available.
- [ ] **Downstream contract verification**: Track selected `loom-core` golden fixtures in CI.
- [ ] **Parity overview**: Promote fleet, health, tasks, memory, presence, and stream into one shell.
- [ ] **Search capability metadata**: Replace brittle hardcoded tool-family assumptions.
- [ ] **Webview hardening**: Reduce inline HTML/JS debt in release-critical panels.
- [ ] **Release gates**: Keep docs, coverage, package, and publish checks aligned with the shipped surface.

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

| Document                     | Purpose                |
| ---------------------------- | ---------------------- |
| [README.md](README.md)       | Installation and usage |
| [AGENTS.md](AGENTS.md)       | Agent working notes    |
| [CHANGELOG.md](CHANGELOG.md) | Version history        |
