---
name: gui-release
description: Run the standardized omp GUI release pipeline end to end — upstream sync, version bump, sidecars for all three platforms, macOS installers, GitHub Release, CI verification, wiki, and issue follow-up. Invoke for "发布新版本", "release", "发版".
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

# omp GUI Release

Canonical procedure: `packages/gui/AGENTS.md` → **Release Runbook**, phases 0–7, in order. This skill adds the operational details accumulated across releases — read the runbook first, then work the phases with the notes below.

Version/tag/commit conventions: semver `X.Y.Z`, tag `vX.Y.Z`, release commit `release(gui): vX.Y.Z`, no AI attribution trailers.

## Phase 0 — Preconditions

- GUI repo (`packages/gui`) clean and on `main`; monorepo clean except intentional `?? packages/gui/`.
- `gh issue list --repo nornzach/oh-my-pi-gui` — fold replies/closures for issues this release fixes into the plan.
- Pick the version; draft changelog bullets.

## Phase 1 — Upstream sync (mandatory)

Invoke the `upstream-sync` skill — never a hand-rolled merge. The release's sidecar must carry current upstream.

## Phase 2 — Release prep (inside packages/gui)

- `package.json` version bump.
- `CHANGELOG.md`: add the release section. **Keep the `[Unreleased]` heading** — deleting it breaks `ChangelogDialog` tests (this has happened).
- `README.md`: update version references and BOTH "What's new" blocks (English + 中文 keep in sync). The downloads badge URL is tag-agnostic — no edit needed.
- `site/index.html`: bump the no-JS fallback version/download links (runtime values resolve from the releases API).
- Verify: `bunx vitest run`, `bun run check:types`, `bun run build`, `bunx biome check <touched>`.

## Phase 3 — Commit, tag, push (GUI repo only)

`git commit -am "release(gui): vX.Y.Z" && git tag vX.Y.Z && git push origin main && git push origin vX.Y.Z`

Tag push does NOT build Win/Linux — those workflows fire on `release: published` (Phase 6).

## Phase 4 — Sidecars

- `bun run build:omp` → `resources/omp` (arm64; may already exist from the sync).
- `bun run build:omp:x64` → `resources/omp.x64`. **Known failure**: fetching `pi-natives-darwin-x64` via `bun add` hits TLS interception (`DEPTH_ZERO_SELF_SIGNED_CERT`) and npmmirror times out. Workaround: `npm pack pi-natives-darwin-x64@<ver> --registry https://registry.npmjs.org`, untar into the script's natives cache dir, re-run — the script prefers the cache.
- Windows sidecar: built by CI from `sidecar-source.json`'s monorepo pin — **no local `omp.exe` needed**.
- Verify: `file resources/omp resources/omp.x64` (arch match) and `--version` shows the expected `omp/X.Y.Z`.

## Phase 5 — Installers

- `bun run package:mac:arm64 -- --publish never` and `bun run package:mac:x64 -- --publish never` (dedicated x64 config — never plain `package:mac`).
- Check each app: adhoc+hardened-runtime signature, `file` on the embedded sidecar matches the package arch, and all ~58 locale `.pak` files are present (missing locale files caused the Windows blank-window bug).
- **`latest-mac.yml` must cover BOTH arches** — the x64 build overwrites it; merge in the arm64 entries (sha512 + size for all four files). A single-arch `latest-mac.yml` silently breaks updates for the missing arch.
- Smoke test: if an installed omp.app is running, a second instance exits silently via the single-instance lock — that's expected, not a crash. Instead smoke the **packaged sidecar binary**: `bun scripts/smoke-sidecar.mjs <app>/Contents/Resources/omp` (expects READY + RPC responses). Never launch with `ELECTRON_RUN_AS_NODE` set.

## Phase 6 — Publish

- `gh release create vX.Y.Z --repo nornzach/oh-my-pi-gui` with changelog body; record the monorepo commit the sidecars were built from.
- Upload the 9 mac assets (2 DMG, 2 ZIP, `latest-mac.yml`, blockmaps). Publishing triggers `release-windows` + `release-linux` CI which attach the rest → **16 assets total** when done.
- Never commit sidecar binaries. Never push to `upstream`.

## Phase 7 — Post-release

- Wait for Win/Linux CI (~5–6 min each); confirm 16 assets and that published `latest-mac.yml` still has all four file entries.
- Site auto-resolves the version from the releases API — verify it displays the new version.
- **Wiki**: update version strings in Home.md / Installation / FAQ / the release page. Clone `https://github.com/nornzach/oh-my-pi-gui.wiki.git` to a sibling dir if absent. GitHub rejects pushes from private emails — set both identities per commit:
  `GIT_AUTHOR_NAME=… GIT_AUTHOR_EMAIL=<id>+nornzach@users.noreply.github.com GIT_COMMITTER_NAME=… GIT_COMMITTER_EMAIL=<same> git commit …`
- Reply/close issues the release fixes (get the user's go-ahead on wording per the monorepo AGENTS.md GitHub rules).
- Monorepo `bun.lock` often follows the GUI version bump — commit it at the monorepo root so the tree is clean.
