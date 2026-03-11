![Loom Banner](https://gitlab.flexinfer.ai/services/loom/-/raw/main/assets/banner.png)

# Loom - MCP Context Manager for VS Code

**Weaving context for AI** - Unified MCP hub management across VS Code, Antigravity, Gemini, Claude, Codex, Kilocode, OpenCode, and Zed.

## Overview

Loom is a VS Code extension that manages MCP (Model Context Protocol) server configurations across multiple AI coding assistant platforms. It provides:

- **Multi-platform sync**: Keep MCP configs consistent across 8 platforms
- **Hub integration**: Connect to centralized MCP gateway
- **Skills registry**: Browse and manage agent skills
- **Agent context**: Persistent memory across sessions
- **Server health**: Monitor MCP server status
- **Remote tunnels**: Start secure local tunnels to remote K8s MCP services
- **Plugin support**: Load custom command/provider modules

## Features

### Platform Configuration Management (v0.7.0)

Manage MCP configurations for multiple AI assistants from a single interface:

| Platform    | Config Format | Status    |
| ----------- | ------------- | --------- |
| VS Code     | JSON          | Supported |
| Antigravity | JSON          | Supported |
| Gemini      | JSON          | Supported |
| Claude      | JSON          | Supported |
| Codex       | JSON          | Supported |
| Kilocode    | JSON          | Supported |
| OpenCode    | JSON          | Supported |
| Zed         | JSON          | Supported |

**Platform Commands:**

- `Loom: Show Platform Configs` - View sync status for all platforms
- `Loom: Sync Platform Config` - Sync a single platform
- `Loom: Sync All Platforms` - Sync all enabled platforms
- `Loom: Show Sync Dashboard` - Visual sync status grid
- `Loom: Diff Platform Config` - Compare repo vs home configs
- `Loom: Show Doctor Report` - Run `loom doctor --json` and inspect drift details

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

### Remote K8s Tunnels

Manage local `kubectl port-forward` tunnels to remote MCP services:

- **Named tunnel profiles**: Configure target context/namespace/service and ports
- **Start/stop commands**: Control tunnel lifecycle from the command palette
- **Hub URL sync**: Optionally set `loom.hubUrl` to the active local tunnel endpoint

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

### Pre-commit Hooks

Husky pre-commit hooks are enabled for this repository. After `npm install`, git hooks are installed automatically through the `prepare` script.

Current pre-commit behavior:

- runs `lint-staged` on staged files
- formats staged `*.{ts,tsx,js,json,md}` with Prettier
- runs ESLint `--fix` on staged `src/**/*.{ts,tsx}`

Run the same checks manually:

```bash
npx lint-staged
```

## VS Code Marketplace Release

Maintainer workflow for roadmap item `#3`:

1. Bump `package.json` version and update changelog.
2. Create and push a matching tag (`vX.Y.Z`).
3. Verify the tag pipeline builds the VSIX artifact in `package:vsix` and `release:publish`.
4. Trigger manual `release:marketplace` with `VSCE_PAT` configured in CI variables.

Local publish fallback:

```bash
export VSCE_PAT=...
npm ci
npm run package
sh scripts/publish-marketplace.sh
```

Safety checks in `scripts/publish-marketplace.sh`:

- requires `VSCE_PAT`
- validates `CI_COMMIT_TAG` matches `package.json` version when running in CI
- publishes an existing `loom-*.vsix` artifact (or builds one if absent)

## Antigravity Store Release

Maintainer workflow for roadmap item `#6`:

1. Bump `package.json` version and push tag `vX.Y.Z`.
2. Verify tag pipeline produces a VSIX in `package:vsix`.
3. Trigger manual `release:antigravity`.
4. Configure one publish mode in CI variables:
   - Open VSX mode: `OVSX_PAT` (optionally `ANTIGRAVITY_REGISTRY_URL`)
   - Direct upload mode: `ANTIGRAVITY_STORE_UPLOAD_URL` + `ANTIGRAVITY_STORE_TOKEN`

Local publish fallback:

```bash
npm ci
npm run package
export OVSX_PAT=...
sh scripts/publish-antigravity.sh
```

Safety checks in `scripts/publish-antigravity.sh`:

- validates `CI_COMMIT_TAG` matches `package.json` version when running in CI
- uses an existing `loom-*.vsix` artifact first, then builds if missing
- fails fast when required publish credentials are absent

## Configuration

### Settings

```json
{
  // Platform detection (auto | vscode | antigravity)
  "loom.platform": "auto",

  // Platforms to manage
  "loom.enabledPlatforms": [
    "vscode",
    "antigravity",
    "gemini",
    "claude",
    "codex",
    "kilocode",
    "opencode",
    "zed"
  ],

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

  // Optional plugin modules (package names or relative paths)
  "loom.plugins": ["./loom-plugin.cjs"],

  // Optional remote tunnel profiles for kubectl port-forward
  "loom.remoteTunnels": [
    {
      "name": "k3s-hub",
      "context": "kc-k3s",
      "namespace": "flexinfer-system",
      "service": "mcp-hub",
      "localPort": 37017,
      "remotePort": 80,
      "hubPath": "/ws",
      "autoSetHubUrl": true
    }
  ],

  // Active loom-core tool profile
  "loom.activeProfile": "full",

  // Deprecated legacy extension profiles (ignored)
  "loom.profiles": {}
}
```

### Plugin System

Loom can load optional plugin modules at startup from `loom.plugins`.

- Relative entries are resolved from the workspace root (for example `./loom-plugin.cjs`)
- Package entries are resolved from Node module resolution (for example `@my-org/loom-plugin`)
- Plugins can register commands, tree providers, tree views, and webview views/panels

Example plugin module:

```js
module.exports = {
  name: "example-plugin",
  activate(api) {
    api.registerCommand("loom.plugin.hello", () => {
      api.outputChannel.appendLine("Hello from Loom plugin");
    });
  },
};
```

### Loom-Core Profiles

The extension now treats loom-core as the source of truth for tool profiles.

- `loom.activeProfile` stores the selected loom-core profile name
- invalid values fall back to `full`
- `loom.profiles` is deprecated and ignored by the extension
- profile details shown in the UI come from `loom profile list` and `loom profile show <name>`

## Views

Loom adds these views to the Explorer sidebar:

| View                   | Description                 |
| ---------------------- | --------------------------- |
| **Loom Platforms**     | Platform config sync status |
| **Loom Hub**           | MCP hub overview            |
| **Loom Servers**       | Running MCP servers         |
| **Loom Tools**         | Available MCP tools         |
| **Loom Skills**        | Skills registry browser     |
| **Loom Secrets**       | Configured secrets          |
| **Loom Agent Context** | Session context entries     |
| **Loom Tasks**         | Agent task tracking         |

## Commands

### Platform Management

| Command                       | Description                   |
| ----------------------------- | ----------------------------- |
| `Loom: Show Platform Configs` | Refresh platform configs view |
| `Loom: Sync Platform Config`  | Sync specific platform        |
| `Loom: Sync All Platforms`    | Sync all enabled platforms    |
| `Loom: Diff Platform Config`  | Show repo vs home diff        |
| `Loom: Open Platform Config`  | Open config in editor         |
| `Loom: Show Doctor Report`    | Show `loom doctor --json`     |
| `Loom: Show Sync Dashboard`   | Visual sync status dashboard  |

### Hub & Servers

| Command                              | Description                 |
| ------------------------------------ | --------------------------- |
| `Loom: Refresh MCP Hub Status`       | Poll hub status             |
| `Loom: Check MCP Server Health`      | Run health checks           |
| `Loom: Show Server Health Dashboard` | Health metrics view         |
| `Loom: Switch Tool Profile`          | Change active loom-core profile |
| `Loom: Start Remote Tunnel`          | Start configured K8s tunnel |
| `Loom: Stop Remote Tunnel`           | Stop active tunnel          |
| `Loom: Show Remote Tunnel Status`    | Show active tunnel details  |

### Skills

| Command                           | Description               |
| --------------------------------- | ------------------------- |
| `Loom: Refresh Skills`            | Reload skills registry    |
| `Loom: Search Skills`             | Search by name/category   |
| `Loom: Filter Skills by Platform` | Filter by target platform |
| `Loom: Show Skill Details`        | View skill instructions   |
| `Loom: Run Skill Script`          | Execute skill script      |

### Agent Context

| Command                      | Description          |
| ---------------------------- | -------------------- |
| `Loom: Start Agent Session`  | Begin new session    |
| `Loom: End Agent Session`    | End current session  |
| `Loom: Add Context Entry`    | Record context       |
| `Loom: Recall Context`       | Search past context  |
| `Loom: Show Knowledge Graph` | Visual context graph |

### Secrets

| Command                         | Description               |
| ------------------------------- | ------------------------- |
| `Loom: List Secrets`            | Show configured secrets   |
| `Loom: Set Secret`              | Add/update secret         |
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
loom sync opencode --regen
loom sync zed --regen

# Pull a generated config back from a home directory
loom pull vscode

# Inspect cross-platform drift and template/env issues
loom doctor --json

# Sync all platforms
for p in vscode antigravity codex claude gemini kilocode opencode zed; do
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
- [docs/API_STABILITY.md](docs/API_STABILITY.md) - Stable vs internal API policy
- [.agents/skills/mcp-config.md](../../.agents/skills/mcp-config.md) - MCP config guide

## Requirements

- VS Code 1.80.0+
- `loom` CLI from loom-core (for sync operations)
- Node.js 18+ (for development)

## License

MIT
