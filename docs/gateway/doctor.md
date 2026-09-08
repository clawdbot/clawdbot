---
summary: "Doctor command: health checks, config migrations, and repair steps"
read_when:
  - Adding or modifying doctor migrations
  - Introducing breaking config changes
title: "Doctor"
sidebarTitle: "Doctor"
---

`openclaw doctor` is the repair and migration tool for OpenClaw. It fixes stale config/state, checks health, and provides actionable repair steps.

This page is an index. Doctor is documented on seven pages, one per reader job.
Open the page that matches your task.

## Doctor pages

| Page                                                                          | Read it when                                                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [Run doctor](/gateway/doctor/running)                                         | Run the command, pick automation flags, and read the read-only lint report.                                   |
| [What doctor checks](/gateway/doctor/checks)                                  | A summary of every repair, migration, and health check, grouped by area.                                      |
| [Config and migration repairs](/gateway/doctor/config-migrations)             | Checks 0-2: config normalization, the legacy config key table, and update-time schema publication.            |
| [Provider and route repairs](/gateway/doctor/provider-repairs)                | Checks 2b-2g: provider overrides, browser and Chrome MCP readiness, OAuth TLS, and route cleanup.             |
| [State, session, and plugin repairs](/gateway/doctor/state-and-sessions)      | Checks 3-7b: disk layout, cron store, session integrity, model auth, sandbox, and plugin installs.            |
| [Gateway, service, and security checks](/gateway/doctor/gateway-and-services) | Checks 8-17: service migrations, pairing, security warnings, workspace status, auth, health, and supervisors. |
| [Workspace tips and Dreams UI actions](/gateway/doctor/workspace-and-dreams)  | Checks 18-20, plus the Control UI Dreams backfill, reset, and clear actions.                                  |

## Where each section moved

Every section and check title from the previous single-page version keeps its
anchor here, so an existing link such as `/gateway/doctor#9-security-warnings`
still resolves. Each entry points at the page that now holds the content.

