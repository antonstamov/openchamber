# Fork merge job prompt

You are merging the upstream `main` branch into this fork's `main-ru` branch (see `.opencode/agent/fork-merge.md` for the full standing instructions, glossary, and rules).

Current state (the workflow appends the mode after this file):

- The worktree is on `main-ru`.
- FULL MERGE mode: no merge is in progress. Start it yourself (`git merge upstream/main`), resolve, verify, commit.
- FIX MODE: upstream/main is already merged into the worktree and the checks are red. Do not start a new merge; only fix what is red.
- In both modes whoever did the merge commits it with `Merge remote-tracking branch 'upstream/main' into main-ru`. Do not push, do not tag.

Finish the merge, verify it, and commit it. The exact steps:

1. Inspect the merge: `git status --short`, and for conflicts the marker regions.
2. Resolve every conflict per the fork delta (keep `ru`, drop `uk`, translate new English keys to Russian, keep fork feed URLs, fork workflows, and fork scripts). For modify/delete conflicts on a file this fork deliberately removed (Ukrainian locale, forked-out infrastructure), keep the deletion with `git rm <file>` — do not restore the upstream version.
3. Run `bun test packages/ui/src/lib/i18n/` and `bun check -b`. If the merge touches web server code, run the focused vitest suites (`bunx vitest run <file>` from `packages/web`); for Electron files, the relevant `node --test` suites. Translate EVERY missing key the parity test lists and delete EVERY stale key it lists — dozens is normal after a big upstream batch; work the full list, not a sample. Re-run the suite yourself until it passes; ending the run with red tests and no changes is a failure, not a result. All green or stop.
4. Commit with `git commit -m "Merge remote-tracking branch 'upstream/main' into main-ru"` (non-interactive; never bare `git commit`). Do not push, do not tag.

If anything cannot be resolved with confidence, stop with the worktree as is, print what is unresolved and why, and exit non-zero.
