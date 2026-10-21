---
name: upstream-sync
description: Merge can1357/oh-my-pi upstream into the monorepo fork, resolve conflicts the fork-safe way, rebuild the GUI sidecar, and verify. Invoke for "拉上游", "同步上游", "sync upstream", or before any GUI release.
triggers:
  - user
  - model
allowed-tools:
  - read
  - edit
  - grep
  - glob
  - exec
---

# Upstream Sync

Syncs `upstream` (can1357/oh-my-pi) into this monorepo fork and rebuilds the GUI sidecar so `packages/gui` embeds current agent code.

## Repos — never confuse them

| Remote | Repo | Direction |
|---|---|---|
| `origin` | `nornzach/oh-my-pi` (fork) | push all monorepo work here |
| `upstream` | `can1357/oh-my-pi` | fetch/merge only — **NEVER push** |
| `packages/gui/.git` | `nornzach/oh-my-pi-gui` | separate repo; sync only pins a sidecar commit there |

## Procedure

1. Verify both checkouts are clean: `git status` at monorepo root (expect only `?? packages/gui/`) and `git -C packages/gui status`.
2. Run `bash packages/gui/scripts/sync-upstream.sh`. It fetches upstream, lists incoming commits, merges `upstream/main`, runs `bun install`, re-provisions `pi_natives` on version bump, rebuilds the sidecar, and runs the GUI build + tests.
3. On merge conflict: resolve at the **monorepo root**, commit the merge, then resume with `SKIP_MERGE=1 bash packages/gui/scripts/sync-upstream.sh`.

## Conflict resolution rules (learned from real merges)

- **NEVER `git add -A` to commit a merge** — it stages `packages/gui` as a nested gitlink. Stage specific paths, or if the gitlink slipped in: `git rm --cached packages/gui` then `git commit --amend`.
- **Preserve fork-owned fields** when both sides touched the same code:
  - session metadata `kind` (the GUI uses it to tell pure-chat sessions apart)
  - `parentSubagentId` in structured-subagent plumbing
  - `queue_update` structured entries (`{id, text}` — the GUI's queued bubbles edit/delete by id). When upstream code compares queue entries as strings, compare `.text`.
  - the `!parsed.chat && !parsed.noAutoResume` guard in `main.ts` (GUI rpc-ui chat sessions rely on it not being auto-resumed); keep it around upstream additions like `forkIfMovedAway`.
- **Accept upstream deletions/renames** when the fork only carries the old name (e.g. `driveSessionToYield` → `driveSessionToResult`, removed codex Code Mode code). Don't resurrect deleted code the fork never extended.
- Format/lint resolved monorepo files with `bunx oxfmt` / `bunx oxlint` (from `packages/coding-agent`) — **never the GUI's Biome**; a Biome `--write` once added ~4k lines of formatting churn vs upstream.

## Verification

1. `bun run --cwd packages/coding-agent check:types` (tsgo) must pass — a structured-vs-string `queue_update` comparison once slipped through as the only type error.
2. Relevant tests: run the test files covering conflict areas. If failures appear, **compare against a pre-merge baseline** rather than assuming regressions:
   - `git worktree add /tmp/omp-baseline <pre-merge-fork-sha>` and run the same files there.
   - Known pattern: this suite has ~20 pre-existing failures plus tests that run within ~1s of their 5s timeout and flake under batch load. A failure counts as a merge regression only if it's absent on baseline AND reproducible standalone.
3. Sync script output: `resources/omp --version` (or `bun scripts/smoke-sidecar.mjs`) shows the new `omp/<ver>`; GUI `vitest` suite green.

## Finish

1. Push monorepo to the **fork**: `git push origin main` at monorepo root. The local branch may track `upstream/main` — always confirm the push target is `origin`, never `upstream`.
2. Commit the GUI sidecar pin inside `packages/gui`: `chore: bump bundled omp sidecar to upstream v<X> merge (<sha>)` — the pinned monorepo commit must already be pushed to the fork first, since CI reproduces the sidecar from `sidecar-source.json`'s pin.
3. Both repos clean at the end.
