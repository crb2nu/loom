![Loom Banner](assets/banner.png)

# Codex Context Manager (Preview)

Workspace tooling to surface Codex/Kilocode context and keep MCP server definitions synchronized across the CLI, VS Code extension, and Kilocode client.

## Status

- **Stage:** Hub-aware UI with registry + generator integration
- **Highlights:**
  - Canonical registry at `mcp/context/registry.yaml`
  - Hub-facing tree views (**MCP Hub Overview**, **MCP Hub Servers**) that poll gateway `/health`, `/ready`, and `/api/servers`
  - Generator `scripts/mcp/generate_mcp_configs.py --emit --hub-mode` produces target-specific artifacts under `generated/mcp/`
  - Hub settings (`codexContextManager.hubUrl`, `codexContextManager.hubProfile`) feed both UI status and generator invocations
  - Local `vsce` dev dependency for hassle-free packaging (`npm run package`)

## Current Commands

| Command | Description |
| ------- | ----------- |
| `Codex: Show Context Status` | Summarises registry metadata (server count/version). |
| `Codex: Show MCP Mesh Report` | Prints registry ↔ hub ↔ VS Code coverage and hub/local routing details to the `Codex MCP Mesh` channel. |
| `Codex: Sync MCP Configs` | Invokes the Python generator in hub mode, runs Codex/Kilocode sync scripts, and refreshes `.vscode/mcp.json` from generated output. |
| `Codex: Check MCP Server Health` | Runs `test_mcp_servers.py` and streams results to the `Codex MCP Health` output channel. |
| `Codex: Snapshot Context to Qdrant` | Invokes `scripts/context/snapshot_qdrant.py` to embed documentation and upsert into Qdrant for retrieval. |
| `Codex: Bootstrap Workspace Context` | Generator → sync scripts → MCP cache warm-up → Qdrant snapshot (one-shot onboarding). |
| `Codex: Refresh MCP Hub Status` | Polls hub `/health`, `/ready`, and `/api/servers` and refreshes tree views. |
| `Codex: Verify MCP Hub Client` | Confirms `mcp-hub-wrapper` is available (pyenv/Path-aware) for hub-mode configs. |

The sync command honours the `CM_PYTHON_EXECUTABLE` environment variable (defaults to `python3`).

## Registry-Driven Generation

- The registry captures per-server defaults in `common`, with overrides for `codex`, `kilocode`, and `vscode` targets. Current coverage includes Tavily, Context7, GitHub, Kubernetes/ops servers, SequentialThinking, Time, and Qdrant.

## Qdrant Snapshot Workflow

`Codex: Snapshot Context to Qdrant` relies on:
- `MORPH_API_KEY` for embedding via Morph
- `QDRANT_URL`/`QDRANT_API_KEY` environment (or keychain entry for Codex)

The script scans `docs/`, `research/`, `README.md`, `PLAN.md`, and `AGENTS.md`, chunks content to ~1.2K characters, embeds in batches, ensures the target collection exists, then upserts payloads with file metadata. Adjust patterns by passing `--glob` arguments inside `.vscode/tasks.json` or invoking the script directly.
- Generator output:
  - `generated/mcp/codex/config.toml`
  - `generated/mcp/kilocode/config.toml`
  - `generated/mcp/vscode/mcp.json`
- Paths declared as `scripts/...` or `mcp/...` are expanded to absolute workspace paths for emitted artifacts.

## Development

```bash
cd services/codex-context-manager
npm install
npm run watch
```

Launch the extension via `F5` (Extension Development Host). Use the explorer views **MCP Hub Overview** and **MCP Hub Servers** to inspect registry and live hub data.

### Packaging

```bash
cd services/codex-context-manager
npm run compile          # optional preflight
npm run package          # uses local @vscode/vsce
```

Install the generated `.vsix` via VS Code: **Extensions: Install from VSIX…**.
