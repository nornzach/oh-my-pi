# Editorial timeline phase QA

source visual truth: `/Users/zach/.codex/generated_images/019fdae8-f2ad-71d3-b711-caff48071410/exec-0e101bd5-7664-4030-80e0-ab3c3182e822.png`

reported implementation defect: `/var/folders/4g/qdz4d625641d0d8x4td6t2qm0000gp/T/codex-clipboard-a51f57a9-ec3c-4a77-ab39-b8e43c02a387.png`

post-fix implementation screenshot: `/tmp/omp-timeline-qa.ySCUHs/implementation.png`

full-view comparison: `/tmp/omp-timeline-qa.ySCUHs/full-comparison.png`

focused timeline comparison: `/tmp/omp-timeline-qa.ySCUHs/timeline-comparison.png`

viewport: 1187 x 768 CSS px, macOS Electron, light theme, compact transcript detail

pixel and density normalization: the source is 1635 x 962 px and the implementation is 1187 x 768 px, both captured at their app viewport density. The full-view board scales each image to 1000 px wide. The focused board compares the corresponding trace region after scaling both crops to 1000 px wide; its final size is 2048 x 663 px. Browser chrome is retained only in the full-view comparison.

reviewed state: the live `Audit renamed sessi` transcript at the updater verification sequence, with the two 03:14 execution phases, grouped `bash` / `hub` / `write` work, launch completion, previous-turn error, and composer visible. The source is an illustrative condensed transcript, so structural phase grouping and corresponding states were compared instead of treating live timestamps as literal source copy.

## Findings

- P2, fixed — Full-detail history rendered one checkpoint for every tool-bearing assistant message. Punctuation-only continuation messages therefore produced stacked green dots and repeated minute labels. The post-fix renderer derives semantic phases, keeps one marker at the narrated phase start, and aggregates every continuation tool id into that marker.
- P2, fixed — Compact history treated an uninterrupted tool run as one long phase, while the design starts a new phase at meaningful narration/reasoning. Compact grouping now flushes at narrated tool calls and keeps punctuation-only tool messages in the current phase.
- P2, fixed — The persisted event uses `customType: launch-completion`, but the marker logic only recognized the legacy `async-result` spelling. The real launch completion now renders the design's independent teal rocket marker.
- P3, follow-up — The live previous-turn error card uses its wire message as the sole visible line, while the source adds a small translated title above it. The red checkpoint, error wash, message, timestamp, and hierarchy remain clear, so this does not block the timeline correction.

## Required fidelity surfaces

- Fonts and typography: phase headings, monospaced commands/timestamps, tool weights, and duration alignment preserve the source hierarchy. Live Chinese/English content causes expected line-length differences only.
- Spacing and layout rhythm: each narrated phase owns one checkpoint; continuation tools share the phase rail and no longer create collisions. The rail, content inset, tool-row spacing, completion spacing, error width, and composer alignment remain consistent.
- Colors and visual tokens: completed, launch, and error states use the existing semantic success, launch-teal, and error tokens with the same white dot border treatment as the source.
- Image quality and asset fidelity: this surface contains no product imagery. Lucide status icons remain sharp at the captured density; no placeholder, CSS-art, or raster substitute was introduced.
- Copy and content: all live transcript text is preserved. Phase grouping changes presentation only; it does not merge, delete, or reorder message content.

## Comparison history

1. Initial evidence: the user screenshot showed separate green markers and duplicate `03:14` labels on adjacent tool messages, plus separate markers for `hub` and `write` continuations.
2. Fix: added semantic phase segmentation for compact rows, a pure full-detail marker coalescer, aggregated tool status propagation, and launch-completion recognition.
3. Post-fix evidence: the focused comparison shows two 03:14 phase markers, one shared marker for `bash + hub + write`, one teal launch marker, and one red error marker. No actionable P0/P1/P2 differences remain in the reviewed timeline state.

## Interaction and runtime verification

- Restarted the production-built Electron renderer.
- Expanded the workspace group, opened `Audit renamed sessi`, and used `Jump to latest` to reach the target state.
- Opened DevTools Console after hydration; the console was empty and reported no issues.
- TypeScript: `bun run check:types` passed.
- Scoped Biome check: `ChatStream.tsx` and `ChatStream.test.tsx` passed.
- Regression tests: 6 timeline/history tests passed, including the real filler-message phase boundary and launch-completion contract.
- Full GUI suite: 71 files, 634 tests passed.
- Production Electron build: passed.
- Packaged the arm64 production app as `omp-0.7.0-arm64.dmg`, verified both the app executable and bundled `omp` sidecar are arm64, installed it over `/Applications/omp.app`, and restarted it successfully.
- The installed app loaded its packaged `app.asar` renderer, reached the ready state without a white screen, and produced no new runtime-error log entries after launch.
- Package-wide `bun run check` still reports unrelated pre-existing formatting/lint findings in other dirty-worktree files; neither changed timeline file is among them.

final result: passed
