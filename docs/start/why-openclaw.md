---
summary: "The architecture case for OpenClaw: a trusted gateway, untrusted execution, deterministic policy, and versioned state, compared source-by-source with single-process harnesses"
read_when:
  - You are evaluating agent harnesses for team or enterprise use
  - You need to explain to a security team how OpenClaw differs from single-process harnesses
  - You want the citable version of the trusted-gateway / untrusted-execution argument
title: "Why OpenClaw"
---

OpenClaw is an extensible, proactive, open-source AI agent that works everywhere you work. It exists because software is inverting: for decades you went to the computer, opened the app, clicked through its screens, and did the work yourself. An agent acts on your behalf instead, on your machine, in your messages, against your accounts.

That inversion is why agents feel like the beginning of something rather than another product cycle, and why they deserve more scrutiny than anything you have installed before: an assistant that acts for you holds credentials, reads mail, and runs commands on real computers. The architecture decides what it _can_ do long before any policy decides what it _may_.

The project is stewarded by the [OpenClaw Foundation](https://openclaw.org), an independent 501(c)(3) whose mission is to make AI personal, fun, and empowering for everyone: your agent, your machine, your rules. It is built on the observation that the open source projects that endure (Linux, Apache, Mozilla) endure because a neutral steward stands behind them.

The Foundation has sponsors rather than owners, with OpenAI, NVIDIA, Microsoft, Atlassian, GitHub, and Tencent among more than thirty, a full-time team, releases signed under its own identity, and Foundation-convened councils on agent identity, agent profiles, evals, and enterprise deployment. The aim is to be the Switzerland of AI: neutral ground for every model and every lab, and the most mature, battle-tested agent for anyone, individual or enterprise, to build on.

For an evaluation, governance is not decoration. It answers who controls the roadmap, who signs what you deploy, and what happens when any one vendor's incentives change.

Most harnesses are a single trust envelope. One process holds the agent loop, the channel connections, the credentials, and the shell, running as one OS user on a long-lived machine. Wrapping that process in a VM leaves all of those components inside the same boundary. The machine is maintained and patched in place.

Every claim below carries a source, and the recurring comparison is [Hermes Agent](https://github.com/NousResearch/hermes-agent), the strongest harness of the single-envelope generation, verified against its source tree. Its `SECURITY.md` states the consequence of that architecture plainly:

> The only security boundary against an adversarial LLM is the operating system.

OpenClaw's boundary sits above the operating system: a trusted [Gateway](/gateway) separated from untrusted, movable execution. Policy is enforced by code that fails closed, and state is versioned and migrated, so a deployment is replaceable.

## What an enterprise harness has to prove

Seven testable properties:

1. **Separated trust boundary.** Execution moves into a sandbox, a node, or a throwaway cloud machine; credentials do not move with it.
2. **Policy is code.** Denial is structural, not a request the model is asked to honor; approval paths fail closed.
3. **Authenticated access, bounded roles.** Inbound access is default-deny and authenticated; people hold bounded roles; the vendor states which boundaries are security and which are convenience.
4. **Secrets have owners.** Credentials are referenced, not inlined; one broken secret degrades exactly its owner, not the platform.
5. **Versioned state, guarded upgrades.** State is schema-versioned with owned migrations; upgrades are guarded and delivered through release channels.
6. **Recorded provenance.** Memory, audit, and delivery answer "where did this come from and what happened to it" with recorded facts and bounded retention.
7. **Independent stewardship.** The license has no separate enterprise edition; releases are signed by an accountable identity; the security record is public.

## How OpenClaw answers

The short answers, each proved in a section below:

- **A compromised sandbox steals nothing.** Execution moves to sandboxes, paired nodes, or throwaway cloud machines; credentials stay at the Gateway. ([Trust boundary](#the-trust-boundary))
- **The model cannot talk its way past policy.** Denied tools are never registered, and an approval that cannot be bound to an exact command is refused. ([Policy as code](#policy-as-code))
- **No caller is trusted by default.** Unknown senders get a pairing code, not the agent, and reconnecting with broader scopes is a new approval, not an escalation. ([Identity and roles](#identity-and-roles))
- **The agent never sees a credential.** Its context holds an encrypted placeholder; the real value is substituted at the network boundary, for allow-listed hosts only. ([Secrets](#secrets))
- **An upgrade refuses state it does not understand.** Schemas are versioned, updaters check compatibility in both directions, and releases are immutable and signed. ([Versioned state](#versioned-state-guarded-upgrades))
- **Deleted means deleted.** Every memory traces to its source sessions, and a purge writes tombstones that consolidation and reindexing respect. ([Provenance](#provenance))
- **No vendor owns it.** MIT under an independent 501(c)(3) foundation, with signed releases and hundreds of self-published security advisories. ([Governance](#governance))

The [comparison table](#openclaw-and-hermes-agent) condenses the source-verified contrast with Hermes. [What we do not claim](#what-we-do-not-claim) states the limits, starting with sandboxing being off by default.

### The trust boundary

The Gateway owns channel connections, config, credentials, and the [control-plane API](/gateway/protocol). It binds to loopback by default and refuses non-loopback binds without a working auth path ([architecture](/concepts/architecture), [network model](/network)).

```mermaid actions={true} placement="top-right"
flowchart LR
  subgraph GW["Gateway (trusted)"]
    direction TB
    CH["Channel connections"]
    POL["Policy: modes, scopes, exec approvals"]
    SEC["Credentials: SecretRefs, sentinels"]
    ST["Sessions, memory, audit (versioned SQLite)"]
  end
  subgraph EX["Movable execution (untrusted, no standing credentials)"]
    direction TB
    SB["Sandbox: Docker, Podman, OpenShell, Daytona"]
    ND["Paired node: sealed, hash-verified worker"]
    CW["Cloud worker: throwaway machine, closed RPC allowlist"]
  end
  OP["Operators, channels, peer agents"] -->|"authenticated, default-deny"| GW
  GW -->|"exec calls, bounded per-turn context"| EX
  EX -->|"results only"| GW
```

[`tools.exec.host`](/tools/exec) resolves to the gateway host, a [sandbox](/gateway/sandboxing), or a paired [node](/nodes). While a sandbox runtime is active, per-call escapes to the host are rejected, and an explicit `host=sandbox` with no runtime configured fails instead of silently running on the host. Backends: Docker and Podman (default profile: no network, read-only root, all capabilities dropped, non-root user), SSH, [OpenShell](/gateway/openshell), and [Daytona](/gateway/daytona) cloud sandboxes (automatic idle-stop with resume on next use, memory-preserving pause, cold-storage archiving) — the latter two installed as plugins, registered through the same backend contract as Docker. If you run OpenShell already, OpenClaw uses its sandboxes; it does not need to be wrapped in one.

Sandbox bind mounts are validated twice, once on the normalized path and again after resolving through the deepest existing ancestor, so symlink-based bypass attempts fail closed. The deny-list of credential and system paths cannot be disabled — the `dangerouslyAllowExternalBindSources` override relaxes only the allowed-roots check.

This separation also applies across machines. A paired [node](/nodes) that hosts sessions receives a sealed worker artifact, content-hash-verified at three points (download, manifest, and on every reuse); the node installs no packages and runs no lifecycle scripts, and can put each hosted session in its own container, enforced by node-local config the Gateway's launch request cannot express. With [Cloud workers](/gateway/cloud-workers), a session's coding work runs on a throwaway cloud machine that connects back to the Gateway with a closed, dispatcher-enforced RPC method allowlist, gets per-dispatch minted credentials stored hashed at rest with a ten-minute TTL, and holds no standing model, GitHub, or cloud credential. Inference is proxied through the Gateway. The [durable transcript](/concepts/session) lives only on the Gateway; the worker sees a bounded per-turn context window and keeps no copy.

A "cloud backend" in a single-envelope harness is a remote place where the _terminal tool_ runs, while the process holding every credential stays on the original machine. An OpenClaw cloud session moves the execution and retains authority at the Gateway. Of these two approaches, only the OpenClaw cloud session changes what a compromised sandbox can reach.

This separation of credentials from execution is spreading: OpenAI's Agents SDK adopted it in 2026 for sandbox orchestration. An SDK supplies components for building an agent; OpenClaw ships this separation as an operated product with channels, identity, and state.

**Sandboxing is off by default.** Out of the box, OpenClaw is a personal assistant for one trusted operator, and exec runs on the gateway host without prompts. The enterprise posture requires explicit configuration, verifiable with two commands: [`openclaw sandbox explain`](/gateway/sandbox-vs-tool-policy-vs-elevated) prints the effective execution posture, and [`openclaw security audit`](/gateway/security/audit-checks) flags drift with stable check IDs you can alarm on.

### Policy as code

Deterministic enforcement is not unique to OpenClaw — Claude Code, Codex, and Goose all gate approvals in code. Structural tool gating in a multi-channel assistant, rather than a terminal, is rarer: [permission modes](/gateway/permission-modes) shape which tools exist at all. A `read-only` session never has the file-mutation tools registered — `edit`, `write`, and `apply_patch` are not offered to the model — and its exec tool resolves to a deny policy that refuses at the call boundary. `full` requires `operator.admin`, and scopes are derived from request parameters before dispatch ([operator scopes](/gateway/operator-scopes)), so a method with a privileged parameter still needs the privileged scope.

Three controls govern separate decisions ([sandbox vs. tool policy vs. elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)). The sandbox decides where tools run. Tool policy decides which tools exist; deny always wins, and a blocked call's audit entry names the deny rule that fired. `tools.elevated` is an exec-only escape hatch that cannot override a deny.

[Exec approvals](/tools/exec-approvals) bind an approved run to its canonical command, cwd, environment hash, and content-hashed file operands, and deny on any drift after approval. Where OpenClaw cannot bind precisely — shell pipelines, commands after a `cd`, interpreters with no identifiable single file operand — it refuses to mint the approval rather than approve an imprecise binding. When no approval UI is reachable, the answer is deny by default, and strict cases (inline eval, heredocs) cannot be softened by any fallback setting.

```mermaid actions={true} placement="top-right"
flowchart LR
  MODE["Permission mode"] -->|"read-only: mutation tools never registered"| REG["Registered tools"]
  REG --> TP["Tool policy: deny wins; audit names the rule"]
  TP --> PLACE["Placement: gateway host, sandbox, or node"]
  PLACE --> APR["Exec approval: canonical command, cwd, env hash, operand hashes"]
  APR -->|"exact match"| RUN["Run"]
  APR -->|"drift, unbindable command, or no approval UI"| DENY["Deny (fail closed)"]
```

Tool policy filters by name, not side effects: allowing `exec` while denying `write` does not make shell commands read-only. As documented, restricting side effects is the sandbox's responsibility.

### Identity and roles

Control-plane clients present signed device identities and go through [pairing](/gateway/pairing). Reconnecting with broader scopes creates a new approval request; there is no silent escalation of privilege. Unknown DM senders get a [pairing code](/channels/pairing), not the agent. Identity-aware front doors ([Tailscale](/gateway/tailscale), [trusted proxy](/gateway/trusted-proxy-auth), [Cloudflare Access](/gateway/cloudflare-access)) map verified identities to scopes.

Eight [operator scopes](/gateway/operator-scopes) — `read`, `write`, `admin`, plus narrower ones for pairing, approvals, questions, and talk — are derived per request from the actual parameters before dispatch, and methods with no scope classification are denied rather than allowed. A read-scoped connection cannot mutate anything, and admin-only parameters stay admin-only however the request arrives. [`gateway.roles`](/gateway/operator-scopes) assigns named person-level roles: visibility into other people's sessions, an agent allow-list, and a scope ceiling that is intersected with whatever connection auth granted, never added to it. A profile with no assignment, or an assignment naming an unknown role, resolves to deny-all. [Multi-user sessions](/concepts/multi-user) record an immutable creator, an assignable owner, and a bounded participant history, and verified GitHub identity can flow through to `Co-authored-by` trailers and PR-linked session transcripts ([user model](/concepts/user-model)).

Our [security docs](/gateway/security) define the scope: one gateway is one trust domain. Roles organize collaboration between people who already trust each other. For tenancy, you run one gateway per tenant; [`openclaw fleet`](/cli/fleet) automates this with one hardened container cell per tenant with its own state, credentials, and network (currently experimental), and the [multi-tenant guide](/gateway/multi-tenant-hosting) documents the isolation ladder above it, through gVisor and Kata up to separate machines.

### Secrets

Every supported credential field takes a [SecretRef](/gateway/secrets): `env`, `file`, `exec` (this is how 1Password, Vault, Bitwarden, and sops plug in), or the shared store. When a secret fails to resolve at startup, the Gateway comes up degraded rather than down. The exact owner (one provider, one channel account, one plugin route) is marked unavailable, requests to it fail with a typed error, nothing falls back to a different credential, and [`doctor`](/cli/doctor) and `status` name every degraded owner with a redacted reason. A broken secret is an operational alert, not an outage.

Model-provider credentials become sentinels in memory. Config, logs, SDK objects, and error paths carry the sentinel; the real value is substituted at the egress boundary, and an unrecognized sentinel-shaped value is refused rather than forwarded. An operator can supply a credential without exposing it to the agent: a secret entered under **Settings → Secrets** in the [Control UI](/web/control-ui) is write-only from the moment it is saved — list output never includes it, no agent-facing surface can read it back (one admin-scoped resolve exists for operators), and credential-shaped names default to protected. The agent's context only ever holds the sentinel, itself AES-256-GCM ciphertext keyed to the Gateway process, and the opt-in [egress proxy](/gateway/secrets) substitutes the real value at the network boundary for exact allow-listed destination hosts. A fully compromised agent context holds nothing worth exfiltrating. The agent can also request a credential it does not have: an [agent-requested secret](/tools/secrets) prompt goes to the operator, the value lands in the protected store, and the model still never sees it. Hermes has no equivalent: its dashboard uses "write-only" masking, but an `/api/env/reveal` endpoint returns the plaintext (`hermes_cli/web_server.py:8752`), entered values land in `.env` and the process environment, and iron-proxy's token swap covers eleven model-provider keys inside Docker sandboxes while the real credentials remain in the agent process. [`openclaw secrets audit`](/cli/secrets) finds plaintext at rest; `secrets configure --apply` moves it behind refs. Workspace `.env` files cannot override provider keys or `OPENCLAW_*` runtime controls.

```mermaid actions={true} placement="top-right"
flowchart LR
  OPR["Operator"] -->|"Settings: Secrets (write-only)"| STORE["Protected store"]
  AGT["Agent context"] -.->|"agent-requested secret: prompt"| OPR
  AGT -->|"holds sentinel only (AES-256-GCM ciphertext)"| OUT["Outbound request"]
  OUT --> EG["Egress boundary"]
  STORE -->|"resolve"| EG
  EG -->|"real value substituted, allow-listed hosts"| API["Provider API"]
  EG -->|"unrecognized sentinel"| REF["Refused"]
```

Browser agents solved the sign-in case: 1Password for Claude and ChatGPT's takeover mode keep a password out of the model while a human logs in, one fill at a time, with no durable artifact. As far as we can determine, OpenClaw is the only agent harness where the agent can request an arbitrary credential mid-task and receive back only a durable, reusable handle. The MCP specification forbids the in-band version of this flow because a client cannot keep an elicited value out of model context; the Gateway can, because it owns both the question channel and the store. Hermes's tracker requested this feature (NousResearch/hermes-agent#410) and closed it by shipping operator-side vault resolvers instead.

The store itself is `0600`-permission SQLite, not an HSM, and the docs direct operators with stronger custody requirements to external vaults. A SecretRef shrinks what is on disk; it does not stop a host-exec agent from reading files. Restricting file access is the sandbox's responsibility.

### Versioned state, guarded upgrades

Runtime state is database-first: one global SQLite store, one per agent, with a written contract that runtime code never reads or writes JSON sidecars as active state. The contract is machine-checked in CI ([database schemas](/reference/database-schemas)). Schemas carry a two-place version contract; a build refuses to open a database newer than itself; [`openclaw update`](/cli/update) refuses a target older than your on-disk schemas; [`openclaw doctor --fix`](/cli/doctor) is the single owner of file-to-SQLite migrations and records a receipt for each one. [Backups](/cli/backup) go through SQLite's online-backup API and are integrity- and hash-verified; restore never happens in place. [Restart recovery](/gateway/restart-recovery) resumes interrupted turns under a bounded attempt budget, and a crash-loop breaker keeps the control plane reachable while suppressing channel autostart.

Releases come through four channels (stable, extended-stable, beta, dev) on calendar versions with immutable npm publishes ([development channels](/install/development-channels), [release process](/reference/RELEASING)). Extended-stable is the conservative track and it fails closed: the updater re-fetches and verifies the exact selected package, and missing or inconsistent registry data is an error, never a fallback to `latest`. Behind every release sits [Full Release Validation](/reference/full-release-validation), which seals an immutable execution-plan artifact covering cross-OS installs and upgrades, package acceptance, live channel lanes, and performance gates. Publishing is serialized and provenance-verified (Sigstore attestations, npm provenance) under the OpenClaw Foundation identity.

Per-surface readiness is published. The [maturity scorecard](/maturity/scorecard) grades 50 surfaces across [280 capability areas](/maturity/taxonomy) from deterministic QA evidence plus reviewed quality scores, with long-term-support status on every row. Extended-stable answers how long a surface is supported; the scorecard answers how proven it is.

### Provenance

OpenClaw memory is Markdown plus a SQLite index; there is no hidden state ([memory architecture](/concepts/memory-architecture)). Each indexed chunk carries an origin class (`owner`, `agent`, `untrusted`, `system`) stored outside the prose, so recalled text cannot promote its own trust level, and classification never defaults to `owner`. Graph memory layers like Zep's Graphiti also trace facts to their sources; what OpenClaw adds is a gate that consumes the provenance: the [dreaming](/concepts/dreaming) consolidation pass drops `untrusted` and `system` candidates before the consolidation prompt is even built, and [cron](/automation/cron-jobs), [heartbeat](/gateway/heartbeat), and [subagent](/tools/subagents) sessions never produce durable memory candidates at all. Taint follows content within a turn, too: after a network-sourced tool result, every later assistant message in that turn is marked tainted and classifies `untrusted` for memory, whoever was speaking. Cross-conversation recall has a fixed boundary: groups and channels are neither source nor destination ([active memory](/concepts/active-memory)).

Retrieval scores relevance, recency, and write-time importance the way [Generative Agents](https://arxiv.org/abs/2304.03442) established, with [MMR diversity](https://dl.acm.org/doi/10.1145/290941.291025) over hybrid BM25-plus-vector results; [dreaming](/concepts/dreaming) runs consolidation offline as a background pass, the design quantified by [sleep-time compute](https://arxiv.org/abs/2504.13171); and curation effort concentrates on the write path because long-horizon evaluations show what was written matters more than how it is indexed ([LongMemEval](https://arxiv.org/abs/2410.10813)). For problems identified but not resolved in the literature, OpenClaw implements structural fixes: memory poisoning ([OWASP ASI06](https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/), [MINJA](https://arxiv.org/abs/2503.03704)) is answered with provenance-gated promotion rather than content scanning, prospective-memory decay ([TriggerBench](https://arxiv.org/abs/2606.23459)) is answered by compiling [standing intents](/concepts/standing-intents) out of the model into deterministic triggers, and tombstoned deletion answers what [Ghost Vectors](https://arxiv.org/abs/2606.18497) demonstrates about soft-deleted embeddings remaining reconstructible.

Every memory entry keeps its origin sessions through consolidation (origins union on merge and re-key on supersede; the model never carries provenance itself), an [admission policy](/reference/memory-config) keeps designated sessions out of the dreaming pipeline with recorded, reversible exclusions, and [`openclaw memory forget`](/cli/memory) purges the tracked artifacts of the selected sessions — entries, diary quotes, index rows, vectors, embedding caches — scrubs rewrite backups, and writes durable tombstones that ingestion, backfill, and later sweeps respect. A participant selector selects that participant's sessions; archives, exports, and external copies need separate review. "Purge everything that came from email" and "remove what a departed employee contributed" are supported commands.

Some of these capabilities exist elsewhere — Zep records episode provenance and markets right-to-be-forgotten deletion — but no agent memory system we surveyed, SaaS or open source, documents tombstoned non-resurrection: a purge that the system's own consolidation, backfill, and indexing can never silently undo. Sleep-time consolidators elsewhere can re-derive what was deleted, and extractors can rewrite it a week later. Compliance research states that real erasure requires a provenance map from source records to every derived memory artifact; OpenClaw implements that provenance map.

The [audit ledger](/gateway/audit) stores identity, ordering, action, and outcome codes. It never stores prompts, bodies, arguments, or filenames. Retention is a hard 30 days with row caps. Decision receipts use a closed vocabulary where `enforced` marks decisions from a gate that actually governed the action; a bare success is never upgraded into authorization proof. The docs publish their own non-claims, including "absence of a row proves nothing" and the pseudonymization being correlation rather than anonymization; for a lossless compliance archive, feed [OpenTelemetry](/gateway/telemetry) to your SIEM.

Failed inbound events land in an inspectable, resubmittable [dead-letter queue](/cli/channels) instead of vanishing, and outbound messages carry staged terminal states. The invariant: every action ends in a visible outcome or a recorded, intentional non-outcome.

Independent verification exists at three levels: a community [threat model mapped to MITRE ATLAS](/security/THREAT-MODEL-ATLAS), [TLA+ models](/security/formal-verification) of the riskiest authorization and isolation paths (models of the design, checked in bounded state spaces; they do not establish that "the TypeScript is verified", as the docs state), and a public [maturity scorecard](/maturity/scorecard) that grades our coverage.

## The vendor's harness, as a plugin

Agent harnesses are becoming model-specific: labs train and evaluate their models inside their own loops. OpenClaw treats those harnesses as first-class runtimes rather than API endpoints ([agent runtimes](/concepts/agent-runtimes)). The [Codex plugin](/plugins/codex-harness) drives Codex's own app-server loop — native thread resume, compaction, approvals, mid-turn steering, OpenClaw tools bridged into Codex turns, [computer use](/plugins/codex-computer-use) — the Copilot plugin runs the GitHub Copilot SDK's session loop, and the Anthropic plugin runs the Claude Agent SDK, while OpenClaw keeps ownership of channels, sessions, policy, and state. A model family runs in the loop it was built for, and the choice stays with the operator: every model also works through OpenClaw's own loop. Gateways that integrate these vendors at the API layer keep their own executor in charge; the vendor harness is at most an optional backend.

This embedding pattern comes from the vendors. OpenAI built the Codex app-server so partners could "embed the same harness in their own products" ([Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)) and [open-sourced the full harness](https://developers.openai.com/blog/codex-as-a-platform) in August 2026; Anthropic ships the [Claude Agent SDK](https://anthropic.com/engineering/building-agents-with-the-claude-agent-sdk) as the same harness that powers Claude Code. Third-party analysis states that models are post-trained against their harness, and [pulling a model out of its harness costs performance you cannot get back](https://nicolasbustamante.com/blog/model-harness-fit).

Like other OpenClaw features, harnesses ship as plugins against a core that stays deliberately small. Channels, model providers, memory, voice, the Codex harness — all plugins behind documented [capability registration points](/plugins/architecture), with the boundary enforced by CI import guards, not convention. You can remove what you do not want (strip channels, disable memory, run a minimal surface, pin the allowed set with `plugins.allow`), and third parties can add what we did not build through the same [SDK contracts](/plugins/sdk-channel-plugins) — including whole message channels, which is how community plugins cover networks the core never touches. Every plugin's [manifest](/plugins/manifest) is validated before any of its code runs.

The public plugin SDK publishes about 150 entrypoints with more than 4,300 exported symbols, held under shrink-only surface budgets so growth is a conscious decision; Hermes's plugin surface is a hook list, a platform-registration call, and seven consent capability IDs. [ClawHub](/clawhub) is OpenClaw's registry — [publishing](/clawhub/publishing), moderation, [security audits](/clawhub/security-audits), and per-release trust verdicts wired directly into the install gate — where Hermes distributes through skills-hub tap repositories and an in-repo MCP catalog approved by pull-request review. A marketplace at ClawHub's scale attracts malicious uploads; the audits, moderation, and install-gate verdicts address those uploads. [Skills](/tools/skills) are also checked: every ClawHub skill is scanned before install (VirusTotal, ClawScan, static analysis, with the scan state shown on the skill page), and `openclaw skills verify` checks an installed skill against its trust envelope afterward, so tampering is detectable.

## Open standards

OpenClaw adopts the protocols the ecosystem is converging on. It is an [MCP client](/tools/mcp) (Streamable HTTP, SSE, and stdio transports, with OAuth) and an [MCP server](/cli/mcp), and plugins can [ship their own MCP servers and apps](/plugins/manifest#mcp-server-reference). Other agents reach it through the Linux Foundation [A2A 1.0 protocol](/channels/a2a) — Agent Card discovery, authenticated JSON-RPC tasks, and outbound peer messaging — and editors connect over the [Agent Client Protocol](/cli/acp), which OpenClaw also uses to [host external harnesses](/tools/acp-agents). Agents render live [A2UI widgets](/web/dashboards) on session dashboards.

Skills follow the [AgentSkills spec](/tools/skills), plugin installs auto-detect [Agent Plugins, Codex, Claude, and Cursor bundle layouts](/plugins/bundles), and the Gateway can serve an [OpenAI-compatible API](/gateway/openai-http-api) (`/v1/chat/completions` with a documented function-tool subset, [`/v1/responses`](/gateway/openresponses-http-api), `/v1/models`, `/v1/embeddings`; disabled by default, `/v1/responses` separately enabled) so OpenAI clients can target the Gateway directly. Observability exports over [OpenTelemetry](/gateway/opentelemetry) and [Prometheus](/gateway/prometheus); gateways advertise via [Bonjour and DNS-SD](/gateway/bonjour); channels include native [Matrix](/channels/matrix), [IRC](/channels/irc), and [Nostr](/channels/nostr) protocol implementations; and releases ship with [npm provenance and verifiable artifact attestations](/reference/RELEASING).

## Working together

Most agent-assisted work today happens between one person and one terminal; others see the finished commits. A shared OpenClaw gateway makes the work itself observable. [Sessions](/concepts/session) carry an immutable creator, an assignable owner, and the people who actually prompted; the [Control UI](/web/control-ui) shows [who is viewing and typing](/concepts/presence) in real time (drafts stay ephemeral and never reach the model or the transcript), and the sidebar filters by owner or by "involving me" ([multi-user](/concepts/multi-user)). A conversation that starts in a channel can continue as a session the whole team can open, steer, and take over.

With verified GitHub identity, commits from a shared session carry `Co-authored-by` trailers for the authenticated people who steered them, ordered by actual contribution, and when the Gateway has a shareable session URL, generated pull requests end with a link back to the team session — a reviewer with access reads the conversation that produced the diff, not just the diff ([user model](/concepts/user-model)). Local coding sessions can be mirrored near-live to a team gateway with [Beam](/plugins/beam), and [cloud workers](/gateway/cloud-workers) put execution on disposable machines while the transcript stays in one shared place. [Portals](/gateway/portals) proxy an agent's development server into the operator's browser through the Gateway, and Cloud Worker Desktop streams a live VNC view of the worker — an authenticated loopback-only RFB server, reached through a single-use broker ticket over the worker's own outbound connection, never public ingress, with view-only filtering and single-controller arbitration. Hermes has neither; its sandbox observation is terminal output. OpenClaw is developed this way, in shared sessions on the maintainers' own team gateway; the roles, attribution, and audit surfaces above exist because that workflow requires them.

## Governance

The whole OpenClaw product is MIT-licensed, with no enterprise edition under a different license, and it is governed by the [OpenClaw Foundation](https://openclaw.org) introduced above. The Foundation's stewardship shows up in the architecture: providers are plugins, and no lab's model is privileged. Releases are signed and published under the Foundation identity.

Hermes is built by Nous Research, a venture-funded company whose Series A was led by the crypto investor Paradigm at a token-based valuation, with a later round reported at a $1.5B valuation. This is a difference in governance and funding, not a judgment of the engineering. A neutral non-profit with published governance can serve as enterprise infrastructure.

Third parties invest in the architecture: NVIDIA's [NemoClaw](https://nvidianews.nvidia.com/news/nvidia-announces-nemoclaw) distribution hardens OpenClaw with OpenShell kernel-level sandboxing, infrastructure vendors publish [production-hardening guides](https://nebius.com/blog/posts/openclaw-security) for it, and [academic security case studies](https://arxiv.org/html/2603.12644v1) credit the decoupled architecture while cataloging threats.

OpenClaw [publishes its security advisories](https://github.com/openclaw/openclaw/security/advisories) on the repository — hundreds of them, batch-published alongside fixes, including OpenClaw's own worst stretch: the March 2026 CVE batch that third-party write-ups still cite exists in public because OpenClaw disclosed it — with a written [trust model](/gateway/security), an [incident response plan](/security/incident-response), and security maintainers from NVIDIA and Tencent. Hermes's repository has published zero advisories as of this writing: its CVE record was filed through third-party CNAs, and the advisory IDs cited in its own issue tracker resolve nowhere public. OpenClaw's large advisory count records bugs it found and disclosed; Hermes's third-party CVE record has no corresponding public repository advisories.

## What we do not claim

- Sandboxing and exec approvals are off by default. Default OpenClaw is a trusted single-operator assistant. Hardening is deliberate configuration, and `openclaw security audit` will tell you when you have drifted from it.
- One gateway is one trust domain. Roles and session ownership are collaboration guardrails. Tenancy means one gateway cell per tenant, and fleet is still experimental.
- Native plugins run in-process and are not sandboxed. Mitigations are allow-lists, an install-policy hook, pinned versions, dependency locking, and CI-enforced SDK boundaries. This is true of every harness in this class today; we would rather say it than have you find it.
- Egress allowlisting covers cooperating traffic only. The [secret egress proxy](/gateway/secrets) gained an opt-in traffic allowlist for Gateway-hosted exec (August 2026) on top of its bypass-surviving sentinels, sandboxed execution defaults to kernel-enforced `network: "none"` or runs under the [OpenShell backend's](/gateway/openshell) default-deny policy allowlists, but raw sockets from unsandboxed host exec answer to an operator-supplied [proxy](/security/network-proxy) or host policy, not to OpenClaw. Allowlist proxies elsewhere have had published bypasses; the sentinel design assumes bypass instead of trying to prevent it.
- Memory retention is a time-bound gap, not a control gap. Provenance is recorded per entry, an admission policy keeps designated sessions out of memory formation, and [`openclaw memory forget`](/cli/memory) purges by session, hook source, or participant (August 2026). What still does not exist is a time-based retention bound for promoted memories. Turn taint covers network-sourced tool output; text arriving through non-network tools does not taint the turn.
- `gateway.roles` shipped in August 2026. Check your installed version before depending on it.

## OpenClaw and Hermes Agent

Hermes Agent (Nous Research, MIT) is the strongest harness in the single-envelope generation. Every claim below was verified against their source at commit [`f751a8c546`](https://github.com/NousResearch/hermes-agent/tree/f751a8c5467c41500e505d90cb0eb8b70929080f) (2026-08-25); their tree moves fast, so treat the pins as a snapshot.

**Source findings.** Hermes's own [`SECURITY.md`](https://github.com/NousResearch/hermes-agent/blob/f751a8c5467c41500e505d90cb0eb8b70929080f/SECURITY.md) states the architecture plainly: "The only security boundary against an adversarial LLM is the operating system" (§2.2), and "Within the authorized set, all callers are equally trusted" (§2.6) — an allow-listed sender has the shell. Its Codex app-server runtime tracks OpenClaw's: "Mirrors openclaw" appears seven times in [`agent/transports/codex_app_server_session.py`](https://github.com/NousResearch/hermes-agent/blob/f751a8c5467c41500e505d90cb0eb8b70929080f/agent/transports/codex_app_server_session.py). An independent audit of the default configuration found 4 Critical and 9 High issues ([their tracker, #7826](https://github.com/NousResearch/hermes-agent/issues/7826)), multiple CVE records state the vendor "was contacted early about this disclosure but did not respond in any way," and their tracker records `hermes update` corrupting checkouts ([#32384](https://github.com/NousResearch/hermes-agent/issues/32384)) and a gateway leak reaching tens of GB before OOM kills ([#25315](https://github.com/NousResearch/hermes-agent/issues/25315)). A deleted memory can be re-saved by the next per-turn review pass — the resurrection failure OpenClaw's tombstones prevent. Hermes also provides TOCTOU-safe `0600` credential writes, import-frozen redaction, env-scrubbing that fixed a real passthrough leak, and excellent transcript provenance in their SQLite store.

For [model providers](/providers), OpenClaw has 54 bundled provider plugins to Hermes's roughly 31 distinct providers, with local models as dedicated plugins; on [channels](/channels), 30 documented networks to roughly 27, with exclusives on both sides — OpenClaw alone covers Twitch, Zalo (three connection paths), Nextcloud Talk, Urbit, and generic Nostr (Hermes speaks Nostr only to Block's Buzz community relays).

**Where Hermes is ahead.** After checking both source trees, Hermes leads in one area: a few first-party niche adapters. Hermes bundles SimpleX, ntfy, and a conversational email channel (IMAP polling, threaded SMTP replies) in-tree; its A2A adapter is matched by OpenClaw's own A2A v1.0 plugin. OpenClaw handles these integrations differently: SimpleX has an actively maintained community plugin (`@dangoldbj/openclaw-simplex` on npm), ntfy pushes work through [webhook delivery](/automation/webhook) plus ClawHub send skills (zero recorded channel demand in our tracker), and email is automation rather than a chat channel — the bundled [IMAP trigger](/automation/imap) routes each authenticated inbound message from any provider into an isolated, tool-restricted reader session ([Gmail push](/automation/gmail-pubsub) does the same for Gmail), with sending through skills. Hermes's email channel hands an authorized sender the full tool surface in one collapsed per-sender session; OpenClaw's isolation is designed to avoid that access model. Home Assistant has a first-party [MCP connector](/tools/mcp) plus a ClawHub skill, though their adapter also streams state-change events inbound. Both projects support third-party channel plugins; the difference is who maintains the niche adapters. For one trusted operator on their own machine, Hermes remains a strong choice.

| Property             | OpenClaw                                                                                                      | Hermes Agent (`f751a8c546`)                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Trust boundary       | Trusted gateway; execution movable to sandbox, node, or cloud worker; OpenShell-native backend                | Single process; backends move terminal+file tools only; containment delegated to an OS wrapper                                                |
| Policy gate          | Deterministic, fail-closed; denied tools structurally absent; LLM review as a layer behind deny floors        | LLM judge (`smart`) by default over a 111-pattern deny-list; unmatched commands run unprompted; non-interactive paths fail open               |
| Vendor harnesses     | Codex app-server, Copilot SDK, Claude Agent SDK as native runtimes                                            | Codex runtime opt-in, text-only, no thread resume or tool bridging; Copilot flattened to a chat-completions shim                              |
| Code execution       | TypeScript in an isolated QuickJS VM, per-call policy intact                                                  | Python in a child process that RPCs into the trusted parent                                                                                   |
| Roles and multi-user | Person-level role ceilings, scopes, session attribution; per-tenant fleet cells (experimental)                | All authorized callers equally trusted; slash-command gating only; instance per person                                                        |
| Secrets              | SecretRef with per-owner fail-closed degradation; egress sentinels                                            | Plaintext files into `os.environ`; vaults resolve into env; DB transcripts unredacted                                                         |
| Email                | IMAP trigger routes inbound mail to isolated, tool-restricted reader sessions; send via skills                | IMAP/SMTP chat channel; authorized sender reaches the full tool surface in one per-sender session                                             |
| Upgrades             | Four channels, immutable versions, schema-guarded updates, sealed release validation                          | `git pull origin main`; no channels; tags are rollback anchors; Docker `:latest` tracks main                                                  |
| Memory provenance    | Per-entry origin provenance; structural taint gate; admission policy; provenance-linked purge with tombstones | None in the built-in store; purge-by-source inexpressible; autonomous writes on by default                                                    |
| Audit                | Metadata-only ledger, closed vocabularies, 30-day bound, published non-claims                                 | Rich session attribution; artifacts scattered, no retention policy; trace export via opt-in Langfuse only                                     |
| Worker observability | Terminal for local and cloud sessions, portals proxying dev servers, brokered loopback-VNC desktop            | Terminal output only                                                                                                                          |
| Plugins              | In-process, unsandboxed (stated); manifest validated without executing code; CI-enforced SDK boundary         | In-process, unsandboxed (stated); declaration-hash consent; install-time scan only                                                            |
| Security record      | Hundreds of self-published advisories, batch-disclosed with fixes                                             | Default-config audit: 4 Critical, 9 High (#7826); CVEs filed by third-party CNAs; documented vendor non-response                              |
| Governance           | OpenClaw Foundation (non-profit), MIT, signed releases, published advisories, public maturity scorecard       | Venture-funded company (Nous Research; Paradigm-led Series A at a token valuation), MIT, candid security policy, no published repo advisories |

## The hardened setup

Each enterprise configuration item links to its reference:

- Sandbox on: `agents.defaults.sandbox.mode: "all"` with the [`openshell`](/gateway/openshell) or [`docker`](/gateway/sandboxing) backend; `workspaceAccess: "ro"` unless the agent owns the workspace.
- Sessions default to [`guarded` or `workspace`](/gateway/permission-modes); `full` stays admin-only.
- Front the gateway with [Tailscale](/gateway/tailscale) or an [identity-aware proxy](/gateway/trusted-proxy-auth); define [`gateway.roles`](/gateway/operator-scopes) with a deny-all default; leave DM policy on [pairing](/channels/pairing).
- Everything behind [SecretRefs](/gateway/secrets); run `openclaw secrets audit --check` against your config in CI.
- Enable [message auditing](/gateway/audit); ship [OpenTelemetry](/gateway/telemetry) to your SIEM for durable records.
- Schedule [`openclaw security audit --deep`](/gateway/security/audit-checks) and alarm on its check IDs.

Then operate it as replaceable infrastructure: pin a channel, let [doctor](/cli/doctor) own migrations, restore [backups](/cli/backup) by verification, and redeploy instead of repairing deployments in place.

Corrections to any claim on this page, about OpenClaw or about others, are welcome as issues or pull requests.
