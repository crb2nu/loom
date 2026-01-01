# Project Roadmap

> Last Updated: January 2026

## Current Status

Loom (aka Codex Context Manager) is in **Preview**. It serves as the VS Code/Cursor/Kilocode extension that bridges the local development environment with the broader MCP ecosystem.

### Implemented Features
- ✅ **Registry Sync**: Generates `mcp.json` configs from a central `registry.yaml`.
- ✅ **Hub Integration**: Polling and status display for `mcp-gateway`.
- ✅ **Context Snapshotting**: `scripts/context/snapshot_qdrant.py` for RAG ingestion.
- ✅ **Health Checks**: Automated testing of MCP server connectivity.
- ✅ **UI**: Tree views for Hub Status and Server Lists.

## Upcoming Work

### Phase 1: Stability & Polish
- [ ] **Config Watcher**: Auto-reload when `registry.yaml` changes (currently manual sync).
- [ ] **Error Handling**: Better UI feedback when the Hub is unreachable.
- [ ] **Onboarding**: "Welcome" walkthrough for new users to set up their context.

### Phase 2: Advanced Context
- [ ] **Context Graph**: Visual node graph of connected MCP servers.
- [ ] **Deep Search**: Search across *all* connected MCP resources directly from VS Code.
- [ ] **Remote Tunnels**: Secure tunneling to remote k8s MCP servers (replacing `kubectl port-forward`).

## References

| Document | Purpose |
|----------|---------|
| [README.md](README.md) | Extension features and commands |
| [AGENTS.md](AGENTS.md) | Agent guidance |