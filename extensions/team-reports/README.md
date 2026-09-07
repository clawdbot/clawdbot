# Team Reports

Official external OpenClaw plugin for daily, weekly, and monthly GitHub activity reports
with optional Discord discussion, model-written summaries, and a **Reports**
tab in the Control UI. Installed on demand (`openclaw plugins install @openclaw/team-reports`);
source checkouts load it from `extensions/team-reports`. Disabled by default.

Configure `plugins.entries.team-reports.config` with a GitHub token or
SecretRef, at least one organization, and team or inline identity entries.
Restart the Gateway after enabling the plugin or changing its configuration.

```sh
openclaw team-reports status --json
openclaw team-reports generate --intraday
openclaw team-reports list --json
```

Reports use UTC windows, remain in the plugin-owned SQLite store, and are
served behind Gateway authentication at `/reports/` by default. Model summary
calls are optional; set `summaries.enabled: false` for deterministic text.

See the [Team Reports guide](https://docs.openclaw.ai/plugins/team-reports)
for setup, configuration, attribution rules, exports, and troubleshooting.
