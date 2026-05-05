# Enable admin actions

Read-only views need only the HUD URL. **Mutations** — council dryrun/run, pipeline pause/resume/escalate, policy proposal apply/reject, backlog submit — additionally need the HUD admin token.

## Store the token securely

Run **Loom: Mills — Set Admin Token** from the command palette. The value is stored in VS Code's `SecretStorage` and never appears in settings (which sync across machines).

Every mutation pops a modal confirmation before firing. The token is fetched on demand and cached for the session. Use **Loom: Mills — Clear Admin Token** to wipe it.

## Try it out

Run **Loom: Mills — Council Dryrun** — it's the safest mutation (scratch DB, no commits) and exercises the full token + confirmation + admin-POST path end-to-end.
