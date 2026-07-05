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
- (approaches that succeeded)

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
- Project: "serenity" — Chrome extension (MV3) that auto-applies night mode to sites lacking one.
- Chosen approach (2026-07-05): deterministic, local CSS transformation — no LLM at runtime.
  Core engine = invert(1) hue-rotate(180deg) filter on html with counter-inversion for
  images/video/canvas + color-scheme: dark, injected at document_start (no white flash).
  Skip sites that are already dark (luminance detection). Per-site toggle + sliders in popup.
- Dark Reader-style dynamic palette engine (parse stylesheets, rewrite colors) filed as
  future/stretch work, not in v1 scope.
