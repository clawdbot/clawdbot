---
summary: "Trust model, safe defaults, and hardening guidance for running OpenClaw"
read_when:
  - Adding features that widen access or automation
  - Reviewing OpenClaw security posture or hardening a deployment
title: "Security"
---

OpenClaw ships with conservative defaults. On a regular host install the Gateway binds to loopback; most chat channels answer an unknown DM sender with a pairing code instead of processing the message; and group access is allowlisted, usually behind a mention gate. The exceptions are deliberate and documented: container images default to an exposed bind (pair that with auth - see the [exposure runbook](/gateway/security/exposure-runbook)), and a few workspace channels such as ClickClack trust workspace membership by default - each channel page states its exact defaults. Run on those defaults and you are in good shape, and one command tells you if you have drifted:

```bash
openclaw security audit
```

The pages below are the deep end: the trust model, what the audit checks, and how to harden further as you expose more surface.

<Note>
  **One trust boundary per gateway.** This guidance assumes one trusted
  boundary per gateway: a single operator, or a team whose members trust
  each other. Group chats and [multi-user](/concepts/multi-user) operation
  are supported deployments inside that boundary. OpenClaw is not a hostile
  multi-tenant security boundary for mutually adversarial users sharing one
  agent or gateway. For mixed-trust or adversarial-user operation, split
  trust boundaries: separate gateway + credentials, ideally separate OS
  users or hosts.
</Note>

## Security pages

Understand the model:

- [Security trust model](/gateway/security/trust-model) - One trust boundary per gateway, the boundary matrix, and the findings closed as no-action.
- [Running the security audit](/gateway/security/running-the-audit) - What `openclaw security audit` checks and the order to fix findings in.
- [Security audit checks](/gateway/security/audit-checks) - Reference catalog of every `checkId`, its severity, and its auto-fix support.

Harden a deployment:

- [Hardened baselines](/gateway/security/hardened-baseline) - Copy/paste configs that keep the Gateway local, paired, and tool-restricted.
- [Access control and allowlists](/gateway/security/access-control) - DM policy, allowlists, DM session isolation, context visibility, command authorization.
- [Prompt injection](/gateway/security/prompt-injection) - Untrusted content reaching the model, model choice, and the wrapping that bounds it.
- [Tool and agent permissions](/gateway/security/tool-permissions) - Control-plane tools, node execution, plugins, sandboxing, per-agent profiles.
- [Browser control risks](/gateway/security/browser-control) - What a real browser exposes, and the SSRF policy that bounds it.
- [Network exposure](/gateway/security/network-exposure) - Bind, firewall, discovery, Gateway auth, Tailscale, reverse proxy, dangerous flags.
- [Secrets, storage, and logs](/gateway/security/secrets-and-storage) - What lands on disk, which files hold credentials, and what transcripts contain.
- [Secure file operations](/gateway/security/secure-file-operations) - Root-bounded file access, atomic writes, and archive extraction helpers.
- [Dependency locking](/gateway/security/dependency-locking) - How published packages pin and resolve their dependency graph.

Expose and operate:

- [Gateway exposure runbook](/gateway/security/exposure-runbook) - Pre-flight and rollback checklist before exposing the Gateway beyond loopback.
- [Rate limiting](/gateway/security/rate-limiting) - Every Gateway rate limit: lockouts, throttles, caps, and cooldowns.
- [Operator incident response](/gateway/security/operator-incident-response) - Contain, rotate, audit, and collect evidence after a suspected compromise.

## Where each section moved

Every anchor this page used to publish still resolves here. Each entry below carries the original anchor and links to its new home.

**[Security trust model](/gateway/security/trust-model)**

