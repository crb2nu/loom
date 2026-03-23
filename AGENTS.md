# Agent Working Notes (loom)

## Scope

This file applies to the `services/loom` VS Code extension repository.

## Repository Purpose

VS Code extension for MCP (Model Context Protocol) context management. Provides UI for:

- Managing MCP server connections across multiple platforms
- Platform configuration sync (VS Code, Antigravity, Gemini, Claude, Codex, Kilocode, OpenCode, Zed)
- Skills registry browsing, filtering, and context-aware recommendations
- Agent context, session, and memory management
- Server health monitoring, metrics, and profiles
- Onboarding wizard for first-time setup
- Deep search across connected MCP servers

## Current Version: 0.9.0

### What's New in v0.9.0

- **Onboarding wizard**: First-run setup flow guiding users through initial configuration
- **Deep search**: Search across all connected MCP servers from a single query
- **Skill recommendations**: Context-aware skill suggestions based on active file, diagnostics, and workspace context
- **Server metrics**: Real-time health metrics, latency tracking, and history per server
- **Usage analytics**: Track tool usage patterns with a generated report command
- **Remote tunnels**: Managed `kubectl port-forward` commands for remote K8s MCP services
- **loom-core profiles**: Tool-profile selection sourced from `loom profile list/show`
- **Knowledge graph panel**: Visual exploration of agent context entities and relations
- **Memory dashboard**: Tiered memory view (working / short-term / long-term)

### What's New in v0.8.0

- **Error recovery**: Actionable error analysis with suggested remediation actions
- **Offline mode**: Graceful degradation when hub is unreachable
- **Config templates**: Daemon config auto-generation from extension settings
- **Bulk operations**: Start/stop/restart all servers at once
- **Agent sessions**: Automatic session management with namespace support
- **Code annotations**: In-editor decorations for agent context annotations
- **Annotation toggle**: Enable/disable annotation decorations from command palette

### v0.7.0 Features

- **Multi-platform support**: VS Code, Antigravity, Gemini, Claude, Codex, Kilocode, OpenCode, Zed
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
    ├── loom-zed       ← Zed editor extension (Rust)
    └── loom-core      ← Go backend (MCP servers, daemon, CLI)
```

## Relationship to Other Projects

| Component   | Purpose                          | Language   | Min Version             |
| ----------- | -------------------------------- | ---------- | ----------------------- |
| `loom`      | VS Code extension UI             | TypeScript | —                       |
| `loom-zed`  | Zed editor extension             | Rust       | v0.1.0                  |
| `loom-core` | Backend daemon, CLI, MCP servers | Go         | >= v0.7.0 (for `proxy`) |

The extension uses the `loom` CLI for:

- Config generation from registry
- Platform sync operations
- Server status queries
- Agent context operations (sessions, tasks, annotations)

### Shared Conventions

- **Asset naming**: `loom-core_{version}_{os}_{arch}.{tar.gz|zip}` (e.g. `loom-core_v0.9.1_darwin_arm64.tar.gz`)
- **Registry format**: YAML-based server definitions in `registry.yaml`

See also:

- [`services/loom-zed/AGENTS.md`](../loom-zed/AGENTS.md) — Zed extension
- [`services/loom-core/AGENTS.md`](../loom-core/AGENTS.md) — Go backend

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
npm run test:coverage # With coverage (thresholds: 70/70/60/70)
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
│   ├── context.ts     # Agent context commands
│   └── ...
├── providers/         # Tree view providers
│   ├── platforms.ts   # loomPlatforms view
│   ├── skills.ts      # loomSkills view
│   └── ...
├── managers/          # Background managers
│   ├── configSync.ts      # Drift detection
│   ├── hubStatus.ts       # Hub polling
│   ├── agentSession.ts    # Session lifecycle
│   ├── serverMetrics.ts   # Health metrics collection
│   ├── profileManager.ts  # Server profiles
│   ├── skillRecommendations.ts # Context-aware suggestions
│   ├── annotationDecoration.ts # Code annotation overlays
│   ├── deepSearch.ts      # Cross-server search
│   ├── usageAnalytics.ts  # Tool usage aggregation/reporting
│   └── remoteTunnel.ts    # Remote K8s tunnel lifecycle manager
├── webviews/          # Rich UI panels
│   ├── SyncDashboardPanel.ts
│   ├── OnboardingPanel.ts
│   ├── ServerHealthPanel.ts
│   ├── KnowledgeGraphPanel.ts
│   ├── MemoryDashboardPanel.ts
│   └── ContextGraphPanel.ts
├── utils/
│   ├── config.ts      # Hub settings, registry, daemon config
│   ├── errors.ts      # Actionable error analysis
│   ├── platform.ts    # Platform detection & registry
│   ├── binary.ts      # Binary resolution (loom, hub-wrapper)
│   ├── helpers.ts     # Misc utilities
│   ├── http.ts        # HTTP helpers
│   └── secrets.ts     # Secret management
├── types.ts           # Type definitions
└── extension.ts       # Entry point (activate/deactivate)
```

### Views Provided

