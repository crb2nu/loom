Agent Working Notes (loom)

Scope

- This file applies to the `services/loom` repository.

Repository Purpose

VSCode extension for MCP (Model Context Protocol) context management. Provides UI for managing MCP server connections and context switching.

Workspace Structure

This repo is part of the `services/` GitLab group:

```text
gitlab.flexinfer.ai/
├── platform/gitops    ← K8s manifests, Flux, CI infrastructure
└── services/
    ├── loom           ← YOU ARE HERE (VSCode extension)
    └── loom-core      ← Go backend (MCP servers, daemon, CLI)
```

Relationship to loom-core

- `loom` - VSCode extension (TypeScript, this repo)
- `loom-core` - Backend daemon and CLI (Go, separate repo)

The extension communicates with `loom-core` daemon for MCP server management.

Deployment

This is a VSCode extension, not a Kubernetes service. Distribution:

- Build `.vsix` package: `npm run package`
- Install locally: `code --install-extension loom-*.vsix`

No GitOps deployment required - this runs on developer machines.

Local Development

```bash
npm install
npm run compile
# Press F5 in VSCode to launch Extension Development Host
```

## Planning
- See `ROADMAP.md` for project status and plans.

