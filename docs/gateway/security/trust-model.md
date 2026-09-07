---
summary: "The trust boundary OpenClaw supports, the controls it does and does not provide, and how to report a vulnerability"
read_when:
  - Deciding whether one Gateway can serve a set of users
  - Triaging a security report against the documented trust boundary
  - Reporting a suspected vulnerability in OpenClaw
title: "Security trust model"
sidebarTitle: "Trust model"
---

## Scope: one trust boundary per gateway

- Supported: one trust boundary per gateway - a single operator or a mutually trusting team (prefer one OS user/host/VPS per boundary).
- Not supported: one shared gateway/agent used by mutually untrusted or adversarial users.
- Adversarial-user isolation needs separate gateways (and ideally separate OS users/hosts).
- Everyone who can message a tool-enabled agent shares that agent's delegated tool authority. That is fine for teammates who already trust each other; it is why adversarial users cannot share an agent.
- Session tools reach across the whole Gateway by default: `tools.sessions.visibility` defaults to `all` and `tools.agentToAgent.enabled` defaults to `true`, so any tool-enabled agent running unsandboxed can list, read, search, and message every agent's sessions, including other users' transcripts. Sandboxed sessions stay clamped to their own spawn tree by default, which limits them as callers but does not hide their transcripts from unsandboxed agents. That matches one trust boundary per Gateway. For personas with different trust levels on one Gateway, set `tools.sessions.visibility` to `agent` or `self` (`tree` still admits requester-owned native and ACP children across agents), restrict pairs with `tools.agentToAgent.allow`, or set `tools.agentToAgent.enabled: false`. See [`tools.sessions`](/gateway/config-tools#tools-sessions) and [`tools.agentToAgent`](/gateway/config-tools#tools-agenttoagent).
- If someone can modify Gateway host state/config (`~/.openclaw`, including `openclaw.json`), treat them as a trusted operator.
- Inside one Gateway, authenticated operator access is a trusted control-plane role, not a per-user tenant role. [Named operator roles](/gateway/operator-scopes#named-operator-roles) bound what each teammate's connections can do; they are collaboration guardrails, not tenant isolation.
- `sessionKey` (session IDs, labels) is a routing selector, not an authorization token.

Hosting multiple users or organizations? Run one isolated Gateway cell per tenant instead of sharing a Gateway. See [Multi-tenant hosting](/gateway/multi-tenant-hosting).

Before changing remote access, DM policy, reverse proxy, or public exposure, run through the [Gateway exposure runbook](/gateway/security/exposure-runbook) as a pre-flight/rollback checklist.

## Trust boundary matrix

Quick model for triaging risk reports:

| Boundary or control                                       | What it means                                                         | Common misread                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `gateway.auth` (token/password/trusted-proxy/device auth) | Authenticates callers to gateway APIs                                 | "Needs per-message signatures on every frame to be secure"                    |
| `sessionKey`                                              | Routing key for context/session selection                             | "Session key is a user auth boundary"                                         |
| Prompt/content guardrails                                 | Reduce model abuse risk                                               | "Prompt injection alone proves auth bypass"                                   |
| Browser evaluate                                          | Intentional operator capability when enabled                          | "Any JS eval primitive is automatically a vuln in this trust model"           |
| Local TUI `!` shell                                       | Explicit operator-triggered local execution                           | "Local shell convenience command is remote injection"                         |
| Node pairing and node commands                            | Operator-level remote execution on paired devices                     | "Remote device control should be treated as untrusted user access by default" |
| `gateway.nodes.pairing.autoApproveCidrs`                  | Opt-in trusted-network node enrollment policy                         | "A disabled-by-default allowlist is an automatic pairing vulnerability"       |
| `gateway.nodes.pairing.sshVerify`                         | Key-verified node enrollment over operator SSH                        | "Default-on auto-approval is an automatic pairing vulnerability"              |
| `tools.sessions.visibility` / `tools.agentToAgent`        | Session-tool reach inside one Gateway; Gateway-wide and on by default | "Default cross-agent session access is a tenant-isolation bypass"             |

## Not vulnerabilities by design

<Accordion title="Common findings closed as no-action">

- Prompt-injection-only chains without a policy, auth, or sandbox bypass.
- Claims that assume hostile multi-tenant operation on one shared host or config.
- Normal operator read-path access (for example `sessions.list` / `sessions.preview` / `chat.history`) classified as IDOR in a shared-gateway setup.
- Localhost-only deployment findings (for example missing HSTS on a loopback-only gateway).
- Discord inbound webhook signature findings for inbound paths that do not exist in this repo.
- Node pairing metadata treated as a hidden second per-command approval layer for `system.run`; the real execution boundary is the gateway's global node command policy plus the node's own exec approvals.
- `gateway.nodes.pairing.sshVerify` treated as a vulnerability because it is enabled by default. It never approves on network locality or SSH reachability alone: the gateway reads the device identity back over SSH (BatchMode, strict host keys) and approves only on an exact device-key match with the pending request, which requires the connecting keypair to already live under the operator's account on a host the operator controls. Probes are bounded to private/CGNAT source addresses, share the trusted-CIDR eligibility floor (fresh scopeless `role: node` only), and `sshVerify: false` turns the feature off.
- `gateway.nodes.pairing.autoApproveCidrs` treated as a vulnerability by itself. It is disabled by default, requires explicit CIDR/IP entries, only applies to first-time `role: node` pairing with no requested scopes, and never auto-approves operator/browser/Control UI, WebChat, role/scope upgrades, metadata or public-key changes, or same-host loopback trusted-proxy header paths (even when loopback trusted-proxy auth is enabled).
- "Missing per-user authorization" findings that treat `sessionKey` as an auth token.
- Default Gateway-wide session visibility or default-on agent-to-agent messaging treated as a vulnerability on its own. The audit reports plain multi-agent defaults as `info`, not a vulnerability finding, and escalates to `warn` only with trust-boundary signals. One Gateway is one trust boundary; narrow `tools.sessions.visibility` or `tools.agentToAgent` for persona separation, and run separate gateways for adversarial users.

</Accordion>

## Gateway and node trust

Treat Gateway and node as one operator trust domain with different roles:

- **Gateway**: control plane and policy surface (`gateway.auth`, tool policy, routing).
- **Node**: remote execution surface paired to that Gateway (commands, device actions, host-local capabilities).
- A caller authenticated to the Gateway is trusted at Gateway scope; after pairing, node actions are trusted operator actions on that node. See [Operator scopes](/gateway/operator-scopes).
- Direct loopback backend clients authenticated with the shared gateway token/password can make internal control-plane RPCs without presenting a user device identity. This is not a remote or browser pairing bypass - network clients, node clients, device-token clients, and explicit device identities still go through pairing and scope-upgrade enforcement.
- Exec approvals (allowlist + ask) are guardrails for operator intent, not hostile multi-tenant isolation. They bind exact request context and best-effort direct local file operands; they do not semantically model every runtime/interpreter loader path. Use sandboxing and host isolation for strong boundaries.
- Trusted single-operator default: host exec on `gateway`/`node` is allowed without approval prompts (`security="full"`, `ask="off"`). That is intentional UX, not a vulnerability by itself.

For hostile-user isolation, split trust boundaries by OS user/host and run separate gateways.

## Threat model

Your AI assistant can execute arbitrary shell commands, read/write files, access network services, and send messages to anyone (if given channel access). People who message it can try to trick it into doing bad things, social-engineer access to your data, or probe for infrastructure details.

Most failures here are not exotic exploits - they are "someone messaged the bot and the bot did what they asked." OpenClaw's stance, in order:

1. **Identity first** - decide who can talk to the bot (DM pairing / allowlists / explicit "open").
2. **Scope next** - decide where the bot can act (group allowlists + mention gating, tools, sandboxing, device permissions).
3. **Model last** - assume the model can be manipulated; design so manipulation has limited blast radius.

## Reporting security issues

Found a vulnerability in OpenClaw? Report responsibly:

1. Email: [security@openclaw.ai](mailto:security@openclaw.ai)
2. Do not post publicly until fixed.
3. We will credit you (unless you prefer anonymity).
