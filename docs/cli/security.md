---
summary: "CLI reference for `openclaw security` (audit and fix common security footguns)"
read_when:
  - You want to run a quick security audit on config/state
  - You want to apply safe "fix" suggestions (permissions, tighten defaults)
title: "Security"
---

# `openclaw security`

Security tools: audit plus optional safe fixes. Related: [Security](/gateway/security).

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --deep --password <password>
openclaw security audit --deep --token <token>
openclaw security audit --auth password --password <password>
openclaw security audit --fix
openclaw security audit --json
```

## Audit modes

Plain `security audit` stays on the cold config/filesystem/read-only path: it does not discover plugin runtime security collectors, so routine audits do not load every installed plugin runtime. `--deep` adds best-effort live Gateway probes and plugin-owned security audit collectors (explicit internal callers may also opt into those collectors when they already have an appropriate runtime scope).

If Gateway password auth is supplied only at startup, pass the same value with `--auth password --password <password>` so the audit can check it against `hooks.token`.

## What it checks

**DM/trust model**

- Warns when multiple DM senders share the main session and recommends secure DM mode: `session.dmScope="per-channel-peer"` (or `per-account-channel-peer` for multi-account channels) for shared inboxes. This is cooperative/shared-inbox hardening, not isolation for mutually untrusted operators; split trust boundaries with separate gateways (or separate OS users/hosts) for that.
- Emits `security.trust_model.multi_user_heuristic` when config suggests likely shared-user ingress (for example open DM/group policy, configured group targets, or wildcard sender rules) — OpenClaw's default trust model is personal-assistant (one operator), not hostile multi-tenant isolation. For intentional shared-user setups: sandbox all sessions, keep filesystem access workspace-scoped, and keep personal/private identities or credentials off that runtime.
- Warns when small models (`<=300B` parameters) are used without sandboxing and with web/browser tools enabled.

**Webhook/hooks**

Startup logs a non-fatal security warning, and audit flags `hooks.token` reuse of active Gateway shared-secret auth values (`gateway.auth.token` / `OPENCLAW_GATEWAY_TOKEN`, `gateway.auth.password` / `OPENCLAW_GATEWAY_PASSWORD`). Also warns when:

- `hooks.token` is short
- `hooks.path="/"`
- `hooks.defaultSessionKey` is unset
- `hooks.allowedAgentIds` is unrestricted
- request `sessionKey` overrides are enabled
- overrides are enabled without `hooks.allowedSessionKeyPrefixes`

Run `openclaw doctor --fix` to rotate a persisted reused `hooks.token`, then update external hook senders to use the new token.

**Sandbox/tools**

- Warns when sandbox Docker settings are configured while sandbox mode is off.
- Warns when `gateway.nodes.commands.deny` uses ineffective pattern-like/unknown entries (matching is exact node command-name only, not shell-text filtering).
- Warns when `gateway.nodes.commands.allow` explicitly enables dangerous node commands.
- Warns when global `tools.profile="minimal"` is overridden by agent tool profiles.
- Warns when write/edit tools are disabled but `exec` is still available without a constraining sandbox filesystem boundary.
- Warns when open DMs or groups expose runtime/filesystem tools without sandbox/workspace guards.
- Warns when installed plugin tools may be reachable under permissive tool policy.

**Sandbox browser**

- Warns when sandbox browser uses Docker `bridge` network without `sandbox.browser.cdpSourceRange`.
- Flags dangerous sandbox Docker network modes, including `host` and `container:*` namespace joins.
- Warns when existing sandbox browser Docker containers have missing/stale hash labels (for example pre-migration containers missing `openclaw.browserConfigEpoch`) and recommends `openclaw sandbox recreate --browser --all`.

**Network/discovery**

- Flags `gateway.allowRealIpFallback=true` (header-spoofing risk if proxies are misconfigured).
- Flags `discovery.mdns.mode="full"` (metadata leakage via mDNS TXT records).
- Warns when `gateway.auth.mode="none"` leaves Gateway HTTP APIs reachable without a shared secret (`/tools/invoke` plus any enabled `/v1/*` endpoint).

**Plugins/channels**

- Warns when npm-based plugin/hook install records are unpinned, missing integrity metadata, or drift from currently installed package versions.
- Warns when channel allowlists rely on mutable names/emails/tags instead of stable IDs (Discord, Slack, Google Chat, Microsoft Teams, Mattermost, IRC scopes where applicable).

Settings prefixed with `dangerous`/`dangerously` are explicit break-glass operator overrides; enabling one is not, by itself, a security vulnerability report. For the complete dangerous-parameter inventory, see "Insecure or dangerous flags summary" in [Security](/gateway/security).

## SecretRef behavior

`security audit` resolves supported SecretRefs in read-only mode for its targeted paths. If a SecretRef is unavailable in the current command path, audit continues and reports `secretDiagnostics` instead of crashing. `--token` and `--password` only override deep-probe auth for that command invocation; they do not rewrite config or SecretRef mappings.

## Suppressions

Accept intentional standing findings with `security.audit.suppressions`. Each suppression matches an exact `checkId` and can be narrowed with case-insensitive `titleIncludes` and/or `detailIncludes` substrings:

```json
{
  "security": {
    "audit": {
      "suppressions": [
        {
          "checkId": "plugins.tools_reachable_permissive_policy",
          "detailIncludes": "Enabled extension plugins: gbrain",
          "reason": "trusted local operator plugin"
        }
      ]
    }
  }
}
```

Suppressed findings are removed from the active `summary` and `findings` list. JSON output keeps them under `suppressedFindings` for auditability. When suppressions are configured, active output also keeps an unsuppressible `security.audit.suppressions.active` info finding so readers can tell the audit was filtered. Dangerous config flags are emitted one flag per finding, so accepting one dangerous flag does not hide other enabled flags that share the same `config.insecure_or_dangerous_flags` checkId.

Because suppressions can hide standing risk, adding or removing them through agent-run shell commands requires exec approval unless exec is already running with `security="full"` and `ask="off"` for trusted local automation.

## JSON output

```bash
openclaw security audit --json | jq '.summary'
openclaw security audit --deep --json | jq '.findings[] | select(.severity=="critical") | .checkId'
```

With `--fix --json`, output includes both fix actions and the final report:

```bash
openclaw security audit --fix --json | jq '{fix: .fix.ok, summary: .report.summary}'
```

## What `--fix` changes

Applies safe, deterministic remediations:

- flips common `groupPolicy="open"` to `groupPolicy="allowlist"` (including account variants in supported channels)
- when WhatsApp group policy flips to `allowlist`, seeds `groupAllowFrom` from the stored `allowFrom` file when that list exists and config does not already define `allowFrom`
- sets `logging.redactSensitive` from `"off"` to `"tools"`
- tightens permissions for state/config and common sensitive files (`credentials/*.json`, `auth-profiles.json`, `openclaw-agent.sqlite`, and legacy session artifacts)
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
