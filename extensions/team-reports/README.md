# Team Reports (plugin)

Daily, weekly, and monthly team activity reports built from a GitHub organization's activity and
(optionally) a Discord guild, with model-written summaries. Reports are stored in a plugin-owned
SQLite database, served by the Gateway under a configurable route (default `/reports`), and shown
as a **Reports** tab in the Control UI.

See `docs/plugins/team-reports.md` for configuration and operation.
