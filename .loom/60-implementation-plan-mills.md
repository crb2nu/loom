# Implementation Plan — Mills support in the Loom extension

> Date: 2026-05-04. Tracks extension work to expose loom-core's hive (renaming to **mills**) feature set in the Loom VS Code extension.

## Context

- loom-core has a mature feature (formerly hive, now mills): operator (`cmd/loom-mills-operator`), domain logic (`pkg/mills/{council,pipeline,audit,squads,crossrepo,adaptive,budget,gates,eval}`), HUD proxy at `/api/mills/*` (~30 routes), `loom mills` CLI, and the `mills-ops` MCP skill.
- Rename landed atomically in [services/loom-core!279](https://gitlab.flexinfer.ai/services/loom-core/-/merge_requests/279). Authoritative naming map: `services/loom-core/.loom/96-rename-hive-to-mills-naming-map-2026-05-04.md`.
- HUD admin token wiring fix in [services/loom-core!280](https://gitlab.flexinfer.ai/services/loom-core/-/merge_requests/280): preferred env `LOOM_HUD_ADMIN_TOKEN`, fallback `HUD_ADMIN_TOKEN`. Relevant to slice 4 only (read-only slices don't need admin token).
- Companion `platform/gitops` MR is the lockstep cluster-side flip (namespace `loom-mills`, ConfigMaps, secrets, PVC migration, Grafana dashboard, Prometheus alerts).
- The extension currently has zero coverage in `src/`.

## Naming strategy

Ship the extension under the **mills** name from day one. Rationale: avoid a forced rename pass, and never expose the old "hive" string to users.

| Layer | Name |
|---|---|
| User-facing strings (commands, view titles, walkthroughs, settings) | `Mills` |
| Files / symbols (`mills.ts`, `MillsClient`, `MillsTreeProvider`, `loom.mills.*` settings) | `mills` |
| Wire format (REST paths, env vars, metric names) | matches loom-core (locked, see below) |

Centralize all wire-format strings in `src/clients/millsTransport.ts`.

### Locked wire format (from naming map)

- REST base: `/api/mills`
- Env vars: `LOOM_MILLS_*` (operator URL is `LOOM_MILLS_OPERATOR_URL`)
- HUD admin token: `LOOM_HUD_ADMIN_TOKEN` (preferred), `HUD_ADMIN_TOKEN` (fallback) — slice 4
- Prometheus prefix: `loom_mills_*`
- Operator image: `registry.harbor.lan/mcp/loom-mills-operator`
- K8s namespace: `loom-mills`

## Transport posture

- Extension talks **only** to the HUD (`/api/hive/*` today, `/api/mills/*` post-rename). Never directly to the operator. Keeps double-auth guarantees and ensures the operator admin token never reaches the editor.
- Auth: HUD admin token via VS Code `SecretStorage`. HUD URL via `loom.mills.hudUrl` setting.

## Slicing

### v1 — Read-only (this release)

**Slice 1 — Foundation**
- `src/clients/millsTransport.ts` — single source of truth for paths, env vars, metric names.
- `src/clients/mills.ts` — typed REST client; methods for status, kpis, policy.
- Settings: `loom.mills.hudUrl`, admin token in `SecretStorage`.
- Status bar item: mills health (`enabled`, regression count, badge color on degradation).
- Command: `Loom: Show Mills Status`.

**Slice 2 — Tree views**
- New "Mills" tree view inside the existing Loom container with sub-trees:
  - Backlog (items, state, blocked_by)
  - Pipeline Runs (filterable by state)
  - Council Runs
  - Squads
  - Audit Findings
- Polling cadence with `onDidChangeTreeData`; reuse the extension's existing offline/error-recovery path.

**Slice 3 — Detail webviews**
- Council run detail (Loop A scores, ensemble, dryrun diff).
- Pipeline run detail (stages, MR link, k8s log deep-link).
- Audit finding detail.
- Policy proposal diff viewer (adaptive, view-only in v1).

### v1 — Mutations (shipped together with read-only slices)

**Slice 4 — Admin-token-gated actions** (delivered in the same MR as slices 1–3)
- `loom.mills.councilDryrun` / `councilRun`
- `loom.mills.pipelinePause` / `pipelineResume` / `pipelineEscalate`
- `loom.mills.proposalApply` / `proposalReject`
- `loom.mills.backlogSubmit`
- `loom.mills.setAdminToken` / `clearAdminToken` (SecretStorage-backed)
- Modal confirmations on every mutation; on-demand token prompt that stores the answer.

### v1.1 — Polish

**Slice 5 — Notifications + onboarding**
- Toast on new audit finding / regression spike.
- Walkthrough page: "Connect to Mills operator".
- Deep-links from notifications into tree nodes / webviews.

## Coordination — resolved

Rename landed in MR 279; naming map pinned above. Slice 1 ships directly against `/api/mills/*`, no bridge module needed.

## Open items

- Confirm where the "Mills" tree fits in the existing Loom view container vs. its own container (UX call after slice 1 status bar lands).
- Decide polling cadence for tree views (constant interval vs. backoff vs. SSE if HUD adds it).
- Decide whether to surface the `hive-ops` skill (renamed `mills-ops`) in the extension's skill recommendation flow.