- <a id="quick-start" />[Quick start](/gateway/doctor/running#quick-start)
- <a id="headless-and-automation-modes" />[Headless and automation modes](/gateway/doctor/running#headless-and-automation-modes)
- <a id="schema-publication-during-a-2026.9.2-update" />[Schema publication during a 2026.9.2 update](/gateway/doctor/config-migrations#schema-publication-during-a-2026.9.2-update)
- <a id="read-only-lint-mode" />[Read-only lint mode](/gateway/doctor/running#read-only-lint-mode)
- <a id="what-it-does-(summary)" />[What it does (summary)](/gateway/doctor/checks#what-it-does-summary)
- <a id="dreams-ui-backfill-and-reset" />[Dreams UI backfill and reset](/gateway/doctor/workspace-and-dreams#dreams-ui-backfill-and-reset)
- <a id="detailed-behavior-and-rationale" />[Detailed behavior and rationale](/gateway/doctor#doctor-pages) — now five pages, listed above.
- <a id="schema-publication-during-a-2026-9-2-update" />[Schema publication during a 2026.9.2 update](/gateway/doctor/config-migrations#schema-publication-during-a-2026-9-2-update)
- <a id="what-it-does-summary" />[What it does (summary)](/gateway/doctor/checks#what-it-does-summary)
- <a id="yes" />[--yes](/gateway/doctor/running#yes)
- <a id="fix" />[--fix](/gateway/doctor/running#fix)
- <a id="lint" />[--lint](/gateway/doctor/running#lint)
- <a id="fix-force" />[--fix --force](/gateway/doctor/running#fix-force)
- <a id="non-interactive" />[--non-interactive](/gateway/doctor/running#non-interactive)
- <a id="deep" />[--deep](/gateway/doctor/running#deep)
- <a id="health-ui-and-updates" />[Health, UI, and updates](/gateway/doctor/checks#health-ui-and-updates)
- <a id="config-and-migrations" />[Config and migrations](/gateway/doctor/checks#config-and-migrations)
- <a id="state-and-integrity" />[State and integrity](/gateway/doctor/checks#state-and-integrity)
- <a id="gateway-services-and-supervisors" />[Gateway, services, and supervisors](/gateway/doctor/checks#gateway-services-and-supervisors)
- <a id="auth-security-and-pairing" />[Auth, security, and pairing](/gateway/doctor/checks#auth-security-and-pairing)
- <a id="workspace-and-shell" />[Workspace and shell](/gateway/doctor/checks#workspace-and-shell)
- <a id="0-optional-update-git-installs" />[0. Optional update (git installs)](/gateway/doctor/config-migrations#0-optional-update-git-installs)
- <a id="1-config-normalization" />[1. Config normalization](/gateway/doctor/config-migrations#1-config-normalization)
- <a id="2-legacy-config-key-migrations" />[2. Legacy config key migrations](/gateway/doctor/config-migrations#2-legacy-config-key-migrations)
- <a id="2b-opencode-provider-overrides" />[2b. OpenCode provider overrides](/gateway/doctor/provider-repairs#2b-opencode-provider-overrides)
- <a id="2c-browser-migration-and-chrome-mcp-readiness" />[2c. Browser migration and Chrome MCP readiness](/gateway/doctor/provider-repairs#2c-browser-migration-and-chrome-mcp-readiness)
- <a id="2d-oauth-tls-prerequisites" />[2d. OAuth TLS prerequisites](/gateway/doctor/provider-repairs#2d-oauth-tls-prerequisites)
- <a id="2e-codex-oauth-provider-overrides" />[2e. Codex OAuth provider overrides](/gateway/doctor/provider-repairs#2e-codex-oauth-provider-overrides)
- <a id="2f-codex-route-repair" />[2f. Codex route repair](/gateway/doctor/provider-repairs#2f-codex-route-repair)
- <a id="2g-session-route-cleanup" />[2g. Session route cleanup](/gateway/doctor/provider-repairs#2g-session-route-cleanup)
- <a id="3-legacy-state-migrations-disk-layout" />[3. Legacy state migrations (disk layout)](/gateway/doctor/state-and-sessions#3-legacy-state-migrations-disk-layout)
- <a id="3a-legacy-plugin-manifest-migrations" />[3a. Legacy plugin manifest migrations](/gateway/doctor/state-and-sessions#3a-legacy-plugin-manifest-migrations)
- <a id="3b-legacy-cron-store-migrations" />[3b. Legacy cron store migrations](/gateway/doctor/state-and-sessions#3b-legacy-cron-store-migrations)
- <a id="3c-session-lock-cleanup" />[3c. Session lock cleanup](/gateway/doctor/state-and-sessions#3c-session-lock-cleanup)
- <a id="3d-session-transcript-branch-repair" />[3d. Session transcript branch repair](/gateway/doctor/state-and-sessions#3d-session-transcript-branch-repair)
- <a id="4-state-integrity-checks-session-persistence-routing-and-safety" />[4. State integrity checks (session persistence, routing, and safety)](/gateway/doctor/state-and-sessions#4-state-integrity-checks-session-persistence-routing-and-safety)
- <a id="5-model-auth-health-oauth-expiry" />[5. Model auth health (OAuth expiry)](/gateway/doctor/state-and-sessions#5-model-auth-health-oauth-expiry)
- <a id="6-hooks-model-validation" />[6. Hooks model validation](/gateway/doctor/state-and-sessions#6-hooks-model-validation)
- <a id="7-sandbox-image-repair" />[7. Sandbox image repair](/gateway/doctor/state-and-sessions#7-sandbox-image-repair)
- <a id="7b-plugin-install-cleanup" />[7b. Plugin install cleanup](/gateway/doctor/state-and-sessions#7b-plugin-install-cleanup)
- <a id="8-gateway-service-migrations-and-cleanup-hints" />[8. Gateway service migrations and cleanup hints](/gateway/doctor/gateway-and-services#8-gateway-service-migrations-and-cleanup-hints)
- <a id="8b-startup-matrix-migration" />[8b. Startup Matrix migration](/gateway/doctor/gateway-and-services#8b-startup-matrix-migration)
- <a id="8c-device-pairing-and-auth-drift" />[8c. Device pairing and auth drift](/gateway/doctor/gateway-and-services#8c-device-pairing-and-auth-drift)
- <a id="9-security-warnings" />[9. Security warnings](/gateway/doctor/gateway-and-services#9-security-warnings)
- <a id="10-systemd-linger-linux" />[10. systemd linger (Linux)](/gateway/doctor/gateway-and-services#10-systemd-linger-linux)
- <a id="11-workspace-status-skills-plugins-and-taskflows" />[11. Workspace status (skills, plugins, and TaskFlows)](/gateway/doctor/gateway-and-services#11-workspace-status-skills-plugins-and-taskflows)
- <a id="11b-bootstrap-file-size" />[11b. Bootstrap file size](/gateway/doctor/gateway-and-services#11b-bootstrap-file-size)
- <a id="11c-shell-completion" />[11c. Shell completion](/gateway/doctor/gateway-and-services#11c-shell-completion)
- <a id="11d-stale-channel-plugin-cleanup" />[11d. Stale channel plugin cleanup](/gateway/doctor/gateway-and-services#11d-stale-channel-plugin-cleanup)
- <a id="12-gateway-auth-checks-local-token" />[12. Gateway auth checks (local token)](/gateway/doctor/gateway-and-services#12-gateway-auth-checks-local-token)
- <a id="12b-read-only-secretref-aware-repairs" />[12b. Read-only SecretRef-aware repairs](/gateway/doctor/gateway-and-services#12b-read-only-secretref-aware-repairs)
- <a id="13-gateway-health-check-restart" />[13. Gateway health check + restart](/gateway/doctor/gateway-and-services#13-gateway-health-check-restart)
- <a id="13b-memory-search-readiness" />[13b. Memory search readiness](/gateway/doctor/gateway-and-services#13b-memory-search-readiness)
- <a id="14-channel-status-warnings" />[14. Channel status warnings](/gateway/doctor/gateway-and-services#14-channel-status-warnings)
- <a id="15-supervisor-config-audit-repair" />[15. Supervisor config audit + repair](/gateway/doctor/gateway-and-services#15-supervisor-config-audit-repair)
- <a id="16-gateway-runtime-port-diagnostics" />[16. Gateway runtime + port diagnostics](/gateway/doctor/gateway-and-services#16-gateway-runtime-port-diagnostics)
- <a id="17-gateway-runtime-best-practices" />[17. Gateway runtime best practices](/gateway/doctor/gateway-and-services#17-gateway-runtime-best-practices)
- <a id="18-config-write-wizard-metadata" />[18. Config write + wizard metadata](/gateway/doctor/workspace-and-dreams#18-config-write-wizard-metadata)
- <a id="19-workspace-tips-backup-memory-system" />[19. Workspace tips (backup + memory system)](/gateway/doctor/workspace-and-dreams#19-workspace-tips-backup-memory-system)
- <a id="20-repointed-workspace-aliases" />[20. Repointed workspace aliases](/gateway/doctor/workspace-and-dreams#20-repointed-workspace-aliases)

## Related

- [Gateway runbook](/gateway)
- [Gateway troubleshooting](/gateway/troubleshooting)
