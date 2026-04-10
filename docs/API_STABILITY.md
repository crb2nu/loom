# API Stability Policy (Loom VS Code Extension)

This document defines compatibility expectations for the `services/loom` extension.

Status: pre-`1.0.0` extension (`0.9.1` at time of writing).

## Scope

This policy covers extension-facing contracts in this repository:
- VS Code command IDs
- contributed view IDs
- `loom.*` configuration keys
- extension-to-`loom` CLI integration surface

It does not redefine `loom-core` policy; that remains owned by `loom-core`.

## Stability Levels

### Stable

These surfaces are expected to remain compatible across patch versions and usually across minor versions:

1. Command IDs contributed in `package.json` (`loom.*` command namespace).
2. Explorer view IDs (`loomHubOverview`, `loomServers`, `loomTools`, `loomSecrets`, `loomSkills`, `loomAgentContext`, `loomTasks`, `loomPlatforms`).
3. User settings keys under `loom.*` contributed in extension configuration.

Policy for stable surfaces:
- avoid renames/removals
- add new commands/settings additively
- if removal is necessary, keep an alias/compat path for at least one minor release

### Best-Effort Stable (Pre-1.0)

These are intended to be stable but may evolve while the extension is `<1.0.0`:

1. Loom runtime resources used by extension clients:
   - `loom://config`
   - `loom://servers`
   - `loom://health`
   - `loom://tools/index`
2. CLI invocation set used by extension clients:
   - `loom daemon start|stop|restart|status`
   - `loom servers --json` (primary) and `loom servers` (fallback)
   - `loom tools list`
   - `loom sync <platform> --regen`
3. Parsed output shapes used by `src/clients/daemon.ts` and `src/clients/platformConfig.ts`.

Policy for best-effort surfaces:
- prefer additive changes
- prefer resource-first and JSON-first adapters wherever available
- treat human-readable CLI parsing as fallback behavior, not the primary contract
- when changing output shape, update extension adapters/tests in the same release train
- document migration notes in `CHANGELOG.md`

### Internal / Unstable

These can change without compatibility guarantees:

1. Internal TypeScript module structure under `src/` (`clients/`, `managers/`, `providers/`, `webviews/`, `utils/`).
2. Internal log message formats in the Loom output channel.
3. Internal manager wiring and activation sequencing in `src/extension.ts`.

## Extension-to-Core Contract Boundary

The extension depends on `loom-core` CLI and daemon contracts. For any compatibility-sensitive change:

1. Treat command/flag/output/resource changes as contract changes.
2. Update extension adapters and tests in lockstep.
3. Prefer Loom MCP resources and `--json` command outputs for new automation surfaces.
4. Keep roadmap/backlog links current for API-impacting work.

Compatibility harness:
- `npm run compat:loom-core` validates the required command/field surface consumed by:
  - `src/clients/daemon.ts`
  - `src/clients/platformConfig.ts`
- The broader extension contract should also prefer runtime resources where the server exposes them.
- Contract inputs default to:
  - `compat/loom-core/contracts/cli/loom_commands.json`
  - `compat/loom-core/contracts/platform/platform_config_schema.json`
- CI executes this check in `compat:loom-core` for merge requests and default-branch pipelines.

## Breaking Change Process

When a breaking change is unavoidable:

1. Add an entry to `CHANGELOG.md` with migration notes.
2. Update this document if stability classification changes.
3. Update `ROADMAP.md` issue status/backlinks.
4. Validate with extension checks (`npm run check`, `npm test`) before merge.

## Change Checklist

For command/view/setting changes:

1. Update `package.json` contributions.
2. Update command/provider registration in `src/extension.ts` and command modules.
3. Update user docs (`README.md`, `AGENTS.md`, roadmap notes) as needed.
4. Verify no regressions in CLI integration flows.

## Sources

- `package.json:46`
- `package.json:265`
- `package.json:301`
- `package.json:346`
- `src/clients/daemon.ts:196`
- `src/clients/daemon.ts:299`
- `src/clients/daemon.ts:315`
- `src/clients/daemon.ts:380`
- `src/clients/platformConfig.ts:365`
- `src/extension.ts:8`
- `src/extension.ts:175`
- `ROADMAP.md:95`
- `/Users/cblevins/workspace/services/loom-core/docs/API_STABILITY.md:17`
- `/Users/cblevins/workspace/services/loom-core/docs/API_STABILITY.md:93`
