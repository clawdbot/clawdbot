---
summary: "What `openclaw security audit` inspects and the order to fix its findings in"
read_when:
  - You changed config and want to know whether you drifted from safe defaults
  - You are about to expose a network surface
  - You have audit findings and need a triage order
title: "Running the security audit"
sidebarTitle: "Running the audit"
---

## `openclaw security audit`

Run this after any config change or before exposing network surfaces:

```bash
openclaw security audit
openclaw security audit --deep    # attempts a live Gateway probe
openclaw security audit --fix     # apply safe remediations
openclaw security audit --json
```

`--fix` is intentionally narrow: it flips open group policies to allowlists, tightens state/config/include-file permissions (`600` files, `700` dirs), and on Windows uses ACL resets instead of POSIX `chmod`.

### What the audit checks (high level)

- **Inbound access** - DM/group policies, allowlists: can strangers trigger the bot?
- **Cross-agent session access** - two or more agents with default Gateway-wide session visibility and unrestricted agent-to-agent access: `info` for one operator's personas, `warn` when sandboxing, agent-level tool restrictions, or shared-user ingress suggest different trust levels. Fully sandboxed rosters under the default spawn-tree clamp produce no finding; setting `agents.defaults.sandbox.sessionToolsVisibility` to `"all"` disables that exemption.
- **Tool blast radius** - elevated tools + open rooms: could prompt injection become shell/file/network actions?
- **Exec filesystem drift** - mutating filesystem tools denied while `exec`/`process` stay available without sandbox constraints.
- **Exec approval drift** - `security="full"`, `autoAllowSkills`, interpreter allowlists without `strictInlineEval`. `security="full"` alone is a broad posture warning, not proof of a bug - it is the chosen default for trusted-operator setups; tighten it only when your threat model needs approval or allowlist guardrails.
- **Network exposure** - Gateway bind/auth, Tailscale Serve/Funnel, weak/short auth tokens.
- **Browser control exposure** - remote nodes, relay ports, remote CDP endpoints.
- **Local disk hygiene** - permissions, symlinks, config includes, synced-folder paths.
- **Plugins** - loading without an explicit allowlist.
- **Policy drift** - sandbox Docker settings configured but sandbox mode off; `gateway.nodes.commands.deny` entries that look effective but only match exact command IDs (for example `system.run`), not shell text inside the payload; dangerous `gateway.nodes.commands.allow` entries; global `tools.profile="minimal"` overridden per agent; plugin-owned tools reachable under a permissive policy.
- **Runtime expectation drift** - assuming implicit exec still means `sandbox` when `tools.exec.host` now defaults to `auto`, or setting `tools.exec.host="sandbox"` while sandbox mode is off.
- **Model hygiene** - warns on legacy configured models (soft warning, not a hard block).

Each finding has a structured `checkId` (for example `gateway.bind_no_auth`, `tools.exec.security_full_configured`). Prefixes: `fs.*` (permissions), `gateway.*` (bind/auth/Tailscale/Control UI/trusted-proxy), `hooks.*`/`browser.*`/`sandbox.*`/`tools.exec.*` (per-surface hardening), `plugins.*`/`skills.*` (supply chain), `security.exposure.*` (access policy x tool blast radius), `security.trust_model.*` (shared-context and cross-agent defaults). Full catalog with severity and auto-fix support: [Security audit checks](/gateway/security/audit-checks). See also [Formal Verification](/security/formal-verification).

### Priority order when triaging findings

1. Anything "open" + tools enabled: lock down DMs/groups first (pairing/allowlists), then tighten tool policy/sandboxing.
2. Public network exposure (LAN bind, Funnel, missing auth): fix immediately.
3. Browser control remote exposure: treat like operator access (tailnet-only, pair nodes deliberately, no public exposure).
4. Permissions: state/config/credentials/auth must not be group/world-readable.
5. Plugins: load only what you explicitly trust.
6. Model choice: prefer modern, instruction-hardened models for any bot with tools.
