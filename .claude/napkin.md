# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|
| 2026-07-05 | self | Assumed pb state lives per-worktree; monitored the worker's worktree .pebbles and concluded the worker wasn't closing issues (sent a needless nudge) | pb resolves its store via the git common dir — all worktrees share the MAIN repo's .pebbles/events.jsonl. Check status in the main repo, and don't ask workers to commit events.jsonl from a worktree (they can't) |

## User Preferences
- Workflow: plan → detailed pebbles → farm coding to a codex worker via Maniple → review the returned work.
- Commit .pebbles files before spawning workers.
- Keep scope small; this is intended as a relatively small project.

## Patterns That Work
- Codex worker via Maniple with detailed per-task pebbles produced good v1 quality in one
  pass (~800 lines, clean structure); review still found 2 real bugs the specs didn't
  anticipate (detection reading our own injected background; picture+img double filter).
  Detailed specs + a real review round is the right division of labor.
- Merging a worker branch: .pebbles/events.jsonl always conflicts and NEITHER side is a
  superset (worker's pb writes enriched close events to its branch copy AND plain ones to
  the shared store). Resolve by union + dedupe exact lines + stable sort by timestamp,
  then validate with `pb list --all`.

## Tool/Environment Notes
- Maniple + codex workers: wait_idle_workers reports idle almost immediately
  (codex JSONL idle detection flaps between turns) — don't trust it for
  "work finished". Poll the worker's worktree instead (pb closed count +
  git log) via a Monitor, and examine_worker for the last assistant message.
- Worker worktrees land at <repo>/.worktrees/<issue>- and commit to an
  ephemeral branch; merge to main after review, then delete the branch.

## Patterns That Don't Work
- LLM-generated per-site dark stylesheets at page load: too slow (user tried it).
- Caching LLM-generated stylesheets per site with a regenerate button: also didn't work well (user tried it).

## Domain Notes
- Substack (user's key site) styles with wide-gamut colors: computed backgroundColor
  serializes as color(display-p3 ...) not rgb(). Any color parsing in this project must
  handle color(srgb|display-p3 ...) and space-separated rgb() (fixed 2026-07-05).
- claude-in-chrome drives a separate automation Chrome profile: no user extensions, no
  logins. Extension QA there requires the user to Load-unpack Serenity into that profile.
- Detection verdicts cache in chrome.storage.local for 7 days; until serenity-eda lands
  there is no UI to clear a stale verdict (workaround: set site to Always on).
- Project: "serenity" — Chrome extension (MV3) that auto-applies night mode to sites lacking one.
- Chosen approach (2026-07-05): deterministic, local CSS transformation — no LLM at runtime.
  Core engine = invert(1) hue-rotate(180deg) filter on html with counter-inversion for
  images/video/canvas + color-scheme: dark, injected at document_start (no white flash).
  Skip sites that are already dark (luminance detection). Per-site toggle + sliders in popup.
- Dark Reader-style dynamic palette engine (parse stylesheets, rewrite colors) filed as
  future/stretch work, not in v1 scope.