| View ID            | Name               | Purpose                           |
| ------------------ | ------------------ | --------------------------------- |
| `loomPlatforms`    | Loom Platforms     | Platform config sync status       |
| `loomHubOverview`  | Loom Hub           | Registry servers                  |
| `loomServers`      | Loom Servers       | Running servers                   |
| `loomTools`        | Loom Tools         | Available tools                   |
| `loomSkills`       | Loom Skills        | Skills registry + recommendations |
| `loomSecrets`      | Loom Secrets       | Configured secrets                |
| `loomAgentContext` | Loom Agent Context | Session entries                   |
| `loomTasks`        | Loom Tasks         | Agent tasks                       |

## Platform Configuration

### Supported Platforms

| Platform    | Config Format | Repo Path               | Home Path                                          |
| ----------- | ------------- | ----------------------- | -------------------------------------------------- |
| VS Code     | JSON          | `.vscode/mcp.json`      | `~/Library/Application Support/Code/User/mcp.json` |
| Antigravity | JSON          | `.antigravity/mcp.json` | `~/.gemini/antigravity/mcp_config.json`           |
| Gemini      | JSON          | `.gemini/settings.json` | `~/.gemini/settings.json`                          |
| Claude      | JSON          | `.claude/mcp.json`      | `~/.claude/mcp.json`                               |
| Codex       | JSON          | `.codex/mcp.json`       | `~/.codex/mcp.json`                                |
| Kilocode    | JSON          | `.kilocode/mcp.json`    | `~/.kilocode/mcp.json`                             |
| OpenCode    | JSON          | `.opencode/opencode.json` | `~/.config/opencode/opencode.json`               |
| Zed         | JSON          | `.zed/mcp.json`         | `~/Library/Application Support/Zed/mcp.json`      |

### Sync Commands (via loom CLI)

```bash
loom sync status                    # Check all profiles
loom sync vscode --regen            # Regenerate & sync VS Code
loom sync antigravity --regen       # Regenerate & sync Antigravity
loom sync codex --regen             # Regenerate & sync Codex
loom sync opencode --regen          # Regenerate & sync OpenCode
loom pull zed                       # Pull Zed config back from home
loom doctor --json                  # Canonical drift/health report
```

### Extension Commands

| Command                       | Description                        |
| ----------------------------- | ---------------------------------- |
| `loom.showPlatformConfigs`    | Refresh platform configs view      |
| `loom.syncPlatformConfig`     | Sync specific platform             |
| `loom.syncAllPlatforms`       | Sync all enabled platforms         |
| `loom.diffPlatformConfig`     | Show repo vs home diff             |
| `loom.openPlatformConfig`     | Open config in editor              |
| `loom.showSyncDashboard`      | Open sync dashboard webview        |
| `loom.showDoctorReport`       | Show structured `loom doctor` report |
| `loom.filterSkillsByPlatform` | Filter skills by target            |
| `loom.showOnboarding`         | Open onboarding wizard             |
| `loom.deepSearch`             | Search across all MCP servers      |
| `loom.showUsageAnalytics`     | Open usage analytics report        |
| `loom.startRemoteTunnel`      | Start a configured remote tunnel   |
| `loom.stopRemoteTunnel`       | Stop the active remote tunnel      |
| `loom.remoteTunnelStatus`     | Show active tunnel status          |
| `loom.showKnowledgeGraph`     | Open knowledge graph panel         |
| `loom.showMemoryDashboard`    | Open memory dashboard              |
| `loom.toggleAnnotations`      | Toggle code annotation decorations |

## Settings

### All Settings

```json
{
  "loom.hubUrl": "wss://mcp.flexinfer.ai/ws",
  "loom.hubProfile": "codex",
  "loom.platform": "auto",
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
  "loom.syncOnStartup": false,
  "loom.syncStatusPollingInterval": 60000,
  "loom.autoSyncOnDrift": "prompt",
  "loom.activeProfile": "full",
  "loom.profiles": {},
  "loom.agentId": "vscode-loom",
  "loom.autoStartSession": false,
  "loom.showAnnotationDecorations": true,
  "loom.onboardingComplete": false,
  "loom.skillsRegistryPath": null,
  "loom.serverMetricsInterval": 30000,
  "loom.plugins": [],
  "loom.remoteTunnels": []
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

### Profile Model

- `loom.activeProfile` stores the selected loom-core profile name
- invalid configured profiles fall back to `full`
- `loom.profiles` is deprecated and ignored by runtime behavior
- drift and template/env health come from `loom doctor --json`

## Testing Locally

1. Build: `npm run compile`
2. Press F5 in VS Code to launch Extension Development Host
3. Open Loom views in the Explorer sidebar
4. Test commands via Command Palette (`Cmd+Shift+P`)

## Planning

See `ROADMAP.md` for project status and future plans.

<!-- BEGIN LOOM:AGENT-SAFETY -->
## Loom Agent Safety Policy (Generated)

- Pre-existing uncommitted/untracked files are baseline context, not an automatic blocker.
- Continue on the current branch/worktree by default.
- Stage and commit only files intentionally changed for the active task.
- Escalate only when new unexpected changes appear in files you are editing, or when a branch/worktree switch is explicitly requested.
- Dirty-worktree mode: `continue_scoped_commits`.

Canonical nudge for CLI hooks:
> Dirty worktree detected. Treat pre-existing changes as baseline context, continue work, and stage/commit only files for the active task. Escalate only if new unexpected changes appear in files you are editing.

<!-- END LOOM:AGENT-SAFETY -->
