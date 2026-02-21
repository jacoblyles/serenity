# MEMORY.md

## Preferences
- **Always use coding agent** for implementation work — never write code directly (Jacob, 2026-02-17)

## Project Status
- 2026-02-17: Updated popup (settings icon, latest models, removed stronger/reset buttons), simplified options page provider UI, removed OAuth. Committed to main.
- 2026-02-15: Created project doc in anastasis vault (`/Users/argos/anastasis/projects/Serenity.md`)
- Claude Code needs `/login` before coding agents will work
- **Maniple worker notifications**: `openclaw system event` doesn't work from inside Maniple workers (no gateway config). Instead, use `wait_idle_workers` with a background poll + `cron wake` to self-notify when workers finish.

## Vault Locations
- Default Obsidian vault: `/Users/argos/vault`
- Anastasis vault: `/Users/argos/anastasis` (working vault for this project)
- Serenity project docs: `/Users/argos/anastasis/projects/Serenity.md`
