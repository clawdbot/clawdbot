---
summary: "CLI reference for `openclaw security` (audit and fix common security footguns)"
read_when:
  - You want to run a quick security audit on config/state
  - You want to apply safe "fix" suggestions (permissions, tighten defaults)
title: "Security"
---

# `openclaw security`

Security tools (audit + optional fixes).

Related:

- Security guide: [Security](/gateway/security)

## Audit

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --deep --password <password>
openclaw security audit --deep --token <token>
openclaw security audit --fix
openclaw security audit --json
```

Plain `security audit` stays on the cold config/filesystem/read-only path. It does not discover plugin runtime security collectors by default, so routine audits do not load every installed plugin runtime. Use `--deep` to include best-effort live Gateway probes and plugin-owned security audit collectors; explicit internal callers may also opt into those plugin-owned collectors when they already have an appropriate runtime scope.

The audit warns when multiple DM senders share the main session and recommends **secure DM mode**: `session.dmScope="per-channel-peer"` (or `per-account-channel-peer` for multi-account channels) for shared inboxes.
This is for cooperative/shared inbox hardening. A single Gateway shared by mutually untrusted/adversarial operators is not a recommended setup; split trust boundaries with separate gateways (or separate OS users/hosts).
It also emits `security.trust_model.multi_user_heuristic` when config suggests likely shared-user ingress (for example open DM/group policy, configured group targets, or wildcard sender rules), and reminds you that OpenClaw is a personal-assistant trust model by default.
For intentional shared-user setups, the audit guidance is to sandbox all sessions, keep filesystem access workspace-scoped, and keep personal/private identities or credentials off that runtime.
It also warns when small models (`<=300B`) are used without sandboxing and with web/browser tools enabled.
For webhook ingress, it warns when `hooks.token` reuses the Gateway token, when `hooks.token` is short, when `hooks.path="/"`, when `hooks.defaultSessionKey` is unset, when `hooks.allowedAgentIds` is unrestricted, when request `sessionKey` overrides are enabled, and when overrides are enabled without `hooks.allowedSessionKeyPrefixes`.
It also warns when sandbox Docker settings are configured while sandbox mode is off, when `gateway.nodes.denyCommands` uses ineffective pattern-like/unknown entries (exact node command-name matching only, not shell-text filtering), when `gateway.nodes.allowCommands` explicitly enables dangerous node commands, when global `tools.profile="minimal"` is overridden by agent tool profiles, when open groups expose runtime/filesystem tools without sandbox/workspace guards, and when installed plugin tools may be reachable under permissive tool policy.
It also flags `gateway.allowRealIpFallback=true` (header-spoofing risk if proxies are misconfigured) and `discovery.mdns.mode="full"` (metadata leakage via mDNS TXT records).
It also warns when sandbox browser uses Docker `bridge` network without `sandbox.browser.cdpSourceRange`.
It also flags dangerous sandbox Docker network modes (including `host` and `container:*` namespace joins).
It also warns when existing sandbox browser Docker containers have missing/stale hash labels (for example pre-migration containers missing `openclaw.browserConfigEpoch`) and recommends `openclaw sandbox recreate --browser --all`.
It also warns when npm-based plugin/hook install records are unpinned, missing integrity metadata, or drift from currently installed package versions.
It warns when channel allowlists rely on mutable names/emails/tags instead of stable IDs (Discord, Slack, Google Chat, Microsoft Teams, Mattermost, IRC scopes where applicable).
It warns when `gateway.auth.mode="none"` leaves Gateway HTTP APIs reachable without a shared secret (`/tools/invoke` plus any enabled `/v1/*` endpoint).
Settings prefixed with `dangerous`/`dangerously` are explicit break-glass operator overrides; enabling one is not, by itself, a security vulnerability report.
For the complete dangerous-parameter inventory, see the "Insecure or dangerous flags summary" section in [Security](/gateway/security).

SecretRef behavior:

- `security audit` resolves supported SecretRefs in read-only mode for its targeted paths.
- If a SecretRef is unavailable in the current command path, audit continues and reports `secretDiagnostics` (instead of crashing).
- `--token` and `--password` only override deep-probe auth for that command invocation; they do not rewrite config or SecretRef mappings.

## JSON output

Use `--json` for CI/policy checks:

```bash
openclaw security audit --json | jq '.summary'
openclaw security audit --deep --json | jq '.findings[] | select(.severity=="critical") | .checkId'
```

If `--fix` and `--json` are combined, output includes both fix actions and final report:

```bash
openclaw security audit --fix --json | jq '{fix: .fix.ok, summary: .report.summary}'
```

## What `--fix` changes

`--fix` applies safe, deterministic remediations:

- flips common `groupPolicy="open"` to `groupPolicy="allowlist"` (including account variants in supported channels)
- when WhatsApp group policy flips to `allowlist`, seeds `groupAllowFrom` from
  the stored `allowFrom` file when that list exists and config does not already
  define `allowFrom`
- sets `logging.redactSensitive` from `"off"` to `"tools"`
- tightens permissions for state/config and common sensitive files
  (`credentials/*.json`, `auth-profiles.json`, `sessions.json`, session
  `*.jsonl`)
- also tightens config include files referenced from `openclaw.json`
- uses `chmod` on POSIX hosts and `icacls` resets on Windows

`--fix` does **not**:

- rotate tokens/passwords/API keys
- disable tools (`gateway`, `cron`, `exec`, etc.)
- change gateway bind/auth/network exposure choices
- remove or rewrite plugins/skills

## Related

- [CLI reference](/cli)
- [Security audit](/gateway/security)
