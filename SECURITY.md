# Security Policy

If you believe you've found a security issue in OpenClaw, report it privately first.

This policy does two things: it gives researchers a clear disclosure path, and it spells out the trust model maintainers use when triaging reports. OpenClaw is local-first agent infrastructure for trusted operators; it is not designed as a shared multi-tenant boundary between adversarial users on one gateway.

The fastest useful reports show a current, reproducible boundary bypass with demonstrated impact. Scanner output, prompt-injection-only chains, or reports that rely on hostile users sharing one trusted gateway are usually not security vulnerabilities under this model.

Security work is shared across a number of OpenClaw maintainers, including engineers and security researchers from organizations such as NVIDIA and Tencent. See the [maintainer list](CONTRIBUTING.md#maintainers).

## Report a Security Issue

Report vulnerabilities directly to the repository where the issue lives:

- **Core CLI and gateway** — [openclaw/openclaw](https://github.com/openclaw/openclaw)
- **macOS desktop app** — [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/macos)
- **iOS app** — [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/ios)
- **Android app** — [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/android)
- **ClawHub** — [openclaw/clawhub](https://github.com/openclaw/clawhub)
- **Trust and threat model** — [openclaw/trust](https://github.com/openclaw/trust)

For issues that don't fit a specific repo, or if you're unsure, email **[security@openclaw.ai](mailto:security@openclaw.ai)** and we'll route it.

For OpenClaw core issues, submit through a private [GitHub Security Advisory](https://github.com/openclaw/openclaw/security/advisories/new). Do not open a public issue or PR that discloses an unpatched vulnerability, exploit path, secret, or security-sensitive proof of concept.

Maintainers may close, hide, delete, or otherwise take down public issues and PRs that disclose vulnerabilities or active security issues. We will redirect those reports through the private disclosure process so the issue can be triaged and fixed without giving attackers a public playbook.

For full reporting instructions see our [Trust page](https://trust.openclaw.ai).

OpenClaw does not currently run a paid bug bounty program. Please still disclose responsibly so we can fix real issues quickly. The best way to help the project right now is to send high-signal reports and, when practical, focused PRs.

### What We Need

Make the report easy to reproduce and easy to route:

- What you found and why you believe it is security-relevant.
- The affected component, version, and commit SHA when possible.
- Reproduction steps or a proof of concept against latest `main` or the latest released version.
- The actual impact, including which OpenClaw trust boundary is crossed.
- Any remediation advice or focused patch you can provide.

Reports without reproduction steps, demonstrated impact, and remediation advice are deprioritized. We receive a high volume of AI-generated scanner findings, so we prioritize vetted reports from researchers who can show how the issue crosses an OpenClaw security boundary.

### What Usually Is Not a Security Bug

These patterns are usually not vulnerabilities by themselves:

- Prompt injection without a policy, auth, approval, sandbox, or tool-boundary bypass.
- A trusted operator using an intentional local feature, such as local shell access or browser/script execution.
- A malicious plugin after a trusted operator installs or enables it.
- Multiple adversarial users sharing one Gateway host/config and expecting per-user isolation.
- Scanner-only, dependency-only, or stale-path reports without a working repro and demonstrated OpenClaw impact.
- Public internet exposure or risky deployment choices that the docs already recommend against.

If you are unsure, report privately. We would rather route a careful report than miss a real boundary issue.

### Duplicate Report Handling

- Search existing advisories before filing.
- Include likely duplicate GHSA IDs in your report when applicable.
- Maintainers may close lower-quality/later duplicates in favor of the earliest high-quality canonical report.

## Security Posture and Report Rules

The sections below are the normative posture maintainers use for report triage. The headings are editorial; the policy text defines the boundary.

### Detailed Report Acceptance Gate

For fastest triage, include all of the following:

- Exact vulnerable path (`file`, function, and line range) on a current revision.
- Tested version details (OpenClaw version and/or commit SHA).
- Reproducible PoC against latest `main` or latest released version.
- If the claim targets a released version, evidence from the shipped tag and published artifact/package for that exact version (not only `main`).
- For dependency CVE reports, evidence that the shipped dependency version is actually affected, plus a PoC that reproduces impact through OpenClaw. Showing that OpenClaw can reach a native parser is not enough by itself.
- Demonstrated impact tied to OpenClaw's documented trust boundaries.
- For exposed-secret reports: proof the credential is OpenClaw-owned (or grants access to OpenClaw-operated infrastructure/services).
- Explicit statement that the report does not rely on adversarial operators sharing one gateway host/config.
- Scope check explaining why the report is **not** covered by the Out of Scope section below.
- For command-risk/parity reports (for example obfuscation detection differences), a concrete boundary-bypass path is required (auth/approval/allowlist/sandbox). Parity-only findings are treated as hardening, not vulnerabilities.

Reports that miss these requirements may be closed as `invalid` or `no-action`.

### Detailed False-Positive Patterns

These are frequently reported but are typically closed with no code change:

- Prompt-injection-only chains without a boundary bypass (prompt injection is out of scope).
- Operator-intended local features (for example TUI local `!` shell) presented as remote injection.
- Reports that treat explicit operator-control surfaces (for example `canvas.eval`, browser evaluate/script execution, or direct `node.invoke` execution primitives) as vulnerabilities without demonstrating an auth/policy/sandbox boundary bypass. These capabilities are intentional when enabled and are trusted-operator features, not standalone security bugs.
- Authorized user-triggered local actions presented as privilege escalation. Example: an allowlisted/owner sender running `/export-session /absolute/path.html` to write on the host. In this trust model, authorized user actions are trusted host actions unless you demonstrate an auth/sandbox/boundary bypass.
- Reports that only show a malicious plugin executing privileged actions after a trusted operator installs/enables it.
- Reports that assume per-user multi-tenant authorization on a shared gateway host/config.
- Reports that only show quoted/replied/thread/forwarded supplemental context from non-allowlisted senders being visible to the model, without demonstrating an auth, policy, approval, or sandbox boundary bypass.
- Reports that treat the Gateway HTTP compatibility endpoints (`POST /v1/chat/completions`, `POST /v1/responses`) as if they implemented scoped operator auth (`operator.write` vs `operator.admin`). These endpoints authenticate the shared Gateway bearer secret/password and are documented full operator-access surfaces, not per-user/per-scope boundaries.
- Reports that assume `x-openclaw-scopes` can reduce or redefine shared-secret bearer auth on the OpenAI-compatible HTTP endpoints. For shared-secret auth (`gateway.auth.mode="token"` or `"password"`), those endpoints ignore narrower bearer-declared scopes and restore the full default operator scope set plus owner semantics.
- Reports that treat `POST /tools/invoke` under shared-secret bearer auth (`gateway.auth.mode="token"` or `"password"`) as a narrower per-request/per-scope authorization surface. That endpoint is designed as the same trusted-operator HTTP boundary: shared-secret bearer auth is full operator access there, narrower `x-openclaw-scopes` values do not reduce that path, and owner-only tool policy follows the shared-secret operator contract.
- Reports that only show differences in heuristic detection/parity (for example obfuscation-pattern detection on one exec path but not another, such as `node.invoke -> system.run` parity gaps) without demonstrating bypass of auth, approvals, allowlist enforcement, sandboxing, or other documented trust boundaries.
- Reports that only show an ACP tool can indirectly execute, mutate, orchestrate sessions, or reach another tool/runtime without demonstrating bypass of ACP prompt/approval, allowlist enforcement, sandboxing, or another documented trust boundary. ACP silent approval is intentionally limited to narrow readonly classes; parity-only indirect-command findings are hardening, not vulnerabilities.
- Reports that only show untrusted media bytes reaching a maintained native decoder dependency (for example Sharp/libvips/libheif) without proving the shipped dependency version is vulnerable and demonstrating crash, memory corruption, data exposure, or a boundary bypass through OpenClaw. JavaScript header sniffing and image dimension fast-paths are preflight/UX checks, not the security boundary for native decoder correctness.
- Reports whose only impact is transient extra memory, CPU, or allocation work from decoding, base64 expansion, media transcoding, serialization, or other format conversion after the input was already accepted under OpenClaw's configured size/trust limits, including base64 decode-before-size-estimate findings. These are performance issues, not vulnerabilities, unless the report demonstrates unauthenticated amplification, bypass of configured limits, crash/process termination, persistent resource exhaustion, data exposure, or another documented boundary bypass.
- ReDoS/DoS claims that require trusted operator configuration input (for example catastrophic regex in `sessionFilter` or `logging.redactPatterns`) without a trust-boundary bypass.
- Archive/install extraction claims that require pre-existing local filesystem priming in trusted state (for example planting symlink/hardlink aliases under destination directories such as skills/tools paths) without showing an untrusted path that can create/control that primitive.
- Reports that depend on replacing or rewriting an already-approved executable path on a trusted host (same-path inode/content swap) without showing an untrusted path to perform that write.
- Reports that depend on pre-existing symlinked skill/workspace filesystem state (for example symlink chains involving `skills/*/SKILL.md`) without showing an untrusted path that can create/control that state.
- Missing HSTS findings on default local/loopback deployments.
- Reports against test-only harnesses, QA Lab, QE Lab, E2E fixtures, benchmark rigs, or maintainer-only debugging tools when the vulnerable code is not shipped as a supported production surface.
- Slack webhook signature findings when HTTP mode already uses signing-secret verification.
- Discord inbound webhook signature findings for paths not used by this repo's Discord integration.
- Claims that Microsoft Teams `fileConsent/invoke` `uploadInfo.uploadUrl` is attacker-controlled without demonstrating one of: auth boundary bypass, a real authenticated Teams/Bot Framework event carrying attacker-chosen URL, or compromise of the Microsoft/Bot trust path.
- Scanner-only claims against stale/nonexistent paths, or claims without a working repro.
- Reports that restate an already-fixed issue against later released versions without showing the vulnerable path still exists in the shipped tag or published artifact for that later version.
- SSRF reports against the operator-managed HTTP/WebSocket proxy-routing feature whose only claim is that ordinary process-local HTTP clients (`fetch`, `node:http`, `node:https`, WebSocket clients, axios/got/node-fetch-style clients) can reach an internal, metadata, private, or otherwise sensitive destination when proxy routing is disabled, missing, or the operator-managed proxy policy allows it. For this feature, OpenClaw provides fail-closed proxy routing when enabled; the external proxy's destination policy is operator infrastructure, not an OpenClaw-controlled security boundary. See [Network proxy](https://docs.openclaw.ai/security/network-proxy).

### Maintainer GHSA Updates via CLI

When patching a GHSA via `gh api`, include `X-GitHub-Api-Version: 2022-11-28` (or newer). Without it, some fields (notably CVSS) may not persist even if the request returns 200.

### Operator Trust Model

OpenClaw does **not** model one gateway as a multi-tenant, adversarial user boundary.

- Authenticated Gateway callers are treated as trusted operators for that gateway instance.
- Direct localhost/loopback Control UI and Gateway WebSocket sessions authenticated with the shared gateway secret (`token` / `password`) are in that same trusted-operator bucket. Local auto-paired device sessions on that path are expected to retain full localhost operator capability; they do not create a separate `operator.write` vs `operator.admin` security boundary.
- The HTTP compatibility endpoints (`POST /v1/chat/completions`, `POST /v1/responses`) and direct tool endpoint (`POST /tools/invoke`) are in that same trusted-operator bucket. Passing Gateway bearer auth there is equivalent to operator access for that gateway; they do not implement a narrower `operator.write` vs `operator.admin` trust split.
- Concretely, on the OpenAI-compatible HTTP surface:
  - shared-secret bearer auth (`token` / `password`) authenticates possession of the gateway operator secret
  - those requests receive the full default operator scope set (`operator.admin`, `operator.read`, `operator.write`, `operator.approvals`, `operator.pairing`)
  - chat-turn endpoints (`/v1/chat/completions`, `/v1/responses`) also treat those shared-secret callers as owner senders for owner-only tool policy
  - `POST /tools/invoke` follows that same shared-secret rule and also treats those callers as owner senders for owner-only tool policy
  - narrower `x-openclaw-scopes` headers are ignored for that shared-secret path
  - only identity-bearing HTTP modes (for example trusted proxy auth or `gateway.auth.mode="none"` on private ingress) honor declared per-request operator scopes
- Session identifiers (`sessionKey`, session IDs, labels) are routing controls, not per-user authorization boundaries.
- If one operator can view data from another operator on the same gateway, that is expected in this trust model.
- OpenClaw can technically run multiple gateway instances on one machine, but recommended operations are clean separation by trust boundary.
- Recommended mode: one user per machine/host (or VPS), one gateway for that user, and one or more agents inside that gateway.
- If multiple users need OpenClaw, use one VPS (or host/OS user boundary) per user.
- For advanced setups, multiple gateways on one machine are possible, but only with strict isolation and are not the recommended default.
- Exec behavior is host-first by default: `agents.defaults.sandbox.mode` defaults to `off`.
- `tools.exec.host` defaults to `auto`: sandbox when sandbox runtime is active for the session, otherwise gateway.
- Implicit exec calls (no explicit host in the tool call) follow the same behavior.
- This is expected in OpenClaw's one-user trusted-operator model. If you need isolation, enable sandbox mode (`non-main`/`all`) and keep strict tool policy.

### Trusted Plugins

Plugins/extensions are part of OpenClaw's trusted computing base for a gateway.

- Installing or enabling a plugin grants it the same trust level as local code running on that gateway host.
- Plugin behavior such as reading env/files or running host commands is expected inside this trust boundary.
- Security reports must show a boundary bypass (for example unauthenticated plugin load, allowlist/policy bypass, or sandbox/path-safety bypass), not only malicious behavior from a trusted-installed plugin.

### Out of Scope

- Public Internet Exposure
- Using OpenClaw in ways that the docs recommend not to
- Test-only code and maintainer harnesses, including QA Lab, QE Lab, E2E fixtures, benchmark rigs, smoke-test containers, and local debugging proxies, unless the report demonstrates that the same vulnerable behavior is reachable from shipped OpenClaw production code or a published package artifact intended for users.
- Deployments where mutually untrusted/adversarial operators share one gateway host and config (for example, reports expecting per-operator isolation for `sessions.list`, `sessions.preview`, `chat.history`, or similar control-plane reads)
- Prompt-injection-only attacks (without a policy/auth/sandbox boundary bypass)
- Reports that require write access to trusted local state (`~/.openclaw`, workspace files like `MEMORY.md` / `memory/*.md`)
- Reports where exploitability depends on attacker-controlled pre-existing symlink/hardlink filesystem state in trusted local paths (for example extraction/install target trees) unless a separate untrusted boundary bypass is shown that creates that state.
- Reports whose only claim is sandbox/workspace read expansion through trusted local skill/workspace symlink state (for example `skills/*/SKILL.md` symlink chains) unless a separate untrusted boundary bypass is shown that creates/controls that state.
- Reports whose only claim is post-approval executable identity drift on a trusted host via same-path file replacement/rewrite unless a separate untrusted boundary bypass is shown for that host write primitive.
- Reports where the only demonstrated impact is an already-authorized sender intentionally invoking a local-action command (for example `/export-session` writing to an absolute host path) without bypassing auth, sandbox, or another documented boundary
- Reports whose only claim is use of an explicit trusted-operator control surface (for example `canvas.eval`, browser evaluate/script execution, or direct `node.invoke` execution) without demonstrating an auth, policy, allowlist, approval, or sandbox bypass.
- Reports where the only claim is that a trusted-installed/enabled plugin can execute with gateway/host privileges (documented trust model behavior).
- Any report whose only claim is that an operator-enabled `dangerous*`/`dangerously*` config option weakens defaults (these are explicit break-glass tradeoffs by design)
- Reports that depend on trusted operator-supplied configuration values to trigger availability impact (for example custom regex patterns). These may still be fixed as defense-in-depth hardening, but are not security-boundary bypasses.
- Reports whose only claim is heuristic/parity drift in command-risk detection (for example obfuscation-pattern checks) across exec surfaces, without a demonstrated trust-boundary bypass. These are hardening-only findings and are not vulnerabilities; triage may close them as `invalid`/`no-action` or track them separately as low/informational hardening.
- Reports whose only claim is that an ACP-exposed tool can indirectly execute commands, mutate host state, or reach another privileged tool/runtime without demonstrating a bypass of ACP prompt/approval, allowlist enforcement, sandboxing, or another documented trust boundary. These are hardening-only findings, not vulnerabilities.
- Reports whose only claim is that exec approvals do not semantically model every interpreter/runtime loader form, subcommand, flag combination, package script, or transitive module/config import. Exec approvals bind exact request context and best-effort direct local file operands; they are not a complete semantic model of everything a runtime may load.
- Reports whose only claim is parser reachability in an up-to-date maintained dependency without showing that the exact shipped dependency build is vulnerable. We keep native media dependencies current; dependency exposure alone is not a vulnerability.
- Reports whose only claim is resource overhead from decode/encode, base64 expansion, media transcoding, serialization, or format-conversion order after input has already passed the applicable configured acceptance limits, including base64 decode-before-size-estimate findings. These are performance-only and should be ignored for GHSA triage unless the report demonstrates unauthenticated amplification, limit bypass, crash/process termination, persistent exhaustion, data exposure, or another documented boundary bypass.
- Exposed secrets that are third-party/user-controlled credentials (not OpenClaw-owned and not granting access to OpenClaw-operated infrastructure/services) without demonstrated OpenClaw impact
- Reports whose only claim is host-side exec when sandbox runtime is disabled/unavailable (documented default behavior in the trusted-operator model), without a boundary bypass.
- Reports whose only claim is that a platform-provided upload destination URL is untrusted (for example Microsoft Teams `fileConsent/invoke` `uploadInfo.uploadUrl`) without proving attacker control in an authenticated production flow.
- SSRF reports limited to the operator-managed HTTP/WebSocket proxy-routing feature where the demonstrated mitigation is to enable/configure `proxy.enabled` with a filtering `proxy.proxyUrl`/`OPENCLAW_PROXY_URL`, or where impact depends on a permissive/misconfigured operator proxy. This only covers normal process-local HTTP(S)/WebSocket egress (`fetch`, Node HTTP(S), and similar JavaScript clients); non-HTTP egress and other features are assessed separately. See [Network proxy](https://docs.openclaw.ai/security/network-proxy).

### Deployment Assumptions

OpenClaw security guidance assumes:

- The host where OpenClaw runs is within a trusted OS/admin boundary.
- Anyone who can modify `~/.openclaw` state/config (including `openclaw.json`) is effectively a trusted operator.
- A single Gateway shared by mutually untrusted people is **not a recommended setup**. Use separate gateways (or at minimum separate OS users/hosts) per trust boundary.
- Authenticated Gateway callers are treated as trusted operators. Session identifiers (for example `sessionKey`) are routing controls, not per-user authorization boundaries.
- Multiple gateway instances can run on one machine, but the recommended model is clean per-user isolation (prefer one host/VPS per user).

### One-User Trust Model

OpenClaw's security model is "personal assistant" (one trusted operator, potentially many agents), not "shared multi-tenant bus."

- If multiple people can message the same tool-enabled agent (for example a shared Slack workspace), they can all steer that agent within its granted permissions.
- Non-owner sender status only affects owner-only tools/commands. If a non-owner can still access a non-owner-only tool on that same agent (for example `canvas`), that is within the granted tool boundary unless the report demonstrates an auth, policy, allowlist, approval, or sandbox bypass.
- Session or memory scoping reduces context bleed, but does **not** create per-user host authorization boundaries.
- For mixed-trust or adversarial users, isolate by OS user/host/gateway and use separate credentials per boundary.
- A company-shared agent can be a valid setup when users are in the same trust boundary and the agent is strictly business-only.
- For company-shared setups, use a dedicated machine/VM/container and dedicated accounts; avoid mixing personal data on that runtime.
- If that host/browser profile is logged into personal accounts (for example Apple/Google/personal password manager), you have collapsed the boundary and increased personal-data exposure risk.

### Context Visibility and Allowlists

OpenClaw distinguishes:

- **Trigger authorization**: who can trigger the agent (`dmPolicy`, `groupPolicy`, allowlists, mention gates)
- **Context visibility**: what supplemental context is provided to the model (reply body, quoted text, thread history, forwarded metadata)

In current releases, allowlists primarily gate triggering and owner-style command access. They do not guarantee universal supplemental-context redaction across every channel/surface.

Current channel behavior is not fully uniform:

- some channels already filter parts of supplemental context by sender allowlist
- other channels still pass supplemental context as received

Reports that only show supplemental-context visibility differences are typically hardening/consistency findings unless they also demonstrate a documented boundary bypass (auth, policy, approvals, sandbox, or equivalent).

Hardening roadmap may add explicit visibility modes (for example `all`, `allowlist`, `allowlist_quote`) so operators can opt into stricter context filtering with predictable tradeoffs.

### Agent and Model Assumptions

- The model/agent is **not** a trusted principal. Assume prompt/content injection can manipulate behavior.
- Security boundaries come from host/config trust, auth, tool policy, sandboxing, and exec approvals.
- Prompt injection by itself is not a vulnerability report unless it crosses one of those boundaries.
- Hook/webhook-driven payloads should be treated as untrusted content; keep unsafe bypass flags disabled unless doing tightly scoped debugging (`hooks.gmail.allowUnsafeExternalContent`, `hooks.mappings[].allowUnsafeExternalContent`).
- Weak model tiers are generally easier to prompt-inject. For tool-enabled or hook-driven agents, prefer strong modern model tiers and strict tool policy (for example `tools.profile: "messaging"` or stricter), plus sandboxing where possible.

### Gateway and Node Trust Concept

OpenClaw separates routing from execution, but both remain inside the same operator trust boundary:

- **Gateway** is the control plane. If a caller passes Gateway auth, they are treated as a trusted operator for that Gateway.
- **Node** is an execution extension of the Gateway. Pairing a node grants operator-level remote capability on that node.
- **Exec approvals** (allowlist/ask UI) are operator guardrails to reduce accidental command execution, not a multi-tenant authorization boundary.
- Exec approvals bind exact command/cwd/env context and, when OpenClaw can identify one concrete local script/file operand, that file snapshot too. This is best-effort integrity hardening, not a complete semantic model of every interpreter/runtime loader path.
- Differences in command-risk warning heuristics between exec surfaces (`gateway`, `node`, `sandbox`) do not, by themselves, constitute a security-boundary bypass.
- For untrusted-user isolation, split by trust boundary: separate gateways and separate OS users/hosts per boundary.

### Workspace Memory Trust Boundary

`MEMORY.md` and `memory/*.md` are plain workspace files and are treated as trusted local operator state.

- If someone can edit workspace memory files, they already crossed the trusted operator boundary.
- Memory search indexing/recall over those files is expected behavior, not a sandbox/security boundary.
- Example report pattern considered out of scope: "attacker writes malicious content into `memory/*.md`, then `memory_search` returns it."
- If you need isolation between mutually untrusted users, split by OS user or host and run separate gateways.

### Plugin Trust Boundary

Plugins/extensions are loaded **in-process** with the Gateway and are treated as trusted code.

- Plugins can execute with the same OS privileges as the OpenClaw process.
- Runtime helpers (for example `runtime.system.runCommandWithTimeout`) are convenience APIs, not a sandbox boundary.
- Only install plugins you trust, and prefer `plugins.allow` to pin explicit trusted plugin ids.

### Temp Folder Boundary

OpenClaw uses a dedicated temp root for local media handoff and sandbox-adjacent temp artifacts:

- Preferred temp root: `/tmp/openclaw` (when available and safe on the host).
- Fallback temp root: `os.tmpdir()/openclaw` (or `openclaw-<uid>` on multi-user hosts).

Security boundary notes:

- Sandbox media validation allows absolute temp paths only under the OpenClaw-managed temp root.
- Arbitrary host tmp paths are not treated as trusted media roots.
- Plugin/extension code should use OpenClaw temp helpers (`resolvePreferredOpenClawTmpDir`, `buildRandomTempFilePath`, `withTempDownloadPath`) rather than raw `os.tmpdir()` defaults when handling media files.
- Enforcement reference points:
  - temp root resolver: `src/infra/tmp-openclaw-dir.ts`
  - SDK temp helpers: `src/plugin-sdk/temp-path.ts`
  - messaging/channel tmp guardrail: `scripts/check-no-random-messaging-tmp.mjs`

### Operational Guidance

For threat model + hardening guidance (including `openclaw security audit --deep` and `--fix`), see:

- `https://docs.openclaw.ai/gateway/security`

#### Tool Filesystem Hardening

- `tools.exec.applyPatch.workspaceOnly: true` (recommended): keeps `apply_patch` writes/deletes within the configured workspace directory.
- `tools.fs.workspaceOnly: true` (optional): restricts `read`/`write`/`edit`/`apply_patch` paths and native prompt image auto-load paths to the workspace directory.
- Avoid setting `tools.exec.applyPatch.workspaceOnly: false` unless you fully trust who can trigger tool execution.

#### Sub-Agent Delegation Hardening

- Keep `sessions_spawn` denied unless you explicitly need delegated runs.
- Keep `agents.list[].subagents.allowAgents` narrow, and only include agents with sandbox settings you trust.
- When delegation must stay sandboxed, call `sessions_spawn` with `sandbox: "require"` (default is `inherit`).
  - `sandbox: "require"` rejects the spawn unless the target child runtime is sandboxed.
  - This prevents a less-restricted session from delegating work into an unsandboxed child by mistake.

#### Web Interface Safety

OpenClaw's web interface (Gateway Control UI + HTTP endpoints) is intended for **local use only**.

- Recommended: keep the Gateway **loopback-only** (`127.0.0.1` / `::1`).
  - Config: `gateway.bind="loopback"` (default).
  - CLI: `openclaw gateway run --bind loopback`.
- `gateway.controlUi.dangerouslyDisableDeviceAuth` is intended for localhost-only break-glass use.
  - OpenClaw keeps deployment flexibility by design and does not hard-forbid non-local setups.
  - Non-local and other risky configurations are surfaced by `openclaw security audit` as dangerous findings.
  - This operator-selected tradeoff is by design and not, by itself, a security vulnerability.
- Canvas host note: network-visible canvas is **intentional** for trusted node scenarios (LAN/tailnet).
  - Expected setup: non-loopback bind + Gateway auth (token/password/trusted-proxy) + firewall/tailnet controls.
  - Expected routes: `/__openclaw__/canvas/`, `/__openclaw__/a2ui/`.
  - This deployment model alone is not a security vulnerability.
- Do **not** expose it to the public internet (no direct bind to `0.0.0.0`, no public reverse proxy). It is not hardened for public exposure.
- If you need remote access, prefer an SSH tunnel or Tailscale serve/funnel (so the Gateway still binds to loopback), plus strong Gateway auth.
- The Gateway HTTP surface includes the canvas host (`/__openclaw__/canvas/`, `/__openclaw__/a2ui/`). Treat canvas content as sensitive/untrusted and avoid exposing it beyond loopback unless you understand the risk.

## Runtime Requirements

### Node.js Version

OpenClaw requires **Node.js 22.14.0 or later** (LTS). This version includes important security patches:

- CVE-2025-59466: async_hooks DoS vulnerability
- CVE-2026-21636: Permission model bypass vulnerability

Verify your Node.js version:

```bash
node --version  # Should be v22.14.0 or later
```

### Docker Security

When running OpenClaw in Docker:

1. The official image runs as a non-root user (`node`) for reduced attack surface
2. Use `--read-only` flag when possible for additional filesystem protection
3. Limit container capabilities with `--cap-drop=ALL`

Example secure Docker run:

```bash
docker run --read-only --cap-drop=ALL \
  -v openclaw-data:/app/data \
  openclaw/openclaw:latest
```

## Security Scanning

OpenClaw uses several security and release-validation layers. No single scanner is treated as the boundary.

### Secret Detection

OpenClaw uses `detect-secrets` with a checked-in baseline and local exclusion notes (`.secrets.baseline`, `.detect-secrets.cfg`). Secret-resolution behavior is also covered by the dedicated secrets test surface.

Run the baseline scan locally:

```bash
pip install detect-secrets==1.5.0
detect-secrets scan --baseline .secrets.baseline
```

### Static Analysis

CI runs CodeQL across core TypeScript, GitHub Actions, Android, macOS, and high-risk runtime boundaries using `.github/workflows/codeql*.yml` and `.github/codeql/*.yml`.

OpenGrep provides a high-precision Semgrep-compatible layer. PRs run a changed-path scan; maintainers can run a full repository scan when needed. The rulepack lives under `security/opengrep/`, with `.semgrepignore` as the shared exclusion file.

Run the local OpenGrep wrapper after installing `opengrep`:

```bash
scripts/run-opengrep.sh --changed --sarif --error
pnpm check:opengrep-rule-metadata
```

### E2E and Live Validation

Security-relevant behavior is also covered by runtime validation, not only static scanning:

- `pnpm test:e2e` for repo E2E coverage.
- `pnpm test:live` for live provider/runtime coverage.
- `pnpm test:docker:all` for Docker-packaged runtime scenarios.
- Package acceptance and scheduled live/E2E workflows for release-path validation.

These lanes exercise packaged installs, gateway/runtime behavior, live model/provider paths, Docker scenarios, and platform smoke tests. They complement scanners by proving the security-sensitive flows still behave correctly in real runtime environments.
