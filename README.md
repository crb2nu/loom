![Loom Banner](assets/banner.png)

# Loom - MCP Context Manager for VS Code

**Weaving context for AI** - Unified MCP hub management across VS Code, Antigravity, Gemini, Claude, Codex, and Kilocode.

## Overview

Loom is a VS Code extension that manages MCP (Model Context Protocol) server configurations across multiple AI coding assistant platforms. It provides:

- **Multi-platform sync**: Keep MCP configs consistent across 6 platforms
- **Hub integration**: Connect to centralized MCP gateway
- **Skills registry**: Browse and manage agent skills
- **Agent context**: Persistent memory across sessions
- **Server health**: Monitor MCP server status

## Features

### Platform Configuration Management (v0.7.0)

Manage MCP configurations for multiple AI assistants from a single interface:

| Platform | Config Format | Status |
|----------|---------------|--------|
| VS Code | JSON | Supported |
| Antigravity | JSON | Supported |
| Gemini | JSON | Supported |
| Claude | JSON | Supported |
| Codex | TOML | Supported |
| Kilocode | TOML | Supported |

**Platform Commands:**
- `Loom: Show Platform Configs` - View sync status for all platforms
- `Loom: Sync Platform Config` - Sync a single platform
- `Loom: Sync All Platforms` - Sync all enabled platforms
- `Loom: Show Sync Dashboard` - Visual sync status grid
- `Loom: Diff Platform Config` - Compare repo vs home configs

### MCP Hub Integration

Connect to centralized MCP gateway for server aggregation:

- **Hub Overview**: Registry metadata and server count
- **Server Status**: Live health polling
- **Routing**: Hub vs local server routing

### Skills Registry

Browse and manage agent skills:

- **Category filtering**: Filter by kubernetes, gitops, etc.
- **Platform filtering**: Show skills for specific platforms
- **Script execution**: Run skill scripts from VS Code
- **Resource access**: Open skill references and assets

### Agent Context (Persistent Memory)

Track context across sessions with mcp-agent-context:

- **Sessions**: Start/end agent work sessions
- **Context entries**: Record decisions, findings, questions
- **Tasks**: Track agent work items
- **Knowledge graph**: Visual context relationships

### Server Health Monitoring

Monitor MCP server health and performance:

- **Health dashboard**: Per-server status
- **Metrics collection**: Response times, error rates
- **Profile switching**: Quick server set changes

## Installation

### From VSIX

```bash
# Build the extension
cd services/loom
npm install
npm run package

# Install in VS Code
code --install-extension loom-0.7.0.vsix

# Or in Antigravity
antigravity --install-extension loom-0.7.0.vsix
```

### Development

```bash
cd services/loom
npm install
npm run watch
```

Press `F5` to launch the Extension Development Host.

## Configuration

### Settings

```json
{
  // Platform detection (auto | vscode | antigravity)
  "loom.platform": "auto",

  // Platforms to manage
  "loom.enabledPlatforms": ["vscode", "antigravity", "gemini", "claude"],

  // Auto-sync on startup
  "loom.syncOnStartup": false,

  // Sync status polling interval (ms)
  "loom.syncStatusPollingInterval": 60000,

  // MCP Hub URL
  "loom.hubUrl": "wss://mcp.flexinfer.ai/ws",

  // Hub profile
  "loom.hubProfile": "codex",

  // Drift detection behavior (off | prompt | auto)
  "loom.autoSyncOnDrift": "prompt",

  // Active server profile
  "loom.activeProfile": "full",

  // Custom server profiles
  "loom.profiles": {}
}
```

### Server Profiles

Define custom server profiles for quick switching:

```json
{
  "loom.profiles": {
    "minimal": {
      "servers": ["git", "filesystem"],
      "hubEnabled": false,
      "platforms": ["vscode"]
    },
    "k8s-ops": {
      "servers": ["k8s", "helm", "flux", "prometheus"],
      "hubEnabled": true,
      "platforms": ["vscode", "antigravity", "claude"]
    }
  }
}
```

## Views

Loom adds these views to the Explorer sidebar:

| View | Description |
|------|-------------|
| **Loom Platforms** | Platform config sync status |
| **Loom Hub** | MCP hub overview |
| **Loom Servers** | Running MCP servers |
| **Loom Tools** | Available MCP tools |
| **Loom Skills** | Skills registry browser |
| **Loom Secrets** | Configured secrets |
| **Loom Agent Context** | Session context entries |
| **Loom Tasks** | Agent task tracking |

## Commands

### Platform Management

| Command | Description |
|---------|-------------|
| `Loom: Show Platform Configs` | Refresh platform configs view |
| `Loom: Sync Platform Config` | Sync specific platform |
| `Loom: Sync All Platforms` | Sync all enabled platforms |
| `Loom: Diff Platform Config` | Show repo vs home diff |
| `Loom: Open Platform Config` | Open config in editor |
| `Loom: Show Sync Dashboard` | Visual sync status dashboard |

### Hub & Servers

| Command | Description |
|---------|-------------|
| `Loom: Refresh MCP Hub Status` | Poll hub status |
| `Loom: Check MCP Server Health` | Run health checks |
| `Loom: Show Server Health Dashboard` | Health metrics view |
| `Loom: Switch Server Profile` | Change active profile |

### Skills

| Command | Description |
|---------|-------------|
| `Loom: Refresh Skills` | Reload skills registry |
| `Loom: Search Skills` | Search by name/category |
| `Loom: Filter Skills by Platform` | Filter by target platform |
| `Loom: Show Skill Details` | View skill instructions |
| `Loom: Run Skill Script` | Execute skill script |

### Agent Context

| Command | Description |
|---------|-------------|
| `Loom: Start Agent Session` | Begin new session |
| `Loom: End Agent Session` | End current session |
| `Loom: Add Context Entry` | Record context |
| `Loom: Recall Context` | Search past context |
| `Loom: Show Knowledge Graph` | Visual context graph |

### Secrets

| Command | Description |
|---------|-------------|
| `Loom: List Secrets` | Show configured secrets |
| `Loom: Set Secret` | Add/update secret |
| `Loom: Validate Config Secrets` | Check for missing secrets |

## CLI Integration

Loom integrates with the `loom` CLI from loom-core:

```bash
# Check sync status
loom sync status

# Sync specific platform
loom sync vscode --regen
loom sync antigravity --regen
loom sync claude --regen

# Sync all platforms
for p in vscode antigravity codex claude gemini kilocode; do
  loom sync $p --regen
done
```

## Architecture

```
services/
├── loom/           # VS Code extension (TypeScript)
│   ├── src/
│   │   ├── clients/        # API clients
│   │   ├── commands/       # Command handlers
│   │   ├── providers/      # Tree view providers
│   │   ├── managers/       # Background managers
│   │   ├── webviews/       # Webview panels
│   │   └── utils/          # Utilities
│   └── package.json
└── loom-core/      # Backend (Go)
    └── cmd/loom/   # CLI tool
```

## See Also

- [Loom for Zed](../loom-zed/) — Zed extension providing MCP context server integration
- [loom-core](../loom-core/) — Backend Go binary powering the MCP ecosystem

## Related Documentation

- [AGENTS.md](AGENTS.md) - Agent working notes
- [ROADMAP.md](ROADMAP.md) - Project roadmap
- [CHANGELOG.md](CHANGELOG.md) - Version history
- [.agents/skills/mcp-config.md](../../.agents/skills/mcp-config.md) - MCP config guide

## Requirements

- VS Code 1.80.0+
- `loom` CLI from loom-core (for sync operations)
- Node.js 18+ (for development)

## License

MIT
