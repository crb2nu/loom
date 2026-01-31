# Agent Working Notes (loom)

## Scope

This file applies to the `services/loom` VS Code extension repository.

## Repository Purpose

VS Code extension for MCP (Model Context Protocol) context management. Provides UI for:
- Managing MCP server connections across multiple platforms
- Platform configuration sync (VS Code, Antigravity, Gemini, Claude, Codex)
- Skills registry browsing and filtering
- Agent context and session management
- Server health monitoring

## Current Version: 0.7.0

Key features in v0.7.0:
- **Multi-platform support**: VS Code, Antigravity, Gemini, Claude, Codex, Kilocode
- **Platform detection**: Auto-detects VS Code vs Antigravity
- **Sync dashboard**: Visual status across all platforms
- **Skills filtering**: Filter by target platform

## Workspace Structure

This repo is part of the `services/` GitLab group:

```text
gitlab.flexinfer.ai/
├── platform/gitops    ← K8s manifests, Flux, MCP registry
│   └── mcp/context/registry.yaml  ← Server definitions
└── services/
    ├── loom           ← YOU ARE HERE (VSCode extension)
    └── loom-core      ← Go backend (MCP servers, daemon, CLI)
```

## Relationship to loom-core

| Component | Purpose | Language |
|-----------|---------|----------|
| `loom` | VS Code extension UI | TypeScript |
| `loom-core` | Backend daemon, CLI, MCP servers | Go |

The extension uses the `loom` CLI for:
- Config generation from registry
- Platform sync operations
- Server status queries

## Key Commands

### Development
```bash
npm install           # Install dependencies
npm run compile       # Build TypeScript
npm run watch         # Watch mode
npm run lint          # ESLint
npm run format        # Prettier
npm run check         # Full check (lint + format + tsc)
```

### Packaging
```bash
npm run package       # Build .vsix
code --install-extension loom-*.vsix  # Install locally
```

### Testing
```bash
npm test              # Run tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage
```

## Architecture

### Source Structure
```
src/
├── clients/           # API clients
│   ├── platformConfig.ts  # Multi-platform config management
│   ├── daemon.ts      # loom CLI communication
│   ├── hub.ts         # MCP hub HTTP client
│   ├── skills.ts      # Skills registry client
│   └── agentContext.ts # Agent session/context client
├── commands/          # Command handlers
│   ├── platforms.ts   # Platform sync commands
│   ├── skills.ts      # Skills commands
│   └── ...
├── providers/         # Tree view providers
│   ├── platforms.ts   # loomPlatforms view
│   ├── skills.ts      # loomSkills view
│   └── ...
├── managers/          # Background managers
│   ├── profileManager.ts  # Server profiles
│   ├── configSync.ts  # Drift detection
│   └── ...
├── webviews/          # Rich UI panels
│   ├── SyncDashboardPanel.ts
│   └── ...
├── utils/
│   ├── platform.ts    # Platform detection
│   └── ...
├── types.ts           # Type definitions
└── extension.ts       # Entry point
```

### Views Provided
| View ID | Name | Purpose |
|---------|------|---------|
| `loomPlatforms` | Loom Platforms | Platform config sync status |
| `loomHubOverview` | Loom Hub | Registry servers |
| `loomServers` | Loom Servers | Running servers |
| `loomTools` | Loom Tools | Available tools |
| `loomSkills` | Loom Skills | Skills registry |
| `loomSecrets` | Loom Secrets | Configured secrets |
| `loomAgentContext` | Loom Agent Context | Session entries |
| `loomTasks` | Loom Tasks | Agent tasks |

## Platform Configuration

### Supported Platforms
| Platform | Config Format | Repo Path | Home Path |
|----------|--------------|-----------|-----------|
| VS Code | JSON | `.vscode/mcp.json` | `~/Library/Application Support/Code/User/mcp.json` |
| Antigravity | JSON | `.antigravity/mcp.json` | `~/.antigravity/mcp.json` |
| Gemini | JSON | `.gemini/settings.json` | `~/.gemini/settings.json` |
| Claude | JSON | `.claude/mcp.json` | `~/.claude/mcp.json` |
| Codex | TOML | `.codex/config.toml` | `~/.codex/config.toml` |
| Kilocode | TOML | `.kilocode/config.toml` | `~/.kilocode/config.toml` |

### Sync Commands (via loom CLI)
```bash
loom sync status                    # Check all profiles
loom sync vscode --regen            # Regenerate & sync VS Code
loom sync antigravity --regen       # Regenerate & sync Antigravity
loom sync codex --regen             # Regenerate & sync Codex
```

### Extension Commands
| Command | Description |
|---------|-------------|
| `loom.showPlatformConfigs` | Refresh platform configs view |
| `loom.syncPlatformConfig` | Sync specific platform |
| `loom.syncAllPlatforms` | Sync all enabled platforms |
| `loom.diffPlatformConfig` | Show repo vs home diff |
| `loom.openPlatformConfig` | Open config in editor |
| `loom.showSyncDashboard` | Open sync dashboard webview |
| `loom.filterSkillsByPlatform` | Filter skills by target |

## Settings

### New in v0.7.0
```json
{
  "loom.platform": "auto",           // auto | vscode | antigravity
  "loom.enabledPlatforms": [         // Platforms to manage
    "vscode", "antigravity", "gemini", "claude"
  ],
  "loom.syncOnStartup": false,       // Auto-sync on extension start
  "loom.syncStatusPollingInterval": 60000  // Poll interval (ms)
}
```

### Existing Settings
```json
{
  "loom.hubUrl": "wss://mcp.flexinfer.ai/ws",
  "loom.hubProfile": "codex",
  "loom.autoSyncOnDrift": "prompt",  // off | prompt | auto
  "loom.activeProfile": "full",
  "loom.profiles": {}                // Custom server profiles
}
```

## Adding New Features

### Adding a New Platform
1. Add to `PlatformType` in `src/types.ts`
2. Add entry to `PLATFORMS` in `src/utils/platform.ts`
3. Update `loom.enabledPlatforms` enum in `package.json`
4. Test sync with `loom sync <platform> --regen`

### Adding a New Command
1. Add to `contributes.commands` in `package.json`
2. Create handler in appropriate `src/commands/*.ts`
3. Register in `extension.ts` or command registration file
4. Add to this documentation

## Testing Locally

1. Build: `npm run compile`
2. Press F5 in VS Code to launch Extension Development Host
3. Open Loom views in the Explorer sidebar
4. Test commands via Command Palette (`Cmd+Shift+P`)

## Planning

See `ROADMAP.md` for project status and future plans.