- <a id="scope%3A-one-trust-boundary-per-gateway" /><a id="scope-one-trust-boundary-per-gateway" />[Scope: one trust boundary per gateway](/gateway/security/trust-model#scope-one-trust-boundary-per-gateway)
- <a id="trust-boundary-matrix" />[Trust boundary matrix](/gateway/security/trust-model#trust-boundary-matrix)
- <a id="not-vulnerabilities-by-design" />[Not vulnerabilities by design](/gateway/security/trust-model#not-vulnerabilities-by-design)
- <a id="common-findings-closed-as-no-action" />[Common findings closed as no-action](/gateway/security/trust-model#common-findings-closed-as-no-action)
- <a id="gateway-and-node-trust" />[Gateway and node trust](/gateway/security/trust-model#gateway-and-node-trust)
- <a id="threat-model" />[Threat model](/gateway/security/trust-model#threat-model)
- <a id="reporting-security-issues" />[Reporting security issues](/gateway/security/trust-model#reporting-security-issues)

**[Running the security audit](/gateway/security/running-the-audit)**

- <a id="openclaw-security-audit" />[`openclaw security audit`](/gateway/security/running-the-audit#openclaw-security-audit)
- <a id="what-the-audit-checks-(high-level)" /><a id="what-the-audit-checks-high-level" />[What the audit checks (high level)](/gateway/security/running-the-audit#what-the-audit-checks-high-level)
- <a id="priority-order-when-triaging-findings" />[Priority order when triaging findings](/gateway/security/running-the-audit#priority-order-when-triaging-findings)

**[Hardened baselines](/gateway/security/hardened-baseline)**

- <a id="hardened-baseline-in-60-seconds" />[Hardened baseline in 60 seconds](/gateway/security/hardened-baseline#hardened-baseline-in-60-seconds)
- <a id="requester-scoped-controls-and-prompt-context" />[Requester-scoped controls and prompt context](/gateway/security/hardened-baseline#requester-scoped-controls-and-prompt-context)
- <a id="secure-baseline-(copy%2Fpaste)" /><a id="secure-baseline-copy/paste" />[Secure baseline (copy/paste)](/gateway/security/hardened-baseline#secure-baseline-copy/paste)
- <a id="separate-numbers-(whatsapp%2C-signal%2C-telegram)" /><a id="separate-numbers-whatsapp-signal-telegram" />[Separate numbers (WhatsApp, Signal, Telegram)](/gateway/security/hardened-baseline#separate-numbers-whatsapp-signal-telegram)

**[Access control and allowlists](/gateway/security/access-control)**

- <a id="dm-access%3A-pairing%2C-allowlist%2C-open%2C-disabled" /><a id="dm-access-pairing-allowlist-open-disabled" />[DM access: pairing, allowlist, open, disabled](/gateway/security/access-control#dm-access-pairing-allowlist-open-disabled)
- <a id="allowlists-(two-layers)" /><a id="allowlists-two-layers" />[Allowlists (two layers)](/gateway/security/access-control#allowlists-two-layers)
- <a id="dm-session-isolation-(multi-user-mode)" /><a id="dm-session-isolation-multi-user-mode" />[DM session isolation (multi-user mode)](/gateway/security/access-control#dm-session-isolation-multi-user-mode)
- <a id="context-visibility-vs-trigger-authorization" />[Context visibility vs trigger authorization](/gateway/security/access-control#context-visibility-vs-trigger-authorization)
- <a id="command-authorization" />[Command authorization](/gateway/security/access-control#command-authorization)

**[Prompt injection](/gateway/security/prompt-injection)**

- <a id="prompt-injection" />[Prompt injection](/gateway/security/prompt-injection#prompt-injection)
- <a id="external-content-and-untrusted-input-wrapping" />[External content and untrusted-input wrapping](/gateway/security/prompt-injection#external-content-and-untrusted-input-wrapping)
- <a id="bypass-flags-(keep-off-in-production)" /><a id="bypass-flags-keep-off-in-production" />[Bypass flags (keep off in production)](/gateway/security/prompt-injection#bypass-flags-keep-off-in-production)
- <a id="reasoning-and-verbose-output-in-groups" />[Reasoning and verbose output in groups](/gateway/security/prompt-injection#reasoning-and-verbose-output-in-groups)

**[Tool and agent permissions](/gateway/security/tool-permissions)**

- <a id="control-plane-tools" />[Control plane tools](/gateway/security/tool-permissions#control-plane-tools)
- <a id="node-execution-(system.run)" /><a id="node-execution-system-run" />[Node execution (`system.run`)](/gateway/security/tool-permissions#node-execution-system-run)
- <a id="dynamic-skills-(watcher-%2F-remote-nodes)" /><a id="dynamic-skills-watcher-/-remote-nodes" />[Dynamic skills (watcher / remote nodes)](/gateway/security/tool-permissions#dynamic-skills-watcher-/-remote-nodes)
- <a id="plugins" />[Plugins](/gateway/security/tool-permissions#plugins)
- <a id="sandboxing" />[Sandboxing](/gateway/security/tool-permissions#sandboxing)
- <a id="sub-agent-delegation-guardrail" />[Sub-agent delegation guardrail](/gateway/security/tool-permissions#sub-agent-delegation-guardrail)
- <a id="read-only-mode" />[Read-only mode](/gateway/security/tool-permissions#read-only-mode)
- <a id="per-agent-access-profiles-(multi-agent)" /><a id="per-agent-access-profiles-multi-agent" />[Per-agent access profiles (multi-agent)](/gateway/security/tool-permissions#per-agent-access-profiles-multi-agent)
- <a id="full-access-(no-sandbox)" /><a id="full-access-no-sandbox" />[Full access (no sandbox)](/gateway/security/tool-permissions#full-access-no-sandbox)
- <a id="read-only-tools-%2B-read-only-workspace" /><a id="read-only-tools-+-read-only-workspace" />[Read-only tools + read-only workspace](/gateway/security/tool-permissions#read-only-tools-+-read-only-workspace)
- <a id="no-filesystem%2Fshell-access-(provider-messaging-allowed)" /><a id="no-filesystem/shell-access-provider-messaging-allowed" />[No filesystem/shell access (provider messaging allowed)](/gateway/security/tool-permissions#no-filesystem/shell-access-provider-messaging-allowed)

**[Browser control risks](/gateway/security/browser-control)**

- <a id="browser-control-risks" />[Browser control risks](/gateway/security/browser-control#browser-control-risks)
- <a id="browser-ssrf-policy-(strict-by-default)" /><a id="browser-ssrf-policy-strict-by-default" />[Browser SSRF policy (strict by default)](/gateway/security/browser-control#browser-ssrf-policy-strict-by-default)

**[Network exposure](/gateway/security/network-exposure)**

- <a id="network-exposure" />[Network exposure](/gateway/security/network-exposure#network-exposure)
- <a id="bind%2C-port%2C-firewall" /><a id="bind-port-firewall" />[Bind, port, firewall](/gateway/security/network-exposure#bind-port-firewall)
- <a id="docker-port-publishing-with-ufw" />[Docker port publishing with UFW](/gateway/security/network-exposure#docker-port-publishing-with-ufw)
- <a id="mdns%2Fbonjour-discovery" /><a id="mdns/bonjour-discovery" />[mDNS/Bonjour discovery](/gateway/security/network-exposure#mdns/bonjour-discovery)
- <a id="gateway-websocket-auth" />[Gateway WebSocket auth](/gateway/security/network-exposure#gateway-websocket-auth)
- <a id="tailscale-serve-identity-headers" />[Tailscale Serve identity headers](/gateway/security/network-exposure#tailscale-serve-identity-headers)
- <a id="reverse-proxy-configuration" />[Reverse proxy configuration](/gateway/security/network-exposure#reverse-proxy-configuration)
- <a id="hsts-and-origin-notes" />[HSTS and origin notes](/gateway/security/network-exposure#hsts-and-origin-notes)
- <a id="control-ui-over-http" />[Control UI over HTTP](/gateway/security/network-exposure#control-ui-over-http)
- <a id="insecure%2Fdangerous-flags" /><a id="insecure/dangerous-flags" />[Insecure/dangerous flags](/gateway/security/network-exposure#insecure/dangerous-flags)
- <a id="flags-tracked-by-the-audit-today" />[Flags tracked by the audit today](/gateway/security/network-exposure#flags-tracked-by-the-audit-today)
- <a id="all-dangerous-dangerously-keys-in-the-config-schema" />[All dangerous*/dangerously* keys in the config schema](/gateway/security/network-exposure#all-dangerous-dangerously-keys-in-the-config-schema)

**[Secrets, storage, and logs](/gateway/security/secrets-and-storage)**

- <a id="deployment-and-host-trust" />[Deployment and host trust](/gateway/security/secrets-and-storage#deployment-and-host-trust)
- <a id="secrets-on-disk" />[Secrets on disk](/gateway/security/secrets-and-storage#secrets-on-disk)
- <a id="credential-storage-map" />[Credential storage map](/gateway/security/secrets-and-storage#credential-storage-map)
- <a id="file-permissions" />[File permissions](/gateway/security/secrets-and-storage#file-permissions)
- <a id="workspace-.env-files" /><a id="workspace-env-files" />[Workspace `.env` files](/gateway/security/secrets-and-storage#workspace-env-files)
- <a id="logs-and-transcripts" />[Logs and transcripts](/gateway/security/secrets-and-storage#logs-and-transcripts)
- <a id="secret-scanning" />[Secret scanning](/gateway/security/secrets-and-storage#secret-scanning)

**[Operator incident response](/gateway/security/operator-incident-response)**

- <a id="incident-response" />[Incident response](/gateway/security/operator-incident-response#incident-response)
- <a id="contain" />[Contain](/gateway/security/operator-incident-response#contain)
- <a id="rotate-(assume-compromise-if-secrets-leaked)" /><a id="rotate-assume-compromise-if-secrets-leaked" />[Rotate (assume compromise if secrets leaked)](/gateway/security/operator-incident-response#rotate-assume-compromise-if-secrets-leaked)
- <a id="audit" />[Audit](/gateway/security/operator-incident-response#audit)
- <a id="collect-for-a-report" />[Collect for a report](/gateway/security/operator-incident-response#collect-for-a-report)
