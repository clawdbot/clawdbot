---
summary: "Runtime config: worktree root, model routing, discovery, updates, ACP, and the wizard"
read_when:
  - Choosing where agent worktrees live
  - Setting model routing or discovery defaults
  - Auditing update, ACP, or wizard config
title: "Configuration — runtime basics"
---

Top-level runtime keys: `worktreeRoot`, `models.*`, `discovery.*`, `update.*`, `acp.*`, and `wizard.*`.

For the full key index and the other top-level config domains, see [Configuration reference](/gateway/configuration-reference).

## `worktreeRoot`

Optional global root directory for [managed worktree](/concepts/managed-worktrees) checkouts. Defaults to `<openclaw-state-dir>/worktrees`.

```json5
{
  worktreeRoot: "/mnt/workspaces/openclaw-worktrees",
}
```

Use an absolute Gateway-host path, `~` for the Gateway user's home directory, or `~/` followed by a folder inside it; relative paths are rejected. OpenClaw creates checkouts at `<worktreeRoot>/<repo-fingerprint>/<name>`. This setting applies to all agents and all managed-worktree owners, with no per-agent override. The shared state database and allocation limits remain under the existing state directory.

Changes affect new allocations only. Registered worktrees retain their original paths for reuse, cleanup, and snapshot restore; existing checkouts are not moved automatically. Keep their original storage available while those records are still needed.

## Models

