---
summary: "Security considerations and threat model for running an AI gateway with shell access"
read_when:
  - Adding features that widen access or automation
title: "Security"
---

# Security

<Warning>
**Personal assistant trust model:** this guidance assumes one trusted operator boundary per gateway (single-user/personal assistant model).
OpenClaw is **not** a hostile multi-tenant security boundary for multiple adversarial users sharing one agent/gateway.
If you need mixed-trust or adversarial-user operation, split trust boundaries (separate gateway + credentials, ideally separate OS users/hosts).
</Warning>

**On this page:** [Trust model](#scope-first-personal-assistant-security-model) | [Quick audit](#quick-check-openclaw-security-audit) | [Hardened baseline](#hardened-baseline-in-60-seconds) | [DM access model](#dm-access-model-pairing-allowlist-open-disabled) | [Configuration hardening](#configuration-hardening-examples) | [Incident response](#incident-response)

## Scope first: personal assistant security model

OpenClaw security guidance assumes a **personal assistant** deployment: one trusted operator boundary, potentially many agents.

- Supported security posture: one user/trust boundary per gateway (prefer one OS user/host/VPS per boundary).
- Not a supported security boundary: one shared gateway/agent used by mutually untrusted or adversarial users.
- If adversarial-user isolation is required, split by trust boundary (separate gateway + credentials, and ideally separate OS users/hosts).
- If multiple untrusted users can message one tool-enabled agent, treat them as sharing the same delegated tool authority for that agent.

This page explains hardening **within that model**. It does not claim hostile multi-tenant isolation on one shared gateway.

## Quick check: `openclaw security audit`

See also: [Formal Verification (Security Models)](/security/formal-verification)

Run this regularly (especially after changing config or exposing network surfaces):

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
openclaw security audit --json
```

`security audit --fix` stays intentionally narrow: it flips common open group
policies to allowlists, restores `logging.redactSensitive: "tools"`, tightens
state/config/include-file permissions, and uses Windows ACL resets instead of
POSIX `chmod` when running on Windows.

It flags common footguns (Gateway auth exposure, browser control exposure, elevated allowlists, filesystem permissions, permissive exec approvals, and open-channel tool exposure).

OpenClaw is both a product and an experiment: you’re wiring frontier-model behavior into real messaging surfaces and real tools. **There is no “perfectly secure” setup.** The goal is to be deliberate about:

- who can talk to your bot
- where the bot is allowed to act
- what the bot can touch

Start with the smallest access that still works, then widen it as you gain confidence.

### Deployment and host trust

OpenClaw assumes the host and config boundary are trusted:

- If someone can modify Gateway host state/config (`~/.openclaw`, including `openclaw.json`), treat them as a trusted operator.
- Running one Gateway for multiple mutually untrusted/adversarial operators is **not a recommended setup**.
- For mixed-trust teams, split trust boundaries with separate gateways (or at minimum separate OS users/hosts).
- Recommended default: one user per machine/host (or VPS), one gateway for that user, and one or more agents in that gateway.
- Inside one Gateway instance, authenticated operator access is a trusted control-plane role, not a per-user tenant role.
- Session identifiers (`sessionKey`, session IDs, labels) are routing selectors, not authorization tokens.
- If several people can message one tool-enabled agent, each of them can steer that same permission set. Per-user session/memory isolation helps privacy, but does not convert a shared agent into per-user host authorization.

### Shared Slack workspace: real risk

If "everyone in Slack can message the bot," the core risk is delegated tool authority:

- any allowed sender can induce tool calls (`exec`, browser, network/file tools) within the agent's policy;
- prompt/content injection from one sender can cause actions that affect shared state, devices, or outputs;
- if one shared agent has sensitive credentials/files, any allowed sender can potentially drive exfiltration via tool usage.

Use separate agents/gateways with minimal tools for team workflows; keep personal-data agents private.

### Company-shared agent: acceptable pattern

This is acceptable when everyone using that agent is in the same trust boundary (for example one company team) and the agent is strictly business-scoped.

- run it on a dedicated machine/VM/container;
- use a dedicated OS user + dedicated browser/profile/accounts for that runtime;
- do not sign that runtime into personal Apple/Google accounts or personal password-manager/browser profiles.

If you mix personal and company identities on the same runtime, you collapse the separation and increase personal-data exposure risk.

## Gateway and node trust concept

Treat Gateway and node as one operator trust domain, with different roles:

- **Gateway** is the control plane and policy surface (`gateway.auth`, tool policy, routing).
- **Node** is remote execution surface paired to that Gateway (commands, device actions, host-local capabilities).
- A caller authenticated to the Gateway is trusted at Gateway scope. After pairing, node actions are trusted operator actions on that node.
- `sessionKey` is routing/context selection, not per-user auth.
- Exec approvals (allowlist + ask) are guardrails for operator intent, not hostile multi-tenant isolation.
- OpenClaw's product default for trusted single-operator setups is that host exec on `gateway`/`node` is allowed without approval prompts (`security="full"`, `ask="off"` unless you tighten it). That default is intentional UX, not a vulnerability by itself.
- Exec approvals bind exact request context and best-effort direct local file operands; they do not semantically model every runtime/interpreter loader path. Use sandboxing and host isolation for strong boundaries.

If you need hostile-user isolation, split trust boundaries by OS user/host and run separate gateways.

## Trust boundary matrix

Use this as the quick model when triaging risk:

| Boundary or control                                       | What it means                                     | Common misread                                                                |
| --------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `gateway.auth` (token/password/trusted-proxy/device auth) | Authenticates callers to gateway APIs             | "Needs per-message signatures on every frame to be secure"                    |
| `sessionKey`                                              | Routing key for context/session selection         | "Session key is a user auth boundary"                                         |
| Prompt/content guardrails                                 | Reduce model abuse risk                           | "Prompt injection alone proves auth bypass"                                   |
| `canvas.eval` / browser evaluate                          | Intentional operator capability when enabled      | "Any JS eval primitive is automatically a vuln in this trust model"           |
| Local TUI `!` shell                                       | Explicit operator-triggered local execution       | "Local shell convenience command is remote injection"                         |
| Node pairing and node commands                            | Operator-level remote execution on paired devices | "Remote device control should be treated as untrusted user access by default" |

## Not vulnerabilities by design

These patterns are commonly reported and are usually closed as no-action unless a real boundary bypass is shown:

- Prompt-injection-only chains without a policy/auth/sandbox bypass.
- Claims that assume hostile multi-tenant operation on one shared host/config.
- Claims that classify normal operator read-path access (for example `sessions.list`/`sessions.preview`/`chat.history`) as IDOR in a shared-gateway setup.
- Localhost-only deployment findings (for example HSTS on loopback-only gateway).
- Discord inbound webhook signature findings for inbound paths that do not exist in this repo.
- Reports that treat node pairing metadata as a hidden second per-command approval layer for `system.run`, when the real execution boundary is still the gateway's global node command policy plus the node's own exec approvals.
- "Missing per-user authorization" findings that treat `sessionKey` as an auth token.

## Researcher preflight checklist

Before opening a GHSA, verify all of these:

1. Repro still works on latest `main` or latest release.
2. Report includes exact code path (`file`, function, line range) and tested version/commit.
3. Impact crosses a documented trust boundary (not just prompt injection).
4. Claim is not listed in [Out of Scope](https://github.com/openclaw/openclaw/blob/main/SECURITY.md#out-of-scope).
5. Existing advisories were checked for duplicates (reuse canonical GHSA when applicable).
6. Deployment assumptions are explicit (loopback/local vs exposed, trusted vs untrusted operators).

## Hardened baseline in 60 seconds

Use this baseline first, then selectively re-enable tools per trusted agent:

```json5
{
  gateway: {
    mode: "local",
    bind: "loopback",
    auth: { mode: "token", token: "replace-with-long-random-token" },
  },
  session: {
    dmScope: "per-channel-peer",
  },
  tools: {
    profile: "messaging",
    deny: ["group:automation", "group:runtime", "group:fs", "sessions_spawn", "sessions_send"],
    fs: { workspaceOnly: true },
    exec: { security: "deny", ask: "always" },
    elevated: { enabled: false },
  },
  channels: {
    whatsapp: { dmPolicy: "pairing", groups: { "*": { requireMention: true } } },
  },
}
```

This keeps the Gateway local-only, isolates DMs, and disables control-plane/runtime tools by default.

## Shared inbox quick rule

If more than one person can DM your bot:

- Set `session.dmScope: "per-channel-peer"` (or `"per-account-channel-peer"` for multi-account channels).
- Keep `dmPolicy: "pairing"` or strict allowlists.
- Never combine shared DMs with broad tool access.
- This hardens cooperative/shared inboxes, but is not designed as hostile co-tenant isolation when users share host/config write access.

## Context visibility model

OpenClaw separates two concepts:

- **Trigger authorization**: who can trigger the agent (`dmPolicy`, `groupPolicy`, allowlists, mention gates).
- **Context visibility**: what supplemental context is injected into model input (reply body, quoted text, thread history, forwarded metadata).

Allowlists gate triggers and command authorization. The `contextVisibility` setting controls how supplemental context (quoted replies, thread roots, fetched history) is filtered:

- `contextVisibility: "all"` (default) keeps supplemental context as received.
- `contextVisibility: "allowlist"` filters supplemental context to senders allowed by the active allowlist checks.
- `contextVisibility: "allowlist_quote"` behaves like `allowlist`, but still keeps one explicit quoted reply.

Set `contextVisibility` per channel or per room/conversation. See [Group Chats](/channels/groups#context-visibility-and-allowlists) for setup details.

Advisory triage guidance:

- Claims that only show "model can see quoted or historical text from non-allowlisted senders" are hardening findings addressable with `contextVisibility`, not auth or sandbox boundary bypasses by themselves.
- To be security-impacting, reports still need a demonstrated trust-boundary bypass (auth, policy, sandbox, approval, or another documented boundary).

## What the audit checks (high level)

- **Inbound access** (DM policies, group policies, allowlists): can strangers trigger the bot?
- **Tool blast radius** (elevated tools + open rooms): could prompt injection turn into shell/file/network actions?
- **Exec approval drift** (`security=full`, `autoAllowSkills`, interpreter allowlists without `strictInlineEval`): are host-exec guardrails still doing what you think they are?
  - `security="full"` is a broad posture warning, not proof of a bug. It is the chosen default for trusted personal-assistant setups; tighten it only when your threat model needs approval or allowlist guardrails.
- **Network exposure** (Gateway bind/auth, Tailscale Serve/Funnel, weak/short auth tokens).
- **Browser control exposure** (remote nodes, relay ports, remote CDP endpoints).
- **Local disk hygiene** (permissions, symlinks, config includes, “synced folder” paths).
- **Plugins** (extensions exist without an explicit allowlist).
- **Policy drift/misconfig** (sandbox docker settings configured but sandbox mode off; ineffective `gateway.nodes.denyCommands` patterns because matching is exact command-name only (for example `system.run`) and does not inspect shell text; dangerous `gateway.nodes.allowCommands` entries; global `tools.profile="minimal"` overridden by per-agent profiles; extension plugin tools reachable under permissive tool policy).
- **Runtime expectation drift** (for example assuming implicit exec still means `sandbox` when `tools.exec.host` now defaults to `auto`, or explicitly setting `tools.exec.host="sandbox"` while sandbox mode is off).
- **Model hygiene** (warn when configured models look legacy; not a hard block).

If you run `--deep`, OpenClaw also attempts a best-effort live Gateway probe.

## Credential storage map

Use this when auditing access or deciding what to back up:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot token**: config/env or `channels.telegram.tokenFile` (regular file only; symlinks rejected)
- **Discord bot token**: config/env or SecretRef (env/file/exec providers)
- **Slack tokens**: config/env (`channels.slack.*`)
- **Pairing allowlists**:
  - `~/.openclaw/credentials/<channel>-allowFrom.json` (default account)
  - `~/.openclaw/credentials/<channel>-<accountId>-allowFrom.json` (non-default accounts)
- **Model auth profiles**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **File-backed secrets payload (optional)**: `~/.openclaw/secrets.json`
- **Legacy OAuth import**: `~/.openclaw/credentials/oauth.json`

## Security audit checklist

When the audit prints findings, treat this as a priority order:

1. **Anything “open” + tools enabled**: lock down DMs/groups first (pairing/allowlists), then tighten tool policy/sandboxing.
2. **Public network exposure** (LAN bind, Funnel, missing auth): fix immediately.
3. **Browser control remote exposure**: treat it like operator access (tailnet-only, pair nodes deliberately, avoid public exposure).
4. **Permissions**: make sure state/config/credentials/auth are not group/world-readable.
5. **Plugins/extensions**: only load what you explicitly trust.
6. **Model choice**: prefer modern, instruction-hardened models for any bot with tools.

## Security audit glossary

High-signal `checkId` values you will most likely see in real deployments (not exhaustive):

| `checkId`                                                     | Severity      | Why it matters                                                                       | Primary fix key/path                                                                                 | Auto-fix |
| ------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------- |
| `fs.state_dir.perms_world_writable`                           | critical      | Other users/processes can modify full OpenClaw state                                 | filesystem perms on `~/.openclaw`                                                                    | yes      |
| `fs.state_dir.perms_group_writable`                           | warn          | Group users can modify full OpenClaw state                                           | filesystem perms on `~/.openclaw`                                                                    | yes      |
| `fs.state_dir.perms_readable`                                 | warn          | State dir is readable by others                                                      | filesystem perms on `~/.openclaw`                                                                    | yes      |
| `fs.state_dir.symlink`                                        | warn          | State dir target becomes another trust boundary                                      | state dir filesystem layout                                                                          | no       |
| `fs.config.perms_writable`                                    | critical      | Others can change auth/tool policy/config                                            | filesystem perms on `~/.openclaw/openclaw.json`                                                      | yes      |
| `fs.config.symlink`                                           | warn          | Config target becomes another trust boundary                                         | config file filesystem layout                                                                        | no       |
| `fs.config.perms_group_readable`                              | warn          | Group users can read config tokens/settings                                          | filesystem perms on config file                                                                      | yes      |
| `fs.config.perms_world_readable`                              | critical      | Config can expose tokens/settings                                                    | filesystem perms on config file                                                                      | yes      |
| `fs.config_include.perms_writable`                            | critical      | Config include file can be modified by others                                        | include-file perms referenced from `openclaw.json`                                                   | yes      |
| `fs.config_include.perms_group_readable`                      | warn          | Group users can read included secrets/settings                                       | include-file perms referenced from `openclaw.json`                                                   | yes      |
| `fs.config_include.perms_world_readable`                      | critical      | Included secrets/settings are world-readable                                         | include-file perms referenced from `openclaw.json`                                                   | yes      |
| `fs.auth_profiles.perms_writable`                             | critical      | Others can inject or replace stored model credentials                                | `agents/<agentId>/agent/auth-profiles.json` perms                                                    | yes      |
| `fs.auth_profiles.perms_readable`                             | warn          | Others can read API keys and OAuth tokens                                            | `agents/<agentId>/agent/auth-profiles.json` perms                                                    | yes      |
| `fs.credentials_dir.perms_writable`                           | critical      | Others can modify channel pairing/credential state                                   | filesystem perms on `~/.openclaw/credentials`                                                        | yes      |
| `fs.credentials_dir.perms_readable`                           | warn          | Others can read channel credential state                                             | filesystem perms on `~/.openclaw/credentials`                                                        | yes      |
| `fs.sessions_store.perms_readable`                            | warn          | Others can read session transcripts/metadata                                         | session store perms                                                                                  | yes      |
| `fs.log_file.perms_readable`                                  | warn          | Others can read redacted-but-still-sensitive logs                                    | gateway log file perms                                                                               | yes      |
| `fs.synced_dir`                                               | warn          | State/config in iCloud/Dropbox/Drive broadens token/transcript exposure              | move config/state off synced folders                                                                 | no       |
| `gateway.bind_no_auth`                                        | critical      | Remote bind without shared secret                                                    | `gateway.bind`, `gateway.auth.*`                                                                     | no       |
| `gateway.loopback_no_auth`                                    | critical      | Reverse-proxied loopback may become unauthenticated                                  | `gateway.auth.*`, proxy setup                                                                        | no       |
| `gateway.trusted_proxies_missing`                             | warn          | Reverse-proxy headers are present but not trusted                                    | `gateway.trustedProxies`                                                                             | no       |
| `gateway.http.no_auth`                                        | warn/critical | Gateway HTTP APIs reachable with `auth.mode="none"`                                  | `gateway.auth.mode`, `gateway.http.endpoints.*`                                                      | no       |
| `gateway.http.session_key_override_enabled`                   | info          | HTTP API callers can override `sessionKey`                                           | `gateway.http.allowSessionKeyOverride`                                                               | no       |
| `gateway.tools_invoke_http.dangerous_allow`                   | warn/critical | Re-enables dangerous tools over HTTP API                                             | `gateway.tools.allow`                                                                                | no       |
| `gateway.nodes.allow_commands_dangerous`                      | warn/critical | Enables high-impact node commands (camera/screen/contacts/calendar/SMS)              | `gateway.nodes.allowCommands`                                                                        | no       |
| `gateway.nodes.deny_commands_ineffective`                     | warn          | Pattern-like deny entries do not match shell text or groups                          | `gateway.nodes.denyCommands`                                                                         | no       |
| `gateway.tailscale_funnel`                                    | critical      | Public internet exposure                                                             | `gateway.tailscale.mode`                                                                             | no       |
| `gateway.tailscale_serve`                                     | info          | Tailnet exposure is enabled via Serve                                                | `gateway.tailscale.mode`                                                                             | no       |
| `gateway.control_ui.allowed_origins_required`                 | critical      | Non-loopback Control UI without explicit browser-origin allowlist                    | `gateway.controlUi.allowedOrigins`                                                                   | no       |
| `gateway.control_ui.allowed_origins_wildcard`                 | warn/critical | `allowedOrigins=["*"]` disables browser-origin allowlisting                          | `gateway.controlUi.allowedOrigins`                                                                   | no       |
| `gateway.control_ui.host_header_origin_fallback`              | warn/critical | Enables Host-header origin fallback (DNS rebinding hardening downgrade)              | `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback`                                         | no       |
| `gateway.control_ui.insecure_auth`                            | warn          | Insecure-auth compatibility toggle enabled                                           | `gateway.controlUi.allowInsecureAuth`                                                                | no       |
| `gateway.control_ui.device_auth_disabled`                     | critical      | Disables device identity check                                                       | `gateway.controlUi.dangerouslyDisableDeviceAuth`                                                     | no       |
| `gateway.real_ip_fallback_enabled`                            | warn/critical | Trusting `X-Real-IP` fallback can enable source-IP spoofing via proxy misconfig      | `gateway.allowRealIpFallback`, `gateway.trustedProxies`                                              | no       |
| `gateway.token_too_short`                                     | warn          | Short shared token is easier to brute force                                          | `gateway.auth.token`                                                                                 | no       |
| `gateway.auth_no_rate_limit`                                  | warn          | Exposed auth without rate limiting increases brute-force risk                        | `gateway.auth.rateLimit`                                                                             | no       |
| `gateway.trusted_proxy_auth`                                  | critical      | Proxy identity now becomes the auth boundary                                         | `gateway.auth.mode="trusted-proxy"`                                                                  | no       |
| `gateway.trusted_proxy_no_proxies`                            | critical      | Trusted-proxy auth without trusted proxy IPs is unsafe                               | `gateway.trustedProxies`                                                                             | no       |
| `gateway.trusted_proxy_no_user_header`                        | critical      | Trusted-proxy auth cannot resolve user identity safely                               | `gateway.auth.trustedProxy.userHeader`                                                               | no       |
| `gateway.trusted_proxy_no_allowlist`                          | warn          | Trusted-proxy auth accepts any authenticated upstream user                           | `gateway.auth.trustedProxy.allowUsers`                                                               | no       |
| `gateway.probe_auth_secretref_unavailable`                    | warn          | Deep probe could not resolve auth SecretRefs in this command path                    | deep-probe auth source / SecretRef availability                                                      | no       |
| `gateway.probe_failed`                                        | warn/critical | Live Gateway probe failed                                                            | gateway reachability/auth                                                                            | no       |
| `discovery.mdns_full_mode`                                    | warn/critical | mDNS full mode advertises `cliPath`/`sshPort` metadata on local network              | `discovery.mdns.mode`, `gateway.bind`                                                                | no       |
| `config.insecure_or_dangerous_flags`                          | warn          | Any insecure/dangerous debug flags enabled                                           | multiple keys (see finding detail)                                                                   | no       |
| `config.secrets.gateway_password_in_config`                   | warn          | Gateway password is stored directly in config                                        | `gateway.auth.password`                                                                              | no       |
| `config.secrets.hooks_token_in_config`                        | warn          | Hook bearer token is stored directly in config                                       | `hooks.token`                                                                                        | no       |
| `hooks.token_reuse_gateway_token`                             | critical      | Hook ingress token also unlocks Gateway auth                                         | `hooks.token`, `gateway.auth.token`                                                                  | no       |
| `hooks.token_too_short`                                       | warn          | Easier brute force on hook ingress                                                   | `hooks.token`                                                                                        | no       |
| `hooks.default_session_key_unset`                             | warn          | Hook agent runs fan out into generated per-request sessions                          | `hooks.defaultSessionKey`                                                                            | no       |
| `hooks.allowed_agent_ids_unrestricted`                        | warn/critical | Authenticated hook callers may route to any configured agent                         | `hooks.allowedAgentIds`                                                                              | no       |
| `hooks.request_session_key_enabled`                           | warn/critical | External caller can choose sessionKey                                                | `hooks.allowRequestSessionKey`                                                                       | no       |
| `hooks.request_session_key_prefixes_missing`                  | warn/critical | No bound on external session key shapes                                              | `hooks.allowedSessionKeyPrefixes`                                                                    | no       |
| `hooks.path_root`                                             | critical      | Hook path is `/`, making ingress easier to collide or misroute                       | `hooks.path`                                                                                         | no       |
| `hooks.installs_unpinned_npm_specs`                           | warn          | Hook install records are not pinned to immutable npm specs                           | hook install metadata                                                                                | no       |
| `hooks.installs_missing_integrity`                            | warn          | Hook install records lack integrity metadata                                         | hook install metadata                                                                                | no       |
| `hooks.installs_version_drift`                                | warn          | Hook install records drift from installed packages                                   | hook install metadata                                                                                | no       |
| `logging.redact_off`                                          | warn          | Sensitive values leak to logs/status                                                 | `logging.redactSensitive`                                                                            | yes      |
| `browser.control_invalid_config`                              | warn          | Browser control config is invalid before runtime                                     | `browser.*`                                                                                          | no       |
| `browser.control_no_auth`                                     | critical      | Browser control exposed without token/password auth                                  | `gateway.auth.*`                                                                                     | no       |
| `browser.remote_cdp_http`                                     | warn          | Remote CDP over plain HTTP lacks transport encryption                                | browser profile `cdpUrl`                                                                             | no       |
| `browser.remote_cdp_private_host`                             | warn          | Remote CDP targets a private/internal host                                           | browser profile `cdpUrl`, `browser.ssrfPolicy.*`                                                     | no       |
| `sandbox.docker_config_mode_off`                              | warn          | Sandbox Docker config present but inactive                                           | `agents.*.sandbox.mode`                                                                              | no       |
| `sandbox.bind_mount_non_absolute`                             | warn          | Relative bind mounts can resolve unpredictably                                       | `agents.*.sandbox.docker.binds[]`                                                                    | no       |
| `sandbox.dangerous_bind_mount`                                | critical      | Sandbox bind mount targets blocked system, credential, or Docker socket paths        | `agents.*.sandbox.docker.binds[]`                                                                    | no       |
| `sandbox.dangerous_network_mode`                              | critical      | Sandbox Docker network uses `host` or `container:*` namespace-join mode              | `agents.*.sandbox.docker.network`                                                                    | no       |
| `sandbox.dangerous_seccomp_profile`                           | critical      | Sandbox seccomp profile weakens container isolation                                  | `agents.*.sandbox.docker.securityOpt`                                                                | no       |
| `sandbox.dangerous_apparmor_profile`                          | critical      | Sandbox AppArmor profile weakens container isolation                                 | `agents.*.sandbox.docker.securityOpt`                                                                | no       |
| `sandbox.browser_cdp_bridge_unrestricted`                     | warn          | Sandbox browser bridge is exposed without source-range restriction                   | `sandbox.browser.cdpSourceRange`                                                                     | no       |
| `sandbox.browser_container.non_loopback_publish`              | critical      | Existing browser container publishes CDP on non-loopback interfaces                  | browser sandbox container publish config                                                             | no       |
| `sandbox.browser_container.hash_label_missing`                | warn          | Existing browser container predates current config-hash labels                       | `openclaw sandbox recreate --browser --all`                                                          | no       |
| `sandbox.browser_container.hash_epoch_stale`                  | warn          | Existing browser container predates current browser config epoch                     | `openclaw sandbox recreate --browser --all`                                                          | no       |
| `tools.exec.host_sandbox_no_sandbox_defaults`                 | warn          | `exec host=sandbox` fails closed when sandbox is off                                 | `tools.exec.host`, `agents.defaults.sandbox.mode`                                                    | no       |
| `tools.exec.host_sandbox_no_sandbox_agents`                   | warn          | Per-agent `exec host=sandbox` fails closed when sandbox is off                       | `agents.list[].tools.exec.host`, `agents.list[].sandbox.mode`                                        | no       |
| `tools.exec.security_full_configured`                         | warn/critical | Host exec is running with `security="full"`                                          | `tools.exec.security`, `agents.list[].tools.exec.security`                                           | no       |
| `tools.exec.auto_allow_skills_enabled`                        | warn          | Exec approvals trust skill bins implicitly                                           | `~/.openclaw/exec-approvals.json`                                                                    | no       |
| `tools.exec.allowlist_interpreter_without_strict_inline_eval` | warn          | Interpreter allowlists permit inline eval without forced reapproval                  | `tools.exec.strictInlineEval`, `agents.list[].tools.exec.strictInlineEval`, exec approvals allowlist | no       |
| `tools.exec.safe_bins_interpreter_unprofiled`                 | warn          | Interpreter/runtime bins in `safeBins` without explicit profiles broaden exec risk   | `tools.exec.safeBins`, `tools.exec.safeBinProfiles`, `agents.list[].tools.exec.*`                    | no       |
| `tools.exec.safe_bins_broad_behavior`                         | warn          | Broad-behavior tools in `safeBins` weaken the low-risk stdin-filter trust model      | `tools.exec.safeBins`, `agents.list[].tools.exec.safeBins`                                           | no       |
| `tools.exec.safe_bin_trusted_dirs_risky`                      | warn          | `safeBinTrustedDirs` includes mutable or risky directories                           | `tools.exec.safeBinTrustedDirs`, `agents.list[].tools.exec.safeBinTrustedDirs`                       | no       |
| `skills.workspace.symlink_escape`                             | warn          | Workspace `skills/**/SKILL.md` resolves outside workspace root (symlink-chain drift) | workspace `skills/**` filesystem state                                                               | no       |
| `plugins.extensions_no_allowlist`                             | warn          | Extensions are installed without an explicit plugin allowlist                        | `plugins.allowlist`                                                                                  | no       |
| `plugins.installs_unpinned_npm_specs`                         | warn          | Plugin install records are not pinned to immutable npm specs                         | plugin install metadata                                                                              | no       |
| `plugins.installs_missing_integrity`                          | warn          | Plugin install records lack integrity metadata                                       | plugin install metadata                                                                              | no       |
| `plugins.installs_version_drift`                              | warn          | Plugin install records drift from installed packages                                 | plugin install metadata                                                                              | no       |
| `plugins.code_safety`                                         | warn/critical | Plugin code scan found suspicious or dangerous patterns                              | plugin code / install source                                                                         | no       |
| `plugins.code_safety.entry_path`                              | warn          | Plugin entry path points into hidden or `node_modules` locations                     | plugin manifest `entry`                                                                              | no       |
| `plugins.code_safety.entry_escape`                            | critical      | Plugin entry escapes the plugin directory                                            | plugin manifest `entry`                                                                              | no       |
| `plugins.code_safety.scan_failed`                             | warn          | Plugin code scan could not complete                                                  | plugin extension path / scan environment                                                             | no       |
| `skills.code_safety`                                          | warn/critical | Skill installer metadata/code contains suspicious or dangerous patterns              | skill install source                                                                                 | no       |
| `skills.code_safety.scan_failed`                              | warn          | Skill code scan could not complete                                                   | skill scan environment                                                                               | no       |
| `security.exposure.open_channels_with_exec`                   | warn/critical | Shared/public rooms can reach exec-enabled agents                                    | `channels.*.dmPolicy`, `channels.*.groupPolicy`, `tools.exec.*`, `agents.list[].tools.exec.*`        | no       |
| `security.exposure.open_groups_with_elevated`                 | critical      | Open groups + elevated tools create high-impact prompt-injection paths               | `channels.*.groupPolicy`, `tools.elevated.*`                                                         | no       |
| `security.exposure.open_groups_with_runtime_or_fs`            | critical/warn | Open groups can reach command/file tools without sandbox/workspace guards            | `channels.*.groupPolicy`, `tools.profile/deny`, `tools.fs.workspaceOnly`, `agents.*.sandbox.mode`    | no       |
| `security.trust_model.multi_user_heuristic`                   | warn          | Config looks multi-user while gateway trust model is personal-assistant              | split trust boundaries, or shared-user hardening (`sandbox.mode`, tool deny/workspace scoping)       | no       |
| `tools.profile_minimal_overridden`                            | warn          | Agent overrides bypass global minimal profile                                        | `agents.list[].tools.profile`                                                                        | no       |
| `plugins.tools_reachable_permissive_policy`                   | warn          | Extension tools reachable in permissive contexts                                     | `tools.profile` + tool allow/deny                                                                    | no       |
| `models.legacy`                                               | warn          | Legacy model families are still configured                                           | model selection                                                                                      | no       |
| `models.weak_tier`                                            | warn          | Configured models are below current recommended tiers                                | model selection                                                                                      | no       |
| `models.small_params`                                         | critical/info | Small models + unsafe tool surfaces raise injection risk                             | model choice + sandbox/tool policy                                                                   | no       |
| `summary.attack_surface`                                      | info          | Roll-up summary of auth, channel, tool, and exposure posture                         | multiple keys (see finding detail)                                                                   | no       |

## Control UI over HTTP

The Control UI needs a **secure context** (HTTPS or localhost) to generate device
identity. `gateway.controlUi.allowInsecureAuth` is a local compatibility toggle:

- On localhost, it allows Control UI auth without device identity when the page
  is loaded over non-secure HTTP.
- It does not bypass pairing checks.
- It does not relax remote (non-localhost) device identity requirements.

Prefer HTTPS (Tailscale Serve) or open the UI on `127.0.0.1`.

For break-glass scenarios only, `gateway.controlUi.dangerouslyDisableDeviceAuth`
disables device identity checks entirely. This is a severe security downgrade;
keep it off unless you are actively debugging and can revert quickly.

Separate from those dangerous flags, successful `gateway.auth.mode: "trusted-proxy"`
can admit **operator** Control UI sessions without device identity. That is an
intentional auth-mode behavior, not an `allowInsecureAuth` shortcut, and it still
does not extend to node-role Control UI sessions.

`openclaw security audit` warns when this setting is enabled.

## Insecure or dangerous flags summary

`openclaw security audit` includes `config.insecure_or_dangerous_flags` when
known insecure/dangerous debug switches are enabled. That check currently
aggregates:

- `gateway.controlUi.allowInsecureAuth=true`
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true`
- `gateway.controlUi.dangerouslyDisableDeviceAuth=true`
- `hooks.gmail.allowUnsafeExternalContent=true`
- `hooks.mappings[<index>].allowUnsafeExternalContent=true`
- `tools.exec.applyPatch.workspaceOnly=false`
- `plugins.entries.acpx.config.permissionMode=approve-all`

Complete `dangerous*` / `dangerously*` config keys defined in OpenClaw config
schema:

- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback`
- `gateway.controlUi.dangerouslyDisableDeviceAuth`
- `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork`
- `channels.discord.dangerouslyAllowNameMatching`
- `channels.discord.accounts.<accountId>.dangerouslyAllowNameMatching`
- `channels.slack.dangerouslyAllowNameMatching`
- `channels.slack.accounts.<accountId>.dangerouslyAllowNameMatching`
- `channels.googlechat.dangerouslyAllowNameMatching`
- `channels.googlechat.accounts.<accountId>.dangerouslyAllowNameMatching`
- `channels.msteams.dangerouslyAllowNameMatching`
- `channels.synology-chat.dangerouslyAllowNameMatching` (extension channel)
- `channels.synology-chat.accounts.<accountId>.dangerouslyAllowNameMatching` (extension channel)
- `channels.synology-chat.dangerouslyAllowInheritedWebhookPath` (extension channel)
- `channels.zalouser.dangerouslyAllowNameMatching` (extension channel)
- `channels.zalouser.accounts.<accountId>.dangerouslyAllowNameMatching` (extension channel)
- `channels.irc.dangerouslyAllowNameMatching` (extension channel)
- `channels.irc.accounts.<accountId>.dangerouslyAllowNameMatching` (extension channel)
- `channels.mattermost.dangerouslyAllowNameMatching` (extension channel)
- `channels.mattermost.accounts.<accountId>.dangerouslyAllowNameMatching` (extension channel)
- `channels.telegram.network.dangerouslyAllowPrivateNetwork`
- `channels.telegram.accounts.<accountId>.network.dangerouslyAllowPrivateNetwork`
- `agents.defaults.sandbox.docker.dangerouslyAllowReservedContainerTargets`
- `agents.defaults.sandbox.docker.dangerouslyAllowExternalBindSources`
- `agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin`
- `agents.list[<index>].sandbox.docker.dangerouslyAllowReservedContainerTargets`
- `agents.list[<index>].sandbox.docker.dangerouslyAllowExternalBindSources`
- `agents.list[<index>].sandbox.docker.dangerouslyAllowContainerNamespaceJoin`

## Reverse Proxy Configuration

If you run the Gateway behind a reverse proxy (nginx, Caddy, Traefik, etc.), configure
`gateway.trustedProxies` for proper forwarded-client IP handling.

When the Gateway detects proxy headers from an address that is **not** in `trustedProxies`, it will **not** treat connections as local clients. If gateway auth is disabled, those connections are rejected. This prevents authentication bypass where proxied connections would otherwise appear to come from localhost and receive automatic trust.

`gateway.trustedProxies` also feeds `gateway.auth.mode: "trusted-proxy"`, but that auth mode is stricter:

- trusted-proxy auth **fails closed on loopback-source proxies**
- same-host loopback reverse proxies can still use `gateway.trustedProxies` for local-client detection and forwarded IP handling
- for same-host loopback reverse proxies, use token/password auth instead of `gateway.auth.mode: "trusted-proxy"`

```yaml
gateway:
  trustedProxies:
    - "10.0.0.1" # reverse proxy IP
  # Optional. Default false.
  # Only enable if your proxy cannot provide X-Forwarded-For.
  allowRealIpFallback: false
  auth:
    mode: password
    password: ${OPENCLAW_GATEWAY_PASSWORD}
```

When `trustedProxies` is configured, the Gateway uses `X-Forwarded-For` to determine the client IP. `X-Real-IP` is ignored by default unless `gateway.allowRealIpFallback: true` is explicitly set.

Good reverse proxy behavior (overwrite incoming forwarding headers):

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;
```

Bad reverse proxy behavior (append/preserve untrusted forwarding headers):

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

## HSTS and origin notes

- OpenClaw gateway is local/loopback first. If you terminate TLS at a reverse proxy, set HSTS on the proxy-facing HTTPS domain there.
- If the gateway itself terminates HTTPS, you can set `gateway.http.securityHeaders.strictTransportSecurity` to emit the HSTS header from OpenClaw responses.
- Detailed deployment guidance is in [Trusted Proxy Auth](/gateway/trusted-proxy-auth#tls-termination-and-hsts).
- For non-loopback Control UI deployments, `gateway.controlUi.allowedOrigins` is required by default.
- `gateway.controlUi.allowedOrigins: ["*"]` is an explicit allow-all browser-origin policy, not a hardened default. Avoid it outside tightly controlled local testing.
- Browser-origin auth failures on loopback are still rate-limited even when the
  general loopback exemption is enabled, but the lockout key is scoped per
  normalized `Origin` value instead of one shared localhost bucket.
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` enables Host-header origin fallback mode; treat it as a dangerous operator-selected policy.
- Treat DNS rebinding and proxy-host header behavior as deployment hardening concerns; keep `trustedProxies` tight and avoid exposing the gateway directly to the public internet.

## Local session logs live on disk

OpenClaw stores session transcripts on disk under `~/.openclaw/agents/<agentId>/sessions/*.jsonl`.
This is required for session continuity and (optionally) session memory indexing, but it also means
**any process/user with filesystem access can read those logs**. Treat disk access as the trust
boundary and lock down permissions on `~/.openclaw` (see the audit section below). If you need
stronger isolation between agents, run them under separate OS users or separate hosts.

## Node execution (system.run)

If a macOS node is paired, the Gateway can invoke `system.run` on that node. This is **remote code execution** on the Mac:

- Requires node pairing (approval + token).
- Gateway node pairing is not a per-command approval surface. It establishes node identity/trust and token issuance.
- The Gateway applies a coarse global node command policy via `gateway.nodes.allowCommands` / `denyCommands`.
- Controlled on the Mac via **Settings → Exec approvals** (security + ask + allowlist).
- The per-node `system.run` policy is the node's own exec approvals file (`exec.approvals.node.*`), which can be stricter or looser than the gateway's global command-ID policy.
- A node running with `security="full"` and `ask="off"` is following the default trusted-operator model. Treat that as expected behavior unless your deployment explicitly requires a tighter approval or allowlist stance.
- Approval mode binds exact request context and, when possible, one concrete local script/file operand. If OpenClaw cannot identify exactly one direct local file for an interpreter/runtime command, approval-backed execution is denied rather than promising full semantic coverage.
- For `host=node`, approval-backed runs also store a canonical prepared
  `systemRunPlan`; later approved forwards reuse that stored plan, and gateway
  validation rejects caller edits to command/cwd/session context after the
  approval request was created.
- If you don’t want remote execution, set security to **deny** and remove node pairing for that Mac.

This distinction matters for triage:

- A reconnecting paired node advertising a different command list is not, by itself, a vulnerability if the Gateway global policy and the node's local exec approvals still enforce the actual execution boundary.
- Reports that treat node pairing metadata as a second hidden per-command approval layer are usually policy/UX confusion, not a security boundary bypass.

## Dynamic skills (watcher / remote nodes)

OpenClaw can refresh the skills list mid-session:

- **Skills watcher**: changes to `SKILL.md` can update the skills snapshot on the next agent turn.
- **Remote nodes**: connecting a macOS node can make macOS-only skills eligible (based on bin probing).

Treat skill folders as **trusted code** and restrict who can modify them.

## The Threat Model

Your AI assistant can:

- Execute arbitrary shell commands
- Read/write files
- Access network services
- Send messages to anyone (if you give it WhatsApp access)

People who message you can:

- Try to trick your AI into doing bad things
- Social engineer access to your data
- Probe for infrastructure details

## Core concept: access control before intelligence

Most failures here are not fancy exploits — they’re “someone messaged the bot and the bot did what they asked.”

OpenClaw’s stance:

- **Identity first:** decide who can talk to the bot (DM pairing / allowlists / explicit “open”).
- **Scope next:** decide where the bot is allowed to act (group allowlists + mention gating, tools, sandboxing, device permissions).
- **Model last:** assume the model can be manipulated; design so manipulation has limited blast radius.

## Command authorization model

Slash commands and directives are only honored for **authorized senders**. Authorization is derived from
channel allowlists/pairing plus `commands.useAccessGroups` (see [Configuration](/gateway/configuration)
and [Slash commands](/tools/slash-commands)). If a channel allowlist is empty or includes `"*"`,
commands are effectively open for that channel.

`/exec` is a session-only convenience for authorized operators. It does **not** write config or
change other sessions.

## Control plane tools risk

Two built-in tools can make persistent control-plane changes:

- `gateway` can inspect config with `config.schema.lookup` / `config.get`, and can make persistent changes with `config.apply`, `config.patch`, and `update.run`.
- `cron` can create scheduled jobs that keep running after the original chat/task ends.

The owner-only `gateway` runtime tool still refuses to rewrite
`tools.exec.ask` or `tools.exec.security`; legacy `tools.bash.*` aliases are
normalized to the same protected exec paths before the write.

For any agent/surface that handles untrusted content, deny these by default:

```json5
{
  tools: {
    deny: ["gateway", "cron", "sessions_spawn", "sessions_send"],
  },
}
```

`commands.restart=false` only blocks restart actions. It does not disable `gateway` config/update actions.

## Plugins/extensions

Plugins run **in-process** with the Gateway. Treat them as trusted code:

- Only install plugins from sources you trust.
- Prefer explicit `plugins.allow` allowlists.
- Review plugin config before enabling.
- Restart the Gateway after plugin changes.
- If you install or update plugins (`openclaw plugins install <package>`, `openclaw plugins update <id>`), treat it like running untrusted code:
  - The install path is the per-plugin directory under the active plugin install root.
  - OpenClaw runs a built-in dangerous-code scan before install/update. `critical` findings block by default.
  - OpenClaw uses `npm pack` and then runs `npm install --omit=dev` in that directory (npm lifecycle scripts can execute code during install).
  - Prefer pinned, exact versions (`@scope/pkg@1.2.3`), and inspect the unpacked code on disk before enabling.
  - `--dangerously-force-unsafe-install` is break-glass only for built-in scan false positives on plugin install/update flows. It does not bypass plugin `before_install` hook policy blocks and does not bypass scan failures.
  - Gateway-backed skill dependency installs follow the same dangerous/suspicious split: built-in `critical` findings block unless the caller explicitly sets `dangerouslyForceUnsafeInstall`, while suspicious findings still warn only. `openclaw skills install` remains the separate ClawHub skill download/install flow.

Details: [Plugins](/tools/plugin)

<a id="dm-access-model-pairing-allowlist-open-disabled"></a>

## DM access model (pairing / allowlist / open / disabled)

All current DM-capable channels support a DM policy (`dmPolicy` or `*.dm.policy`) that gates inbound DMs **before** the message is processed:

- `pairing` (default): unknown senders receive a short pairing code and the bot ignores their message until approved. Codes expire after 1 hour; repeated DMs won’t resend a code until a new request is created. Pending requests are capped at **3 per channel** by default.
- `allowlist`: unknown senders are blocked (no pairing handshake).
- `open`: allow anyone to DM (public). **Requires** the channel allowlist to include `"*"` (explicit opt-in).
- `disabled`: ignore inbound DMs entirely.

Approve via CLI:

```bash
openclaw pairing list <channel>
openclaw pairing approve <channel> <code>
```

Details + files on disk: [Pairing](/channels/pairing)

## DM session isolation (multi-user mode)

By default, OpenClaw routes **all DMs into the main session** so your assistant has continuity across devices and channels. If **multiple people** can DM the bot (open DMs or a multi-person allowlist), consider isolating DM sessions:

```json5
{
  session: { dmScope: "per-channel-peer" },
}
```

This prevents cross-user context leakage while keeping group chats isolated.

This is a messaging-context boundary, not a host-admin boundary. If users are mutually adversarial and share the same Gateway host/config, run separate gateways per trust boundary instead.

### Secure DM mode (recommended)

Treat the snippet above as **secure DM mode**:

- Default: `session.dmScope: "main"` (all DMs share one session for continuity).
- Local CLI onboarding default: writes `session.dmScope: "per-channel-peer"` when unset (keeps existing explicit values).
- Secure DM mode: `session.dmScope: "per-channel-peer"` (each channel+sender pair gets an isolated DM context).
- Cross-channel peer isolation: `session.dmScope: "per-peer"` (each sender gets one session across all channels of the same type).

If you run multiple accounts on the same channel, use `per-account-channel-peer` instead. If the same person contacts you on multiple channels, use `session.identityLinks` to collapse those DM sessions into one canonical identity. See [Session Management](/concepts/session) and [Configuration](/gateway/configuration).

## Allowlists (DM + groups) - terminology

OpenClaw has two separate “who can trigger me?” layers:

- **DM allowlist** (`allowFrom` / `channels.discord.allowFrom` / `channels.slack.allowFrom`; legacy: `channels.discord.dm.allowFrom`, `channels.slack.dm.allowFrom`): who is allowed to talk to the bot in direct messages.
  - When `dmPolicy="pairing"`, approvals are written to the account-scoped pairing allowlist store under `~/.openclaw/credentials/` (`<channel>-allowFrom.json` for default account, `<channel>-<accountId>-allowFrom.json` for non-default accounts), merged with config allowlists.
- **Group allowlist** (channel-specific): which groups/channels/guilds the bot will accept messages from at all.
  - Common patterns:
    - `channels.whatsapp.groups`, `channels.telegram.groups`, `channels.imessage.groups`: per-group defaults like `requireMention`; when set, it also acts as a group allowlist (include `"*"` to keep allow-all behavior).
    - `groupPolicy="allowlist"` + `groupAllowFrom`: restrict who can trigger the bot _inside_ a group session (WhatsApp/Telegram/Signal/iMessage/Microsoft Teams).
    - `channels.discord.guilds` / `channels.slack.channels`: per-surface allowlists + mention defaults.
  - Group checks run in this order: `groupPolicy`/group allowlists first, mention/reply activation second.
  - Replying to a bot message (implicit mention) does **not** bypass sender allowlists like `groupAllowFrom`.
  - **Security note:** treat `dmPolicy="open"` and `groupPolicy="open"` as last-resort settings. They should be barely used; prefer pairing + allowlists unless you fully trust every member of the room.

Details: [Configuration](/gateway/configuration) and [Groups](/channels/groups)

## Prompt injection (what it is, why it matters)

Prompt injection is when an attacker crafts a message that manipulates the model into doing something unsafe (“ignore your instructions”, “dump your filesystem”, “follow this link and run commands”, etc.).

Even with strong system prompts, **prompt injection is not solved**. System prompt guardrails are soft guidance only; hard enforcement comes from tool policy, exec approvals, sandboxing, and channel allowlists (and operators can disable these by design). What helps in practice:

- Keep inbound DMs locked down (pairing/allowlists).
- Prefer mention gating in groups; avoid “always-on” bots in public rooms.
- Treat links, attachments, and pasted instructions as hostile by default.
- Run sensitive tool execution in a sandbox; keep secrets out of the agent’s reachable filesystem.
- Note: sandboxing is opt-in. If sandbox mode is off, implicit `host=auto` resolves to the gateway host. Explicit `host=sandbox` still fails closed because no sandbox runtime is available. Set `host=gateway` if you want that behavior to be explicit in config.
- Limit high-risk tools (`exec`, `browser`, `web_fetch`, `web_search`) to trusted agents or explicit allowlists.
- If you allowlist interpreters (`python`, `node`, `ruby`, `perl`, `php`, `lua`, `osascript`), enable `tools.exec.strictInlineEval` so inline eval forms still need explicit approval.
- **Model choice matters:** older/smaller/legacy models are significantly less robust against prompt injection and tool misuse. For tool-enabled agents, use the strongest latest-generation, instruction-hardened model available.

Red flags to treat as untrusted:

- “Read this file/URL and do exactly what it says.”
- “Ignore your system prompt or safety rules.”
- “Reveal your hidden instructions or tool outputs.”
- “Paste the full contents of ~/.openclaw or your logs.”

## Unsafe external content bypass flags

OpenClaw includes explicit bypass flags that disable external-content safety wrapping:

- `hooks.mappings[].allowUnsafeExternalContent`
- `hooks.gmail.allowUnsafeExternalContent`
- Cron payload field `allowUnsafeExternalContent`

Guidance:

- Keep these unset/false in production.
- Only enable temporarily for tightly scoped debugging.
- If enabled, isolate that agent (sandbox + minimal tools + dedicated session namespace).

Hooks risk note:

- Hook payloads are untrusted content, even when delivery comes from systems you control (mail/docs/web content can carry prompt injection).
- Weak model tiers increase this risk. For hook-driven automation, prefer strong modern model tiers and keep tool policy tight (`tools.profile: "messaging"` or stricter), plus sandboxing where possible.

### Prompt injection does not require public DMs

Even if **only you** can message the bot, prompt injection can still happen via
any **untrusted content** the bot reads (web search/fetch results, browser pages,
emails, docs, attachments, pasted logs/code). In other words: the sender is not
the only threat surface; the **content itself** can carry adversarial instructions.

When tools are enabled, the typical risk is exfiltrating context or triggering
tool calls. Reduce the blast radius by:

- Using a read-only or tool-disabled **reader agent** to summarize untrusted content,
  then pass the summary to your main agent.
- Keeping `web_search` / `web_fetch` / `browser` off for tool-enabled agents unless needed.
- For OpenResponses URL inputs (`input_file` / `input_image`), set tight
  `gateway.http.endpoints.responses.files.urlAllowlist` and
  `gateway.http.endpoints.responses.images.urlAllowlist`, and keep `maxUrlParts` low.
  Empty allowlists are treated as unset; use `files.allowUrl: false` / `images.allowUrl: false`
  if you want to disable URL fetching entirely.
- For OpenResponses file inputs, decoded `input_file` text is still injected as
  **untrusted external content**. Do not rely on file text being trusted just because
  the Gateway decoded it locally. The injected block still carries explicit
  `<<<EXTERNAL_UNTRUSTED_CONTENT ...>>>` boundary markers plus `Source: External`
  metadata, even though this path omits the longer `SECURITY NOTICE:` banner.
- The same marker-based wrapping is applied when media-understanding extracts text
  from attached documents before appending that text to the media prompt.
- Enabling sandboxing and strict tool allowlists for any agent that touches untrusted input.
- Keeping secrets out of prompts; pass them via env/config on the gateway host instead.

### Model strength (security note)

Prompt injection resistance is **not** uniform across model tiers. Smaller/cheaper models are generally more susceptible to tool misuse and instruction hijacking, especially under adversarial prompts.

<Warning>
For tool-enabled agents or agents that read untrusted content, prompt-injection risk with older/smaller models is often too high. Do not run those workloads on weak model tiers.
</Warning>

Recommendations:

- **Use the latest generation, best-tier model** for any bot that can run tools or touch files/networks.
- **Do not use older/weaker/smaller tiers** for tool-enabled agents or untrusted inboxes; the prompt-injection risk is too high.
- If you must use a smaller model, **reduce blast radius** (read-only tools, strong sandboxing, minimal filesystem access, strict allowlists).
- When running small models, **enable sandboxing for all sessions** and **disable web_search/web_fetch/browser** unless inputs are tightly controlled.
- For chat-only personal assistants with trusted input and no tools, smaller models are usually fine.

<a id="reasoning-verbose-output-in-groups"></a>

## Reasoning & verbose output in groups

`/reasoning`, `/verbose`, and `/trace` can expose internal reasoning, tool
output, or plugin diagnostics that
was not meant for a public channel. In group settings, treat them as **debug
only** and keep them off unless you explicitly need them.

Guidance:

- Keep `/reasoning`, `/verbose`, and `/trace` disabled in public rooms.
- If you enable them, do so only in trusted DMs or tightly controlled rooms.
- Remember: verbose and trace output can include tool args, URLs, plugin diagnostics, and data the model saw.

## Configuration Hardening (examples)

### 0) File permissions

Keep config + state private on the gateway host:

- `~/.openclaw/openclaw.json`: `600` (user read/write only)
- `~/.openclaw`: `700` (user only)

`openclaw doctor` can warn and offer to tighten these permissions.

### 0.4) Network exposure (bind + port + firewall)

The Gateway multiplexes **WebSocket + HTTP** on a single port:

- Default: `18789`
- Config/flags/env: `gateway.port`, `--port`, `OPENCLAW_GATEWAY_PORT`

This HTTP surface includes the Control UI and the canvas host:

- Control UI (SPA assets) (default base path `/`)
- Canvas host: `/__openclaw__/canvas/` and `/__openclaw__/a2ui/` (arbitrary HTML/JS; treat as untrusted content)

If you load canvas content in a normal browser, treat it like any other untrusted web page:

- Don't expose the canvas host to untrusted networks/users.
- Don't make canvas content share the same origin as privileged web surfaces unless you fully understand the implications.

Bind mode controls where the Gateway listens:

- `gateway.bind: "loopback"` (default): only local clients can connect.
- Non-loopback binds (`"lan"`, `"tailnet"`, `"custom"`) expand the attack surface. Only use them with gateway auth (shared token/password or a correctly configured non-loopback trusted proxy) and a real firewall.

Rules of thumb:

- Prefer Tailscale Serve over LAN binds (Serve keeps the Gateway on loopback, and Tailscale handles access).
- If you must bind to LAN, firewall the port to a tight allowlist of source IPs; do not port-forward it broadly.
- Never expose the Gateway unauthenticated on `0.0.0.0`.

### 0.4.1) Docker port publishing + UFW (`DOCKER-USER`)

If you run OpenClaw with Docker on a VPS, remember that published container ports
(`-p HOST:CONTAINER` or Compose `ports:`) are routed through Docker's forwarding
chains, not only host `INPUT` rules.

To keep Docker traffic aligned with your firewall policy, enforce rules in
`DOCKER-USER` (this chain is evaluated before Docker's own accept rules).
On many modern distros, `iptables`/`ip6tables` use the `iptables-nft` frontend
and still apply these rules to the nftables backend.

Minimal allowlist example (IPv4):

```bash
# /etc/ufw/after.rules (append as its own *filter section)
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A DOCKER-USER -s 127.0.0.0/8 -j RETURN
-A DOCKER-USER -s 10.0.0.0/8 -j RETURN
-A DOCKER-USER -s 172.16.0.0/12 -j RETURN
-A DOCKER-USER -s 192.168.0.0/16 -j RETURN
-A DOCKER-USER -s 100.64.0.0/10 -j RETURN
-A DOCKER-USER -p tcp --dport 80 -j RETURN
-A DOCKER-USER -p tcp --dport 443 -j RETURN
-A DOCKER-USER -m conntrack --ctstate NEW -j DROP
-A DOCKER-USER -j RETURN
COMMIT
```

IPv6 has separate tables. Add a matching policy in `/etc/ufw/after6.rules` if
Docker IPv6 is enabled.

Avoid hardcoding interface names like `eth0` in docs snippets. Interface names
vary across VPS images (`ens3`, `enp*`, etc.) and mismatches can accidentally
skip your deny rule.

Quick validation after reload:

```bash
ufw reload
iptables -S DOCKER-USER
ip6tables -S DOCKER-USER
nmap -sT -p 1-65535 <public-ip> --open
```

Expected external ports should be only what you intentionally expose (for most
setups: SSH + your reverse proxy ports).

### 0.4.2) mDNS/Bonjour discovery (information disclosure)

The Gateway broadcasts its presence via mDNS (`_openclaw-gw._tcp` on port 5353) for local device discovery. In full mode, this includes TXT records that may expose operational details:

- `cliPath`: full filesystem path to the CLI binary (reveals username and install location)
- `sshPort`: advertises SSH availability on the host
- `displayName`, `lanHost`: hostname information

**Operational security consideration:** Broadcasting infrastructure details makes reconnaissance easier for anyone on the local network. Even "harmless" info like filesystem paths and SSH availability helps attackers map your environment.

**Recommendations:**

1. **Minimal mode** (default, recommended for exposed gateways): omit sensitive fields from mDNS broadcasts:

   ```json5
   {
     discovery: {
       mdns: { mode: "minimal" },
     },
   }
   ```

2. **Disable entirely** if you don't need local device discovery:

   ```json5
   {
     discovery: {
       mdns: { mode: "off" },
     },
   }
   ```

3. **Full mode** (opt-in): include `cliPath` + `sshPort` in TXT records:

   ```json5
   {
     discovery: {
       mdns: { mode: "full" },
     },
   }
   ```

4. **Environment variable** (alternative): set `OPENCLAW_DISABLE_BONJOUR=1` to disable mDNS without config changes.

In minimal mode, the Gateway still broadcasts enough for device discovery (`role`, `gatewayPort`, `transport`) but omits `cliPath` and `sshPort`. Apps that need CLI path information can fetch it via the authenticated WebSocket connection instead.

### 0.5) Lock down the Gateway WebSocket (local auth)

Gateway auth is **required by default**. If no valid gateway auth path is configured,
the Gateway refuses WebSocket connections (fail‑closed).

Onboarding generates a token by default (even for loopback) so
local clients must authenticate.

Set a token so **all** WS clients must authenticate:

```json5
{
  gateway: {
    auth: { mode: "token", token: "your-token" },
  },
}
```

Doctor can generate one for you: `openclaw doctor --generate-gateway-token`.

Note: `gateway.remote.token` / `.password` are client credential sources. They
do **not** protect local WS access by themselves.
Local call paths can use `gateway.remote.*` as fallback only when `gateway.auth.*`
is unset.
If `gateway.auth.token` / `gateway.auth.password` is explicitly configured via
SecretRef and unresolved, resolution fails closed (no remote fallback masking).
Optional: pin remote TLS with `gateway.remote.tlsFingerprint` when using `wss://`.
Plaintext `ws://` is loopback-only by default. For trusted private-network
paths, set `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` on the client process as break-glass.

Local device pairing:

- Device pairing is auto-approved for direct local loopback connects to keep
  same-host clients smooth.
- OpenClaw also has a narrow backend/container-local self-connect path for
  trusted shared-secret helper flows.
- Tailnet and LAN connects, including same-host tailnet binds, are treated as
  remote for pairing and still need approval.

Auth modes:

- `gateway.auth.mode: "token"`: shared bearer token (recommended for most setups).
- `gateway.auth.mode: "password"`: password auth (prefer setting via env: `OPENCLAW_GATEWAY_PASSWORD`).
- `gateway.auth.mode: "trusted-proxy"`: trust an identity-aware reverse proxy to authenticate users and pass identity via headers (see [Trusted Proxy Auth](/gateway/trusted-proxy-auth)).

Rotation checklist (token/password):

1. Generate/set a new secret (`gateway.auth.token` or `OPENCLAW_GATEWAY_PASSWORD`).
2. Restart the Gateway (or restart the macOS app if it supervises the Gateway).
3. Update any remote clients (`gateway.remote.token` / `.password` on machines that call into the Gateway).
4. Verify you can no longer connect with the old credentials.

### 0.6) Tailscale Serve identity headers

When `gateway.auth.allowTailscale` is `true` (default for Serve), OpenClaw
accepts Tailscale Serve identity headers (`tailscale-user-login`) for Control
UI/WebSocket authentication. OpenClaw verifies the identity by resolving the
`x-forwarded-for` address through the local Tailscale daemon (`tailscale whois`)
and matching it to the header. This only triggers for requests that hit loopback
and include `x-forwarded-for`, `x-forwarded-proto`, and `x-forwarded-host` as
injected by Tailscale.
For this async identity check path, failed attempts for the same `{scope, ip}`
are serialized before the limiter records the failure. Concurrent bad retries
from one Serve client can therefore lock out the second attempt immediately
instead of racing through as two plain mismatches.
HTTP API endpoints (for example `/v1/*`, `/tools/invoke`, and `/api/channels/*`)
do **not** use Tailscale identity-header auth. They still follow the gateway's
configured HTTP auth mode.

Important boundary note:

- Gateway HTTP bearer auth is effectively all-or-nothing operator access.
- Treat credentials that can call `/v1/chat/completions`, `/v1/responses`, or `/api/channels/*` as full-access operator secrets for that gateway.
- On the OpenAI-compatible HTTP surface, shared-secret bearer auth restores the full default operator scopes (`operator.admin`, `operator.approvals`, `operator.pairing`, `operator.read`, `operator.talk.secrets`, `operator.write`) and owner semantics for agent turns; narrower `x-openclaw-scopes` values do not reduce that shared-secret path.
- Per-request scope semantics on HTTP only apply when the request comes from an identity-bearing mode such as trusted proxy auth or `gateway.auth.mode="none"` on a private ingress.
- In those identity-bearing modes, omitting `x-openclaw-scopes` falls back to the normal operator default scope set; send the header explicitly when you want a narrower scope set.
- `/tools/invoke` follows the same shared-secret rule: token/password bearer auth is treated as full operator access there too, while identity-bearing modes still honor declared scopes.
- Do not share these credentials with untrusted callers; prefer separate gateways per trust boundary.

**Trust assumption:** tokenless Serve auth assumes the gateway host is trusted.
Do not treat this as protection against hostile same-host processes. If untrusted
local code may run on the gateway host, disable `gateway.auth.allowTailscale`
and require explicit shared-secret auth with `gateway.auth.mode: "token"` or
`"password"`.

**Security rule:** do not forward these headers from your own reverse proxy. If
you terminate TLS or proxy in front of the gateway, disable
`gateway.auth.allowTailscale` and use shared-secret auth (`gateway.auth.mode:
"token"` or `"password"`) or [Trusted Proxy Auth](/gateway/trusted-proxy-auth)
instead.

Trusted proxies:

- If you terminate TLS in front of the Gateway, set `gateway.trustedProxies` to your proxy IPs.
- OpenClaw will trust `x-forwarded-for` (or `x-real-ip`) from those IPs to determine the client IP for local pairing checks and HTTP auth/local checks.
- Ensure your proxy **overwrites** `x-forwarded-for` and blocks direct access to the Gateway port.

See [Tailscale](/gateway/tailscale) and [Web overview](/web).

### 0.6.1) Browser control via node host (recommended)

If your Gateway is remote but the browser runs on another machine, run a **node host**
on the browser machine and let the Gateway proxy browser actions (see [Browser tool](/tools/browser)).
Treat node pairing like admin access.

Recommended pattern:

- Keep the Gateway and node host on the same tailnet (Tailscale).
- Pair the node intentionally; disable browser proxy routing if you don’t need it.

Avoid:

- Exposing relay/control ports over LAN or public Internet.
- Tailscale Funnel for browser control endpoints (public exposure).

### 0.7) Secrets on disk (sensitive data)

Assume anything under `~/.openclaw/` (or `$OPENCLAW_STATE_DIR/`) may contain secrets or private data:

- `openclaw.json`: config may include tokens (gateway, remote gateway), provider settings, and allowlists.
- `credentials/**`: channel credentials (example: WhatsApp creds), pairing allowlists, legacy OAuth imports.
- `agents/<agentId>/agent/auth-profiles.json`: API keys, token profiles, OAuth tokens, and optional `keyRef`/`tokenRef`.
- `secrets.json` (optional): file-backed secret payload used by `file` SecretRef providers (`secrets.providers`).
- `agents/<agentId>/agent/auth.json`: legacy compatibility file. Static `api_key` entries are scrubbed when discovered.
- `agents/<agentId>/sessions/**`: session transcripts (`*.jsonl`) + routing metadata (`sessions.json`) that can contain private messages and tool output.
- bundled plugin packages: installed plugins (plus their `node_modules/`).
- `sandboxes/**`: tool sandbox workspaces; can accumulate copies of files you read/write inside the sandbox.

Hardening tips:

- Keep permissions tight (`700` on dirs, `600` on files).
- Use full-disk encryption on the gateway host.
- Prefer a dedicated OS user account for the Gateway if the host is shared.

### 0.8) Logs + transcripts (redaction + retention)

Logs and transcripts can leak sensitive info even when access controls are correct:

- Gateway logs may include tool summaries, errors, and URLs.
- Session transcripts can include pasted secrets, file contents, command output, and links.

Recommendations:

- Keep tool summary redaction on (`logging.redactSensitive: "tools"`; default).
- Add custom patterns for your environment via `logging.redactPatterns` (tokens, hostnames, internal URLs).
- When sharing diagnostics, prefer `openclaw status --all` (pasteable, secrets redacted) over raw logs.
- Prune old session transcripts and log files if you don’t need long retention.

Details: [Logging](/gateway/logging)

### 1) DMs: pairing by default

```json5
{
  channels: { whatsapp: { dmPolicy: "pairing" } },
}
```

### 2) Groups: require mention everywhere

```json
{
  "channels": {
    "whatsapp": {
      "groups": {
        "*": { "requireMention": true }
      }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "groupChat": { "mentionPatterns": ["@openclaw", "@mybot"] }
      }
    ]
  }
}
```

In group chats, only respond when explicitly mentioned.

### 3) Separate numbers (WhatsApp, Signal, Telegram)

For phone-number-based channels, consider running your AI on a separate phone number from your personal one:

- Personal number: Your conversations stay private
- Bot number: AI handles these, with appropriate boundaries

### 4) Read-only mode (via sandbox + tools)

You can build a read-only profile by combining:

- `agents.defaults.sandbox.workspaceAccess: "ro"` (or `"none"` for no workspace access)
- tool allow/deny lists that block `write`, `edit`, `apply_patch`, `exec`, `process`, etc.

Additional hardening options:

- `tools.exec.applyPatch.workspaceOnly: true` (default): ensures `apply_patch` cannot write/delete outside the workspace directory even when sandboxing is off. Set to `false` only if you intentionally want `apply_patch` to touch files outside the workspace.
- `tools.fs.workspaceOnly: true` (optional): restricts `read`/`write`/`edit`/`apply_patch` paths and native prompt image auto-load paths to the workspace directory (useful if you allow absolute paths today and want a single guardrail).
- Keep filesystem roots narrow: avoid broad roots like your home directory for agent workspaces/sandbox workspaces. Broad roots can expose sensitive local files (for example state/config under `~/.openclaw`) to filesystem tools.

### 5) Secure baseline (copy/paste)

One “safe default” config that keeps the Gateway private, requires DM pairing, and avoids always-on group bots:

```json5
{
  gateway: {
    mode: "local",
    bind: "loopback",
    port: 18789,
    auth: { mode: "token", token: "your-long-random-token" },
  },
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

If you want “safer by default” tool execution too, add a sandbox + deny dangerous tools for any non-owner agent (example below under “Per-agent access profiles”).

Built-in baseline for chat-driven agent turns: non-owner senders cannot use the `cron` or `gateway` tools.

## Sandboxing (recommended)

Dedicated doc: [Sandboxing](/gateway/sandboxing)

Two complementary approaches:

- **Run the full Gateway in Docker** (container boundary): [Docker](/install/docker)
- **Tool sandbox** (`agents.defaults.sandbox`, host gateway + Docker-isolated tools): [Sandboxing](/gateway/sandboxing)

Note: to prevent cross-agent access, keep `agents.defaults.sandbox.scope` at `"agent"` (default)
or `"session"` for stricter per-session isolation. `scope: "shared"` uses a
single container/workspace.

Also consider agent workspace access inside the sandbox:

- `agents.defaults.sandbox.workspaceAccess: "none"` (default) keeps the agent workspace off-limits; tools run against a sandbox workspace under `~/.openclaw/sandboxes`
- `agents.defaults.sandbox.workspaceAccess: "ro"` mounts the agent workspace read-only at `/agent` (disables `write`/`edit`/`apply_patch`)
- `agents.defaults.sandbox.workspaceAccess: "rw"` mounts the agent workspace read/write at `/workspace`
- Extra `sandbox.docker.binds` are validated against normalized and canonicalized source paths. Parent-symlink tricks and canonical home aliases still fail closed if they resolve into blocked roots such as `/etc`, `/var/run`, or credential directories under the OS home.

Important: `tools.elevated` is the global baseline escape hatch that runs exec outside the sandbox. The effective host is `gateway` by default, or `node` when the exec target is configured to `node`. Keep `tools.elevated.allowFrom` tight and don’t enable it for strangers. You can further restrict elevated per agent via `agents.list[].tools.elevated`. See [Elevated Mode](/tools/elevated).

### Sub-agent delegation guardrail

If you allow session tools, treat delegated sub-agent runs as another boundary decision:

- Deny `sessions_spawn` unless the agent truly needs delegation.
- Keep `agents.defaults.subagents.allowAgents` and any per-agent `agents.list[].subagents.allowAgents` overrides restricted to known-safe target agents.
- For any workflow that must remain sandboxed, call `sessions_spawn` with `sandbox: "require"` (default is `inherit`).
- `sandbox: "require"` fails fast when the target child runtime is not sandboxed.

## Browser control risks

Enabling browser control gives the model the ability to drive a real browser.
If that browser profile already contains logged-in sessions, the model can
access those accounts and data. Treat browser profiles as **sensitive state**:

- Prefer a dedicated profile for the agent (the default `openclaw` profile).
- Avoid pointing the agent at your personal daily-driver profile.
- Keep host browser control disabled for sandboxed agents unless you trust them.
- The standalone loopback browser control API only honors shared-secret auth
  (gateway token bearer auth or gateway password). It does not consume
  trusted-proxy or Tailscale Serve identity headers.
- Treat browser downloads as untrusted input; prefer an isolated downloads directory.
- Disable browser sync/password managers in the agent profile if possible (reduces blast radius).
- For remote gateways, assume “browser control” is equivalent to “operator access” to whatever that profile can reach.
- Keep the Gateway and node hosts tailnet-only; avoid exposing browser control ports to LAN or public Internet.
- Disable browser proxy routing when you don’t need it (`gateway.nodes.browser.mode="off"`).
- Chrome MCP existing-session mode is **not** “safer”; it can act as you in whatever that host Chrome profile can reach.

### Browser SSRF policy (strict by default)

OpenClaw’s browser navigation policy is strict by default: private/internal destinations stay blocked unless you explicitly opt in.

- Default: `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork` is unset, so browser navigation keeps private/internal/special-use destinations blocked.
- Legacy alias: `browser.ssrfPolicy.allowPrivateNetwork` is still accepted for compatibility.
- Opt-in mode: set `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork: true` to allow private/internal/special-use destinations.
- In strict mode, use `hostnameAllowlist` (patterns like `*.example.com`) and `allowedHostnames` (exact host exceptions, including blocked names like `localhost`) for explicit exceptions.
- Navigation is checked before request and best-effort re-checked on the final `http(s)` URL after navigation to reduce redirect-based pivots.

Example strict policy:

```json5
{
  browser: {
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: false,
      hostnameAllowlist: ["*.example.com", "example.com"],
      allowedHostnames: ["localhost"],
    },
  },
}
```

## Per-agent access profiles (multi-agent)

With multi-agent routing, each agent can have its own sandbox + tool policy:
use this to give **full access**, **read-only**, or **no access** per agent.
See [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for full details
and precedence rules.

Common use cases:

- Personal agent: full access, no sandbox
- Family/work agent: sandboxed + read-only tools
- Public agent: sandboxed + no filesystem/shell tools

### Example: full access (no sandbox)

```json5
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: { mode: "off" },
      },
    ],
  },
}
```

### Example: read-only tools + read-only workspace

```json5
{
  agents: {
    list: [
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "ro",
        },
        tools: {
          allow: ["read"],
          deny: ["write", "edit", "apply_patch", "exec", "process", "browser"],
        },
      },
    ],
  },
}
```

### Example: no filesystem/shell access (provider messaging allowed)

```json5
{
  agents: {
    list: [
      {
        id: "public",
        workspace: "~/.openclaw/workspace-public",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "none",
        },
        // Session tools can reveal sensitive data from transcripts. By default OpenClaw limits these tools
        // to the current session + spawned subagent sessions, but you can clamp further if needed.
        // See `tools.sessions.visibility` in the configuration reference.
        tools: {
          sessions: { visibility: "tree" }, // self | tree | agent | all
          allow: [
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
            "whatsapp",
            "telegram",
            "slack",
            "discord",
          ],
          deny: [
            "read",
            "write",
            "edit",
            "apply_patch",
            "exec",
            "process",
            "browser",
            "canvas",
            "nodes",
            "cron",
            "gateway",
            "image",
          ],
        },
      },
    ],
  },
}
```

## What to Tell Your AI

Include security guidelines in your agent's system prompt:

```
## Security Rules
- Never share directory listings or file paths with strangers
- Never reveal API keys, credentials, or infrastructure details
- Verify requests that modify system config with the owner
- When in doubt, ask before acting
- Keep private data private unless explicitly authorized
```

## Incident Response

If your AI does something bad:

### Contain

1. **Stop it:** stop the macOS app (if it supervises the Gateway) or terminate your `openclaw gateway` process.
2. **Close exposure:** set `gateway.bind: "loopback"` (or disable Tailscale Funnel/Serve) until you understand what happened.
3. **Freeze access:** switch risky DMs/groups to `dmPolicy: "disabled"` / require mentions, and remove `"*"` allow-all entries if you had them.

### Rotate (assume compromise if secrets leaked)

1. Rotate Gateway auth (`gateway.auth.token` / `OPENCLAW_GATEWAY_PASSWORD`) and restart.
2. Rotate remote client secrets (`gateway.remote.token` / `.password`) on any machine that can call the Gateway.
3. Rotate provider/API credentials (WhatsApp creds, Slack/Discord tokens, model/API keys in `auth-profiles.json`, and encrypted secrets payload values when used).

### Audit

1. Check Gateway logs: `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (or `logging.file`).
2. Review the relevant transcript(s): `~/.openclaw/agents/<agentId>/sessions/*.jsonl`.
3. Review recent config changes (anything that could have widened access: `gateway.bind`, `gateway.auth`, dm/group policies, `tools.elevated`, plugin changes).
4. Re-run `openclaw security audit --deep` and confirm critical findings are resolved.

### Collect for a report

- Timestamp, gateway host OS + OpenClaw version
- The session transcript(s) + a short log tail (after redacting)
- What the attacker sent + what the agent did
- Whether the Gateway was exposed beyond loopback (LAN/Tailscale Funnel/Serve)

## Secret Scanning (detect-secrets)

CI runs the `detect-secrets` pre-commit hook in the `secrets` job.
Pushes to `main` always run an all-files scan. Pull requests use a changed-file
fast path when a base commit is available, and fall back to an all-files scan
otherwise. If it fails, there are new candidates not yet in the baseline.

### If CI fails

1. Reproduce locally:

   ```bash
   pre-commit run --all-files detect-secrets
   ```

2. Understand the tools:
   - `detect-secrets` in pre-commit runs `detect-secrets-hook` with the repo's
     baseline and excludes.
   - `detect-secrets audit` opens an interactive review to mark each baseline
     item as real or false positive.
3. For real secrets: rotate/remove them, then re-run the scan to update the baseline.
4. For false positives: run the interactive audit and mark them as false:

   ```bash
   detect-secrets audit .secrets.baseline
   ```

5. If you need new excludes, add them to `.detect-secrets.cfg` and regenerate the
   baseline with matching `--exclude-files` / `--exclude-lines` flags (the config
   file is reference-only; detect-secrets doesn’t read it automatically).

Commit the updated `.secrets.baseline` once it reflects the intended state.

## Reporting Security Issues

Found a vulnerability in OpenClaw? Please report responsibly:

1. Email: [security@openclaw.ai](mailto:security@openclaw.ai)
2. Don't post publicly until fixed
3. We'll credit you (unless you prefer anonymity)