Provider definitions, model allowlists, and custom provider setup live in
[Configuration - tools and custom providers](/gateway/config-tools#custom-providers-and-base-urls).
The `models` root also owns global model-catalog behavior.

```json5
{
  models: {
    // Optional. Hosted catalog updates default on.
    catalogRefresh: {
      enabled: true,
      // url: "https://catalog.example.com/openclaw/catalog.json",
    },
  },
}
```

- `models.mode`: provider catalog behavior (`merge` or `replace`).
- `models.providers`: custom provider map keyed by provider id.
- `models.providers.*.localService`: optional on-demand process manager for
  local model servers. OpenClaw probes the configured health endpoint, starts
  the absolute `command` when needed, waits for readiness, then sends the model
  request. See [Local model services](/gateway/local-model-services).
- `models.catalogRefresh.enabled`: controls the hosted model catalog refresh
  (default: `true`). Set it to `false` to prevent all remote catalog requests;
  model metadata and pricing then stay at the values shipped in the installed
  release or declared under `models.providers.*.models[].cost`.
- `models.catalogRefresh.url`: optional HTTPS mirror override (plain HTTP is
  accepted only for explicit localhost testing). The Gateway
  checks in the background at startup and every six hours. A downloaded catalog
  applies on the next Gateway restart; a release whose bundled catalog is newer
  always wins.

Pricing updates ship in the same hosted catalog file as model metadata. The
retired `models.pricing` toggle is removed automatically by `openclaw doctor
--fix`; use `models.catalogRefresh.enabled: false` when OpenClaw must avoid all
hosted catalog traffic.

## Discovery

### mDNS (Bonjour)

```json5
{
  discovery: {
    mdns: {
      mode: "minimal", // minimal | full | off
    },
  },
}
```

- `minimal` (default): omit `cliPath` + `sshPort` from TXT records.
- `full`: include `cliPath` + `sshPort`; LAN multicast advertising still requires the bundled `bonjour` plugin to be enabled.
- `off`: suppress LAN multicast advertising without changing plugin enablement.
- The bundled `bonjour` plugin auto-starts on macOS hosts and is opt-in on Linux, Windows, and containerized Gateway deployments.
- Hostname defaults to the system hostname when it is a valid DNS label, falling back to `openclaw`. Override with `OPENCLAW_MDNS_HOSTNAME`.
- `OPENCLAW_DISABLE_BONJOUR=1` disables mDNS advertising outright, overriding `discovery.mdns.mode`.

### Wide-area (DNS-SD)

```json5
{
  discovery: {
    wideArea: { domain: "openclaw.internal" },
  },
}
```

Setting `discovery.wideArea.domain` enables wide-area discovery and writes a unicast DNS-SD zone under `~/.openclaw/dns/`. For cross-network discovery, pair with a DNS server (CoreDNS recommended) + Tailscale split DNS.

Setup: `openclaw dns setup --apply`.

---

## Update

```json5
{
  update: {
    channel: "stable", // stable | extended-stable | beta | dev
    checkOnStart: true,

    auto: {
      enabled: false,
    },
  },
}
```

- `channel`: release channel - `"stable"`, `"extended-stable"`, `"beta"`, or `"dev"`. Extended-stable is package-only: foreground commands own installation, while the Gateway may emit read-only update hints.
- `checkOnStart`: check for updates through `https://telemetry.openclaw.ai/api/latest-version` when the Gateway starts and at most once every 24 hours afterward (default: `true`). The default request shares only the OpenClaw version and platform information in its `User-Agent`; anonymous feature statistics are included only when `telemetry.enabled` is `true`. Setting this to `false`, or setting `OPENCLAW_NO_AUTO_UPDATE=1`, prevents all automatic update requests, feature statistics, and update notices, even when `auto.enabled` is `true`. Stored extended-stable selections use the same read-only hint and 24-hour hint schedule.
- `auto.enabled`: enable background auto-update campaigns for stable and beta package installs and dev git installs when `checkOnStart` is also enabled (default: `false`). Extended-stable never applies automatically.

---

## ACP

```json5
{
  acp: {
    enabled: true,
    dispatch: { enabled: true },
    backend: "acpx",
    fallbacks: ["acpx-secondary"],
    defaultAgent: "main",
    allowedAgents: ["main", "ops"],
    stream: {
      repeatSuppression: true,
      deliveryMode: "live", // live | final_only
    },
  },
}
```

- `enabled`: global ACP feature gate (default: `true`; set `false` to hide ACP dispatch and spawn affordances).
- `dispatch.enabled`: independent gate for ACP session turn dispatch (default: `true`). Set `false` to keep ACP commands available while blocking execution.
- `backend`: default ACP runtime backend id (must match a registered ACP runtime plugin).
  Install the backend plugin first, and if `plugins.allow` is set, include the backend plugin id (for example `acpx`) or the ACP backend will not load.
- `fallbacks`: ordered list of fallback ACP backend ids tried when the primary backend fails early with a transient-looking error (unavailable, rate-limited, quota exhausted, or overloaded) before it produced any output. Each entry must match a registered ACP runtime plugin backend.
- `defaultAgent`: fallback ACP target agent id when spawns do not specify an explicit target.
- `allowedAgents`: allowlist of agent ids permitted for ACP runtime sessions; empty means no additional restriction.
- `stream.repeatSuppression`: suppress repeated status/tool lines per turn (default: `true`).
- `stream.deliveryMode`: `"live"` streams incrementally; `"final_only"` buffers until turn terminal events.
- `stream.tagVisibility`: record of tag names to boolean visibility overrides for streamed events.
- `runtime.installCommand`: optional install command to run when bootstrapping an ACP runtime environment.

---

## Wizard

Behavior and metadata for CLI guided setup flows (`onboard`, `configure`, `doctor`):

```json5
{
  wizard: {
    accessMode: "full",
    appRecommendations: true,
    lastRunAt: "2026-01-01T00:00:00.000Z",
    lastRunVersion: "2026.1.4",
    lastRunCommit: "abc1234",
    lastRunCommand: "configure",
    lastRunMode: "local",
    securityAcknowledgedAt: "2026-01-01T00:00:00.000Z",
  },
}
```

- `wizard.accessMode`: discovery consent chosen at the start of guided onboarding. `"full"` (recommended) lets setup look for AI apps, keys, and local runtimes automatically; `"guarded"` makes setup ask once before looking around and offers manual configuration instead.

- `wizard.appRecommendations` defaults to `true`. Set it to `false` to disable installed-application recommendations during guided or classic onboarding and block Gateway `device.apps` access. Node hosts still require their separate, default-off installed-app sharing flag before they advertise the command.

---

## Bridge (legacy, removed)

Current builds no longer include the TCP bridge. Nodes connect over the Gateway WebSocket. `bridge.*` keys are no longer part of the config schema (validation fails until removed; `openclaw doctor --fix` can strip unknown keys).

<Accordion title="Legacy bridge config (historical reference)">

```json
{
  "bridge": {
    "enabled": true,
    "port": 18790,
    "bind": "tailnet",
    "tls": {
      "enabled": true,
      "autoGenerate": true
    }
  }
}
```

</Accordion>

---
