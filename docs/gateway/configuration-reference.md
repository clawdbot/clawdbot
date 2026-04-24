---
summary: "Gateway config reference for core OpenClaw keys, defaults, and links to dedicated subsystem references"
title: "Configuration reference"
read_when:
  - You need exact field-level config semantics or defaults
  - You are validating channel, model, gateway, or tool config blocks
---

Core config reference for `~/.openclaw/openclaw.json`. For a task-oriented overview, see [Configuration](/gateway/configuration).

This page covers the main OpenClaw config surfaces and links out when a subsystem has its own deeper reference. It does **not** try to inline every channel/plugin-owned command catalog or every deep memory/QMD knob on one page.

Code truth:

- `openclaw config schema` prints the live JSON Schema used for validation and Control UI, with bundled/plugin/channel metadata merged in when available
- `config.schema.lookup` returns one path-scoped schema node for drill-down tooling
- `pnpm config:docs:check` / `pnpm config:docs:gen` validate the config-doc baseline hash against the current schema surface

Dedicated deep references:

- [Memory configuration reference](/reference/memory-config) for `agents.defaults.memorySearch.*`, `memory.qmd.*`, `memory.citations`, and dreaming config under `plugins.entries.memory-core.config.dreaming`
- [Slash Commands](/tools/slash-commands) for the current built-in + bundled command catalog
- owning channel/plugin pages for channel-specific command surfaces

Config format is **JSON5** (comments + trailing commas allowed). All fields are optional — OpenClaw uses safe defaults when omitted.

---

## Channels

Per-channel config keys moved to a dedicated page — see
[Configuration — channels](/gateway/config-channels) for `channels.*`,
including Slack, Discord, Telegram, WhatsApp, Matrix, iMessage, and other
bundled channels (auth, access control, multi-account, mention gating).

## Agent defaults, multi-agent, sessions, and messages

Moved to a dedicated page — see
[Configuration — agents](/gateway/config-agents) for:

- `agents.defaults.*` (workspace, model, thinking, heartbeat, memory, media, skills, sandbox)
- `multiAgent.*` (multi-agent routing and bindings)
- `session.*` (session lifecycle, compaction, pruning)
- `messages.*` (message delivery, TTS, markdown rendering)
- `talk.*` (Talk mode)
  - `talk.silenceTimeoutMs`: when unset, Talk keeps the platform default pause window before sending the transcript (`700 ms on macOS and Android, 900 ms on iOS`)

## Tools and custom providers

Tool policy, experimental toggles, provider-backed tool config, and custom
provider / base-URL setup moved to a dedicated page — see
[Configuration — tools and custom providers](/gateway/config-tools).

## Skills

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills"],
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun
    },
    entries: {
      "image-lab": {
        apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" }, // or plaintext string
        env: { GEMINI_API_KEY: "GEMINI_KEY_HERE" },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

- `allowBundled`: optional allowlist for bundled skills only (managed/workspace skills unaffected).
- `load.extraDirs`: extra shared skill roots (lowest precedence).
- `install.preferBrew`: when true, prefer Homebrew installers when `brew` is
  available before falling back to other installer kinds.
- `install.nodeManager`: node installer preference for `metadata.openclaw.install`
  specs (`npm` | `pnpm` | `yarn` | `bun`).
- `entries.<skillKey>.enabled: false` disables a skill even if bundled/installed.
- `entries.<skillKey>.apiKey`: convenience for skills declaring a primary env var (plaintext string or SecretRef object).

---

## Plugins

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: [],
    load: {
      paths: ["~/Projects/oss/voice-call-plugin"],
    },
    entries: {
      "voice-call": {
        enabled: true,
        hooks: {
          allowPromptInjection: false,
        },
        config: { provider: "twilio" },
      },
    },
  },
}
```

- Loaded from `~/.openclaw/extensions`, `<workspace>/.openclaw/extensions`, plus `plugins.load.paths`.
- Discovery accepts native OpenClaw plugins plus compatible Codex bundles and Claude bundles, including manifestless Claude default-layout bundles.
- **Config changes require a gateway restart.**
- `allow`: optional allowlist (only listed plugins load). `deny` wins.
- `plugins.entries.<id>.apiKey`: plugin-level API key convenience field (when supported by the plugin).
- `plugins.entries.<id>.env`: plugin-scoped env var map.
- `plugins.entries.<id>.hooks.allowPromptInjection`: when `false`, core blocks `before_prompt_build` and ignores prompt-mutating fields from legacy `before_agent_start`, while preserving legacy `modelOverride` and `providerOverride`. Applies to native plugin hooks and supported bundle-provided hook directories.
- `plugins.entries.<id>.subagent.allowModelOverride`: explicitly trust this plugin to request per-run `provider` and `model` overrides for background subagent runs.
- `plugins.entries.<id>.subagent.allowedModels`: optional allowlist of canonical `provider/model` targets for trusted subagent overrides. Use `"*"` only when you intentionally want to allow any model.
- `plugins.entries.<id>.config`: plugin-defined config object (validated by native OpenClaw plugin schema when available).
- `plugins.entries.firecrawl.config.webFetch`: Firecrawl web-fetch provider settings.
  - `apiKey`: Firecrawl API key (accepts SecretRef). Falls back to `plugins.entries.firecrawl.config.webSearch.apiKey`, legacy `tools.web.fetch.firecrawl.apiKey`, or `FIRECRAWL_API_KEY` env var.
  - `baseUrl`: Firecrawl API base URL (default: `https://api.firecrawl.dev`).
  - `onlyMainContent`: extract only the main content from pages (default: `true`).
  - `maxAgeMs`: maximum cache age in milliseconds (default: `172800000` / 2 days).
  - `timeoutSeconds`: scrape request timeout in seconds (default: `60`).
- `plugins.entries.xai.config.xSearch`: xAI X Search (Grok web search) settings.
  - `enabled`: enable the X Search provider.
  - `model`: Grok model to use for search (e.g. `"grok-4-1-fast"`).
- `plugins.entries.memory-core.config.dreaming`: memory dreaming settings. See [Dreaming](/concepts/dreaming) for phases and thresholds.
  - `enabled`: master dreaming switch (default `false`).
  - `frequency`: cron cadence for each full dreaming sweep (`"0 3 * * *"` by default).
  - phase policy and thresholds are implementation details (not user-facing config keys).
- Full memory config lives in [Memory configuration reference](/reference/memory-config):
  - `agents.defaults.memorySearch.*`
  - `memory.backend`
  - `memory.citations`
  - `memory.qmd.*`
  - `plugins.entries.memory-core.config.dreaming`
- Enabled Claude bundle plugins can also contribute embedded Pi defaults from `settings.json`; OpenClaw applies those as sanitized agent settings, not as raw OpenClaw config patches.
- `plugins.slots.memory`: pick the active memory plugin id, or `"none"` to disable memory plugins.
- `plugins.slots.contextEngine`: pick the active context engine plugin id; defaults to `"legacy"` unless you install and select another engine.
- `plugins.installs`: CLI-managed install metadata used by `openclaw plugins update`.
  - Includes `source`, `spec`, `sourcePath`, `installPath`, `version`, `resolvedName`, `resolvedVersion`, `resolvedSpec`, `integrity`, `shasum`, `resolvedAt`, `installedAt`.
  - Treat `plugins.installs.*` as managed state; prefer CLI commands over manual edits.

See [Plugins](/tools/plugin).

---

## Browser

```json5
{
  browser: {
    enabled: true,
    evaluateEnabled: true,
    defaultProfile: "user",
    ssrfPolicy: {
      // dangerouslyAllowPrivateNetwork: true, // opt in only for trusted private-network access
      // allowPrivateNetwork: true, // legacy alias
      // hostnameAllowlist: ["*.example.com", "example.com"],
      // allowedHostnames: ["localhost"],
    },
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      user: { driver: "existing-session", attachOnly: true, color: "#00AA00" },
      brave: {
        driver: "existing-session",
        attachOnly: true,
        userDataDir: "~/Library/Application Support/BraveSoftware/Brave-Browser",
        color: "#FB542B",
      },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
    color: "#FF4500",
    // headless: false,
    // noSandbox: false,
    // extraArgs: [],
    // executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    // attachOnly: false,
  },
}
```

- `evaluateEnabled: false` disables `act:evaluate` and `wait --fn`.
- `ssrfPolicy.dangerouslyAllowPrivateNetwork` is disabled when unset, so browser navigation stays strict by default.
- Set `ssrfPolicy.dangerouslyAllowPrivateNetwork: true` only when you intentionally trust private-network browser navigation.
- In strict mode, remote CDP profile endpoints (`profiles.*.cdpUrl`) are subject to the same private-network blocking during reachability/discovery checks.
- `ssrfPolicy.allowPrivateNetwork` remains supported as a legacy alias.
- In strict mode, use `ssrfPolicy.hostnameAllowlist` and `ssrfPolicy.allowedHostnames` for explicit exceptions.
- Remote profiles are attach-only (start/stop/reset disabled).
- `profiles.*.cdpUrl` accepts `http://`, `https://`, `ws://`, and `wss://`.
  Use HTTP(S) when you want OpenClaw to discover `/json/version`; use WS(S)
  when your provider gives you a direct DevTools WebSocket URL.
- `existing-session` profiles use Chrome MCP instead of CDP and can attach on
  the selected host or through a connected browser node.
- `existing-session` profiles can set `userDataDir` to target a specific
  Chromium-based browser profile such as Brave or Edge.
- `existing-session` profiles keep the current Chrome MCP route limits:
  snapshot/ref-driven actions instead of CSS-selector targeting, one-file upload
  hooks, no dialog timeout overrides, no `wait --load networkidle`, and no
  `responsebody`, PDF export, download interception, or batch actions.
- Local managed `openclaw` profiles auto-assign `cdpPort` and `cdpUrl`; only
  set `cdpUrl` explicitly for remote CDP.
- Auto-detect order: default browser if Chromium-based → Chrome → Brave → Edge → Chromium → Chrome Canary.
- Control service: loopback only (port derived from `gateway.port`, default `18791`).
- `extraArgs` appends extra launch flags to local Chromium startup (for example
  `--disable-gpu`, window sizing, or debug flags).

---

## UI

```json5
{
  ui: {
    seamColor: "#FF4500",
    assistant: {
      name: "OpenClaw",
      avatar: "CB", // emoji, short text, image URL, or data URI
    },
  },
}
```

- `seamColor`: accent color for native app UI chrome (Talk Mode bubble tint, etc.).
- `assistant`: Control UI identity override. Falls back to active agent identity.

---

## Gateway

```json5
{
  gateway: {
    mode: "local", // local | remote
    port: 18789,
    bind: "loopback",
    auth: {
      mode: "token", // none | token | password | trusted-proxy
      token: "your-token",
      // password: "your-password", // or OPENCLAW_GATEWAY_PASSWORD
      // trustedProxy: { userHeader: "x-forwarded-user" }, // for mode=trusted-proxy; see /gateway/trusted-proxy-auth
      allowTailscale: true,
      rateLimit: {
        maxAttempts: 10,
        windowMs: 60000,
        lockoutMs: 300000,
        exemptLoopback: true,
      },
    },
    tailscale: {
      mode: "off", // off | serve | funnel
      resetOnExit: false,
    },
    controlUi: {
      enabled: true,
      basePath: "/openclaw",
      // root: "dist/control-ui",
      // embedSandbox: "scripts", // strict | scripts | trusted
      // allowExternalEmbedUrls: false, // dangerous: allow absolute external http(s) embed URLs
      // allowedOrigins: ["https://control.example.com"], // required for non-loopback Control UI
      // dangerouslyAllowHostHeaderOriginFallback: false, // dangerous Host-header origin fallback mode
      // allowInsecureAuth: false,
      // dangerouslyDisableDeviceAuth: false,
    },
    remote: {
      url: "ws://gateway.tailnet:18789",
      transport: "ssh", // ssh | direct
      token: "your-token",
      // password: "your-password",
    },
    trustedProxies: ["10.0.0.1"],
    // Optional. Default false.
    allowRealIpFallback: false,
    tools: {
      // Additional /tools/invoke HTTP denies
      deny: ["browser"],
      // Remove tools from the default HTTP deny list
      allow: ["gateway"],
    },
    push: {
      apns: {
        relay: {
          baseUrl: "https://relay.example.com",
          timeoutMs: 10000,
        },
      },
    },
  },
}
```

<Accordion title="Gateway field details">

- `mode`: `local` (run gateway) or `remote` (connect to remote gateway). Gateway refuses to start unless `local`.
- `port`: single multiplexed port for WS + HTTP. Precedence: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > `18789`.
- `bind`: `auto`, `loopback` (default), `lan` (`0.0.0.0`), `tailnet` (Tailscale IP only), or `custom`.
- **Legacy bind aliases**: use bind mode values in `gateway.bind` (`auto`, `loopback`, `lan`, `tailnet`, `custom`), not host aliases (`0.0.0.0`, `127.0.0.1`, `localhost`, `::`, `::1`).
- **Docker note**: the default `loopback` bind listens on `127.0.0.1` inside the container. With Docker bridge networking (`-p 18789:18789`), traffic arrives on `eth0`, so the gateway is unreachable. Use `--network host`, or set `bind: "lan"` (or `bind: "custom"` with `customBindHost: "0.0.0.0"`) to listen on all interfaces.
- **Auth**: required by default. Non-loopback binds require gateway auth. In practice that means a shared token/password or an identity-aware reverse proxy with `gateway.auth.mode: "trusted-proxy"`. Onboarding wizard generates a token by default.
- If both `gateway.auth.token` and `gateway.auth.password` are configured (including SecretRefs), set `gateway.auth.mode` explicitly to `token` or `password`. Startup and service install/repair flows fail when both are configured and mode is unset.
- `gateway.auth.mode: "none"`: explicit no-auth mode. Use only for trusted local loopback setups; this is intentionally not offered by onboarding prompts.
- `gateway.auth.mode: "trusted-proxy"`: delegate auth to an identity-aware reverse proxy and trust identity headers from `gateway.trustedProxies` (see [Trusted Proxy Auth](/gateway/trusted-proxy-auth)). This mode expects a **non-loopback** proxy source; same-host loopback reverse proxies do not satisfy trusted-proxy auth.
- `gateway.auth.allowTailscale`: when `true`, Tailscale Serve identity headers can satisfy Control UI/WebSocket auth (verified via `tailscale whois`). HTTP API endpoints do **not** use that Tailscale header auth; they follow the gateway's normal HTTP auth mode instead. This tokenless flow assumes the gateway host is trusted. Defaults to `true` when `tailscale.mode = "serve"`.
- `gateway.auth.rateLimit`: optional failed-auth limiter. Applies per client IP and per auth scope (shared-secret and device-token are tracked independently). Blocked attempts return `429` + `Retry-After`.
  - On the async Tailscale Serve Control UI path, failed attempts for the same `{scope, clientIp}` are serialized before the failure write. Concurrent bad attempts from the same client can therefore trip the limiter on the second request instead of both racing through as plain mismatches.
  - `gateway.auth.rateLimit.exemptLoopback` defaults to `true`; set `false` when you intentionally want localhost traffic rate-limited too (for test setups or strict proxy deployments).
- Browser-origin WS auth attempts are always throttled with loopback exemption disabled (defense-in-depth against browser-based localhost brute force).
- On loopback, those browser-origin lockouts are isolated per normalized `Origin`
  value, so repeated failures from one localhost origin do not automatically
  lock out a different origin.
- `tailscale.mode`: `serve` (tailnet only, loopback bind) or `funnel` (public, requires auth).
- `controlUi.allowedOrigins`: explicit browser-origin allowlist for Gateway WebSocket connects. Required when browser clients are expected from non-loopback origins.
- `controlUi.dangerouslyAllowHostHeaderOriginFallback`: dangerous mode that enables Host-header origin fallback for deployments that intentionally rely on Host-header origin policy.
- `remote.transport`: `ssh` (default) or `direct` (ws/wss). For `direct`, `remote.url` must be `ws://` or `wss://`.
- `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1`: client-side process-environment
  break-glass override that allows plaintext `ws://` to trusted private-network
  IPs; default remains loopback-only for plaintext. There is no `openclaw.json`
  equivalent, and browser private-network config such as
  `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork` does not affect Gateway
  WebSocket clients.
- `gateway.remote.token` / `.password` are remote-client credential fields. They do not configure gateway auth by themselves.
- `gateway.push.apns.relay.baseUrl`: base HTTPS URL for the external APNs relay used by official/TestFlight iOS builds after they publish relay-backed registrations to the gateway. This URL must match the relay URL compiled into the iOS build.
- `gateway.push.apns.relay.timeoutMs`: gateway-to-relay send timeout in milliseconds. Defaults to `10000`.
- Relay-backed registrations are delegated to a specific gateway identity. The paired iOS app fetches `gateway.identity.get`, includes that identity in the relay registration, and forwards a registration-scoped send grant to the gateway. Another gateway cannot reuse that stored registration.
- `OPENCLAW_APNS_RELAY_BASE_URL` / `OPENCLAW_APNS_RELAY_TIMEOUT_MS`: temporary env overrides for the relay config above.
- `OPENCLAW_APNS_RELAY_ALLOW_HTTP=true`: development-only escape hatch for loopback HTTP relay URLs. Production relay URLs should stay on HTTPS.
- `gateway.channelHealthCheckMinutes`: channel health-monitor interval in minutes. Set `0` to disable health-monitor restarts globally. Default: `5`.
- `gateway.channelStaleEventThresholdMinutes`: stale-socket threshold in minutes. Keep this greater than or equal to `gateway.channelHealthCheckMinutes`. Default: `30`.
- `gateway.channelMaxRestartsPerHour`: maximum health-monitor restarts per channel/account in a rolling hour. Default: `10`.
- `channels.<provider>.healthMonitor.enabled`: per-channel opt-out for health-monitor restarts while keeping the global monitor enabled.
- `channels.<provider>.accounts.<accountId>.healthMonitor.enabled`: per-account override for multi-account channels. When set, it takes precedence over the channel-level override.
- Local gateway call paths can use `gateway.remote.*` as fallback only when `gateway.auth.*` is unset.
- If `gateway.auth.token` / `gateway.auth.password` is explicitly configured via SecretRef and unresolved, resolution fails closed (no remote fallback masking).
- `trustedProxies`: reverse proxy IPs that terminate TLS or inject forwarded-client headers. Only list proxies you control. Loopback entries are still valid for same-host proxy/local-detection setups (for example Tailscale Serve or a local reverse proxy), but they do **not** make loopback requests eligible for `gateway.auth.mode: "trusted-proxy"`.
- `allowRealIpFallback`: when `true`, the gateway accepts `X-Real-IP` if `X-Forwarded-For` is missing. Default `false` for fail-closed behavior.
- `gateway.tools.deny`: extra tool names blocked for HTTP `POST /tools/invoke` (extends default deny list).
- `gateway.tools.allow`: remove tool names from the default HTTP deny list.

</Accordion>

### OpenAI-compatible endpoints

- Chat Completions: disabled by default. Enable with `gateway.http.endpoints.chatCompletions.enabled: true`.
- Responses API: `gateway.http.endpoints.responses.enabled`.
- Responses URL-input hardening:
  - `gateway.http.endpoints.responses.maxUrlParts`
  - `gateway.http.endpoints.responses.files.urlAllowlist`
  - `gateway.http.endpoints.responses.images.urlAllowlist`
    Empty allowlists are treated as unset; use `gateway.http.endpoints.responses.files.allowUrl=false`
    and/or `gateway.http.endpoints.responses.images.allowUrl=false` to disable URL fetching.
- Optional response hardening header:
  - `gateway.http.securityHeaders.strictTransportSecurity` (set only for HTTPS origins you control; see [Trusted Proxy Auth](/gateway/trusted-proxy-auth#tls-termination-and-hsts))

### Multi-instance isolation

Run multiple gateways on one host with unique ports and state dirs:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json \
OPENCLAW_STATE_DIR=~/.openclaw-a \
openclaw gateway --port 19001
```

Convenience flags: `--dev` (uses `~/.openclaw-dev` + port `19001`), `--profile <name>` (uses `~/.openclaw-<name>`).

See [Multiple Gateways](/gateway/multiple-gateways).

### `gateway.tls`

```json5
{
  gateway: {
    tls: {
      enabled: false,
      autoGenerate: false,
      certPath: "/etc/openclaw/tls/server.crt",
      keyPath: "/etc/openclaw/tls/server.key",
      caPath: "/etc/openclaw/tls/ca-bundle.crt",
    },
  },
}
```

- `enabled`: enables TLS termination at the gateway listener (HTTPS/WSS) (default: `false`).
- `autoGenerate`: auto-generates a local self-signed cert/key pair when explicit files are not configured; for local/dev use only.
- `certPath`: filesystem path to the TLS certificate file.
- `keyPath`: filesystem path to the TLS private key file; keep permission-restricted.
- `caPath`: optional CA bundle path for client verification or custom trust chains.

### `gateway.reload`

```json5
{
  gateway: {
    reload: {
      mode: "hybrid", // off | restart | hot | hybrid
      debounceMs: 500,
      deferralTimeoutMs: 300000,
    },
  },
}
```

- `mode`: controls how config edits are applied at runtime.
  - `"off"`: ignore live edits; changes require an explicit restart.
  - `"restart"`: always restart the gateway process on config change.
  - `"hot"`: apply changes in-process without restarting.
  - `"hybrid"` (default): try hot reload first; fall back to restart if required.
- `debounceMs`: debounce window in ms before config changes are applied (non-negative integer).
- `deferralTimeoutMs`: maximum time in ms to wait for in-flight operations before forcing a restart (default: `300000` = 5 minutes).

---

## Hooks

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    maxBodyBytes: 262144,
    defaultSessionKey: "hook:ingress",
    allowRequestSessionKey: true,
    allowedSessionKeyPrefixes: ["hook:", "hook:gmail:"],
    allowedAgentIds: ["hooks", "main"],
    presets: ["gmail"],
    transformsDir: "~/.openclaw/hooks/transforms",
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        agentId: "hooks",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "From: {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}",
        deliver: true,
        channel: "last",
        model: "openai/gpt-5.4-mini",
      },
    ],
  },
}
```

Auth: `Authorization: Bearer <token>` or `x-openclaw-token: <token>`.
Query-string hook tokens are rejected.

Validation and safety notes:

- `hooks.enabled=true` requires a non-empty `hooks.token`.
- `hooks.token` must be **distinct** from `gateway.auth.token`; reusing the Gateway token is rejected.
- `hooks.path` cannot be `/`; use a dedicated subpath such as `/hooks`.
- If `hooks.allowRequestSessionKey=true`, constrain `hooks.allowedSessionKeyPrefixes` (for example `["hook:"]`).
- If a mapping or preset uses a templated `sessionKey`, set `hooks.allowedSessionKeyPrefixes` and `hooks.allowRequestSessionKey=true`. Static mapping keys do not require that opt-in.

**Endpoints:**

- `POST /hooks/wake` → `{ text, mode?: "now"|"next-heartbeat" }`
- `POST /hooks/agent` → `{ message, name?, agentId?, sessionKey?, wakeMode?, deliver?, channel?, to?, model?, thinking?, timeoutSeconds? }`
  - `sessionKey` from request payload is accepted only when `hooks.allowRequestSessionKey=true` (default: `false`).
- `POST /hooks/<name>` → resolved via `hooks.mappings`
  - Template-rendered mapping `sessionKey` values are treated as externally supplied and also require `hooks.allowRequestSessionKey=true`.

<Accordion title="Mapping details">

- `match.path` matches sub-path after `/hooks` (e.g. `/hooks/gmail` → `gmail`).
- `match.source` matches a payload field for generic paths.
- Templates like `{{messages[0].subject}}` read from the payload.
- `transform` can point to a JS/TS module returning a hook action.
  - `transform.module` must be a relative path and stays within `hooks.transformsDir` (absolute paths and traversal are rejected).
- `agentId` routes to a specific agent; unknown IDs fall back to default.
- `allowedAgentIds`: restricts explicit routing (`*` or omitted = allow all, `[]` = deny all).
- `defaultSessionKey`: optional fixed session key for hook agent runs without explicit `sessionKey`.
- `allowRequestSessionKey`: allow `/hooks/agent` callers and template-driven mapping session keys to set `sessionKey` (default: `false`).
- `allowedSessionKeyPrefixes`: optional prefix allowlist for explicit `sessionKey` values (request + mapping), e.g. `["hook:"]`. It becomes required when any mapping or preset uses a templated `sessionKey`.
- `deliver: true` sends final reply to a channel; `channel` defaults to `last`.
- `model` overrides LLM for this hook run (must be allowed if model catalog is set).

</Accordion>

### Gmail integration

- The built-in Gmail preset uses `sessionKey: "hook:gmail:{{messages[0].id}}"`.
- If you keep that per-message routing, set `hooks.allowRequestSessionKey: true` and constrain `hooks.allowedSessionKeyPrefixes` to match the Gmail namespace, for example `["hook:", "hook:gmail:"]`.
- If you need `hooks.allowRequestSessionKey: false`, override the preset with a static `sessionKey` instead of the templated default.

```json5
{
  hooks: {
    gmail: {
      account: "openclaw@gmail.com",
      topic: "projects/<project-id>/topics/gog-gmail-watch",
      subscription: "gog-gmail-watch-push",
      pushToken: "shared-push-token",
      hookUrl: "http://127.0.0.1:18789/hooks/gmail",
      includeBody: true,
      maxBytes: 20000,
      renewEveryMinutes: 720,
      serve: { bind: "127.0.0.1", port: 8788, path: "/" },
      tailscale: { mode: "funnel", path: "/gmail-pubsub" },
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

- Gateway auto-starts `gog gmail watch serve` on boot when configured. Set `OPENCLAW_SKIP_GMAIL_WATCHER=1` to disable.
- Don't run a separate `gog gmail watch serve` alongside the Gateway.

---

## Canvas host

```json5
{
  canvasHost: {
    root: "~/.openclaw/workspace/canvas",
    liveReload: true,
    // enabled: false, // or OPENCLAW_SKIP_CANVAS_HOST=1
  },
}
```

- Serves agent-editable HTML/CSS/JS and A2UI over HTTP under the Gateway port:
  - `http://<gateway-host>:<gateway.port>/__openclaw__/canvas/`
  - `http://<gateway-host>:<gateway.port>/__openclaw__/a2ui/`
- Local-only: keep `gateway.bind: "loopback"` (default).
- Non-loopback binds: canvas routes require Gateway auth (token/password/trusted-proxy), same as other Gateway HTTP surfaces.
- Node WebViews typically don't send auth headers; after a node is paired and connected, the Gateway advertises node-scoped capability URLs for canvas/A2UI access.
- Capability URLs are bound to the active node WS session and expire quickly. IP-based fallback is not used.
- Injects live-reload client into served HTML.
- Auto-creates starter `index.html` when empty.
- Also serves A2UI at `/__openclaw__/a2ui/`.
- Changes require a gateway restart.
- Disable live reload for large directories or `EMFILE` errors.

---

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
- `full`: include `cliPath` + `sshPort`.
- Hostname defaults to `openclaw`. Override with `OPENCLAW_MDNS_HOSTNAME`.

### Wide-area (DNS-SD)

```json5
{
  discovery: {
    wideArea: { enabled: true },
  },
}
```

Writes a unicast DNS-SD zone under `~/.openclaw/dns/`. For cross-network discovery, pair with a DNS server (CoreDNS recommended) + Tailscale split DNS.

Setup: `openclaw dns setup --apply`.

---

## Environment

### `env` (inline env vars)

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

- Inline env vars are only applied if the process env is missing the key.
- `.env` files: CWD `.env` + `~/.openclaw/.env` (neither overrides existing vars).
- `shellEnv`: imports missing expected keys from your login shell profile.
- See [Environment](/help/environment) for full precedence.

### Env var substitution

Reference env vars in any config string with `${VAR_NAME}`:

```json5
{
  gateway: {
    auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" },
  },
}
```

- Only uppercase names matched: `[A-Z_][A-Z0-9_]*`.
- Missing/empty vars throw an error at config load.
- Escape with `$${VAR}` for a literal `${VAR}`.
- Works with `$include`.

---

## Secrets

Secret refs are additive: plaintext values still work.

### `SecretRef`

Use one object shape:

```json5
{ source: "env" | "file" | "exec", provider: "default", id: "..." }
```

Validation:

- `provider` pattern: `^[a-z][a-z0-9_-]{0,63}$`
- `source: "env"` id pattern: `^[A-Z][A-Z0-9_]{0,127}$`
- `source: "file"` id: absolute JSON pointer (for example `"/providers/openai/apiKey"`)
- `source: "exec"` id pattern: `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`
- `source: "exec"` ids must not contain `.` or `..` slash-delimited path segments (for example `a/../b` is rejected)

### Supported credential surface

- Canonical matrix: [SecretRef Credential Surface](/reference/secretref-credential-surface)
- `secrets apply` targets supported `openclaw.json` credential paths.
- `auth-profiles.json` refs are included in runtime resolution and audit coverage.

### Secret providers config

```json5
{
  secrets: {
    providers: {
      default: { source: "env" }, // optional explicit env provider
      filemain: {
        source: "file",
        path: "~/.openclaw/secrets.json",
        mode: "json",
        timeoutMs: 5000,
      },
      vault: {
        source: "exec",
        command: "/usr/local/bin/openclaw-vault-resolver",
        passEnv: ["PATH", "VAULT_ADDR"],
      },
    },
    defaults: {
      env: "default",
      file: "filemain",
      exec: "vault",
    },
  },
}
```

Notes:

- `file` provider supports `mode: "json"` and `mode: "singleValue"` (`id` must be `"value"` in singleValue mode).
- File and exec provider paths fail closed when Windows ACL verification is unavailable. Set `allowInsecurePath: true` only for trusted paths that cannot be verified.
- `exec` provider requires an absolute `command` path and uses protocol payloads on stdin/stdout.
- By default, symlink command paths are rejected. Set `allowSymlinkCommand: true` to allow symlink paths while validating the resolved target path.
- If `trustedDirs` is configured, the trusted-dir check applies to the resolved target path.
- `exec` child environment is minimal by default; pass required variables explicitly with `passEnv`.
- Secret refs are resolved at activation time into an in-memory snapshot, then request paths read the snapshot only.
- Active-surface filtering applies during activation: unresolved refs on enabled surfaces fail startup/reload, while inactive surfaces are skipped with diagnostics.

---

## Auth storage

```json5
{
  auth: {
    profiles: {
      "anthropic:default": { provider: "anthropic", mode: "api_key" },
      "anthropic:work": { provider: "anthropic", mode: "api_key" },
      "openai-codex:personal": { provider: "openai-codex", mode: "oauth" },
    },
    order: {
      anthropic: ["anthropic:default", "anthropic:work"],
      "openai-codex": ["openai-codex:personal"],
    },
  },
}
```

- Per-agent profiles are stored at `<agentDir>/auth-profiles.json`.
- `auth-profiles.json` supports value-level refs (`keyRef` for `api_key`, `tokenRef` for `token`) for static credential modes.
- OAuth-mode profiles (`auth.profiles.<id>.mode = "oauth"`) do not support SecretRef-backed auth-profile credentials.
- Static runtime credentials come from in-memory resolved snapshots; legacy static `auth.json` entries are scrubbed when discovered.
- Legacy OAuth imports from `~/.openclaw/credentials/oauth.json`.
- See [OAuth](/concepts/oauth).
- Secrets runtime behavior and `audit/configure/apply` tooling: [Secrets Management](/gateway/secrets).

### `auth.cooldowns`

```json5
{
  auth: {
    cooldowns: {
      billingBackoffHours: 5,
      billingBackoffHoursByProvider: { anthropic: 3, openai: 8 },
      billingMaxHours: 24,
      authPermanentBackoffMinutes: 10,
      authPermanentMaxMinutes: 60,
      failureWindowHours: 24,
      overloadedProfileRotations: 1,
      overloadedBackoffMs: 0,
      rateLimitedProfileRotations: 1,
    },
  },
}
```

- `billingBackoffHours`: base backoff in hours when a profile fails due to true
  billing/insufficient-credit errors (default: `5`). Explicit billing text can
  still land here even on `401`/`403` responses, but provider-specific text
  matchers stay scoped to the provider that owns them (for example OpenRouter
  `Key limit exceeded`). Retryable HTTP `402` usage-window or
  organization/workspace spend-limit messages stay in the `rate_limit` path
  instead.
- `billingBackoffHoursByProvider`: optional per-provider overrides for billing backoff hours.
- `billingMaxHours`: cap in hours for billing backoff exponential growth (default: `24`).
- `authPermanentBackoffMinutes`: base backoff in minutes for high-confidence `auth_permanent` failures (default: `10`).
- `authPermanentMaxMinutes`: cap in minutes for `auth_permanent` backoff growth (default: `60`).
- `failureWindowHours`: rolling window in hours used for backoff counters (default: `24`).
- `overloadedProfileRotations`: maximum same-provider auth-profile rotations for overloaded errors before switching to model fallback (default: `1`). Provider-busy shapes such as `ModelNotReadyException` land here.
- `overloadedBackoffMs`: fixed delay before retrying an overloaded provider/profile rotation (default: `0`).
- `rateLimitedProfileRotations`: maximum same-provider auth-profile rotations for rate-limit errors before switching to model fallback (default: `1`). That rate-limit bucket includes provider-shaped text such as `Too many concurrent requests`, `ThrottlingException`, `concurrency limit reached`, `workers_ai ... quota limit exceeded`, and `resource exhausted`.

---

## Logging

```json5
{
  logging: {
    level: "info",
    file: "/tmp/openclaw/openclaw.log",
    consoleLevel: "info",
    consoleStyle: "pretty", // pretty | compact | json
    redactSensitive: "tools", // off | tools
    redactPatterns: ["\\bTOKEN\\b\\s*[=:]\\s*([\"']?)([^\\s\"']+)\\1"],
  },
}
```

- Default log file: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`.
- Set `logging.file` for a stable path.
- `consoleLevel` bumps to `debug` when `--verbose`.
- `maxFileBytes`: maximum log file size in bytes before writes are suppressed (positive integer; default: `524288000` = 500 MB). Use external log rotation for production deployments.

---

## Diagnostics

```json5
{
  diagnostics: {
    enabled: true,
    flags: ["telegram.*"],
    stuckSessionWarnMs: 30000,

    otel: {
      enabled: false,
      endpoint: "https://otel-collector.example.com:4318",
      protocol: "http/protobuf", // http/protobuf | grpc
      headers: { "x-tenant-id": "my-org" },
      serviceName: "openclaw-gateway",
      traces: true,
      metrics: true,
      logs: false,
      sampleRate: 1.0,
      flushIntervalMs: 5000,
    },

    cacheTrace: {
      enabled: false,
      filePath: "~/.openclaw/logs/cache-trace.jsonl",
      includeMessages: true,
      includePrompt: true,
      includeSystem: true,
    },
  },
}
```

- `enabled`: master toggle for instrumentation output (default: `true`).
- `flags`: array of flag strings enabling targeted log output (supports wildcards like `"telegram.*"` or `"*"`).
- `stuckSessionWarnMs`: age threshold in ms for emitting stuck-session warnings while a session remains in processing state.
- `otel.enabled`: enables the OpenTelemetry export pipeline (default: `false`).
- `otel.endpoint`: collector URL for OTel export.
- `otel.protocol`: `"http/protobuf"` (default) or `"grpc"`.
- `otel.headers`: extra HTTP/gRPC metadata headers sent with OTel export requests.
- `otel.serviceName`: service name for resource attributes.
- `otel.traces` / `otel.metrics` / `otel.logs`: enable trace, metrics, or log export.
- `otel.sampleRate`: trace sampling rate `0`–`1`.
- `otel.flushIntervalMs`: periodic telemetry flush interval in ms.
- `cacheTrace.enabled`: log cache trace snapshots for embedded runs (default: `false`).
- `cacheTrace.filePath`: output path for cache trace JSONL (default: `$OPENCLAW_STATE_DIR/logs/cache-trace.jsonl`).
- `cacheTrace.includeMessages` / `includePrompt` / `includeSystem`: control what is included in cache trace output (all default: `true`).

---

## Update

```json5
{
  update: {
    channel: "stable", // stable | beta | dev
    checkOnStart: true,

    auto: {
      enabled: false,
      stableDelayHours: 6,
      stableJitterHours: 12,
      betaCheckIntervalHours: 1,
    },
  },
}
```

- `channel`: release channel for npm/git installs — `"stable"`, `"beta"`, or `"dev"`.
- `checkOnStart`: check for npm updates when the gateway starts (default: `true`).
- `auto.enabled`: enable background auto-update for package installs (default: `false`).
- `auto.stableDelayHours`: minimum delay in hours before stable-channel auto-apply (default: `6`; max: `168`).
- `auto.stableJitterHours`: extra stable-channel rollout spread window in hours (default: `12`; max: `168`).
- `auto.betaCheckIntervalHours`: how often beta-channel checks run in hours (default: `1`; max: `24`).

---

## ACP

```json5
{
  acp: {
    enabled: false,
    dispatch: { enabled: true },
    backend: "acpx",
    defaultAgent: "main",
    allowedAgents: ["main", "ops"],
    maxConcurrentSessions: 10,

    stream: {
      coalesceIdleMs: 50,
      maxChunkChars: 1000,
      repeatSuppression: true,
      deliveryMode: "live", // live | final_only
      hiddenBoundarySeparator: "paragraph", // none | space | newline | paragraph
      maxOutputChars: 50000,
      maxSessionUpdateChars: 500,
    },

    runtime: {
      ttlMinutes: 30,
    },
  },
}
```

- `enabled`: global ACP feature gate (default: `false`).
- `dispatch.enabled`: independent gate for ACP session turn dispatch (default: `true`). Set `false` to keep ACP commands available while blocking execution.
- `backend`: default ACP runtime backend id (must match a registered ACP runtime plugin).
- `defaultAgent`: fallback ACP target agent id when spawns do not specify an explicit target.
- `allowedAgents`: allowlist of agent ids permitted for ACP runtime sessions; empty means no additional restriction.
- `maxConcurrentSessions`: maximum concurrently active ACP sessions.
- `stream.coalesceIdleMs`: idle flush window in ms for streamed text.
- `stream.maxChunkChars`: maximum chunk size before splitting streamed block projection.
- `stream.repeatSuppression`: suppress repeated status/tool lines per turn (default: `true`).
- `stream.deliveryMode`: `"live"` streams incrementally; `"final_only"` buffers until turn terminal events.
- `stream.hiddenBoundarySeparator`: separator before visible text after hidden tool events (default: `"paragraph"`).
- `stream.maxOutputChars`: maximum assistant output characters projected per ACP turn.
- `stream.maxSessionUpdateChars`: maximum characters for projected ACP status/update lines.
- `stream.tagVisibility`: record of tag names to boolean visibility overrides for streamed events.
- `runtime.ttlMinutes`: idle TTL in minutes for ACP session workers before eligible cleanup.
- `runtime.installCommand`: optional install command to run when bootstrapping an ACP runtime environment.

---

## CLI

```json5
{
  cli: {
    banner: {
      taglineMode: "off", // random | default | off
    },
  },
}
```

- `cli.banner.taglineMode` controls banner tagline style:
  - `"random"` (default): rotating funny/seasonal taglines.
  - `"default"`: fixed neutral tagline (`All your chats, one OpenClaw.`).
  - `"off"`: no tagline text (banner title/version still shown).
- To hide the entire banner (not just taglines), set env `OPENCLAW_HIDE_BANNER=1`.

---

## Wizard

Metadata written by CLI guided setup flows (`onboard`, `configure`, `doctor`):

```json5
{
  wizard: {
    lastRunAt: "2026-01-01T00:00:00.000Z",
    lastRunVersion: "2026.1.4",
    lastRunCommit: "abc1234",
    lastRunCommand: "configure",
    lastRunMode: "local",
  },
}
```

---

## Identity

See `agents.list` identity fields under [Agent defaults](/gateway/config-agents#agent-defaults).

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

## Cron

```json5
{
  cron: {
    enabled: true,
    maxConcurrentRuns: 2,
    webhook: "https://example.invalid/legacy", // deprecated fallback for stored notify:true jobs
    webhookToken: "replace-with-dedicated-token", // optional bearer token for outbound webhook auth
    sessionRetention: "24h", // duration string or false
    runLog: {
      maxBytes: "2mb", // default 2_000_000 bytes
      keepLines: 2000, // default 2000
    },
  },
}
```

- `sessionRetention`: how long to keep completed isolated cron run sessions before pruning from `sessions.json`. Also controls cleanup of archived deleted cron transcripts. Default: `24h`; set `false` to disable.
- `runLog.maxBytes`: max size per run log file (`cron/runs/<jobId>.jsonl`) before pruning. Default: `2_000_000` bytes.
- `runLog.keepLines`: newest lines retained when run-log pruning is triggered. Default: `2000`.
- `webhookToken`: bearer token used for cron webhook POST delivery (`delivery.mode = "webhook"`), if omitted no auth header is sent.
- `webhook`: deprecated legacy fallback webhook URL (http/https) used only for stored jobs that still have `notify: true`.

### `cron.retry`

```json5
{
  cron: {
    retry: {
      maxAttempts: 3,
      backoffMs: [30000, 60000, 300000],
      retryOn: ["rate_limit", "overloaded", "network", "timeout", "server_error"],
    },
  },
}
```

- `maxAttempts`: maximum retries for one-shot jobs on transient errors (default: `3`; range: `0`–`10`).
- `backoffMs`: array of backoff delays in ms for each retry attempt (default: `[30000, 60000, 300000]`; 1–10 entries).
- `retryOn`: error types that trigger retries — `"rate_limit"`, `"overloaded"`, `"network"`, `"timeout"`, `"server_error"`. Omit to retry all transient types.

Applies only to one-shot cron jobs. Recurring jobs use separate failure handling.

### `cron.failureAlert`

```json5
{
  cron: {
    failureAlert: {
      enabled: false,
      after: 3,
      cooldownMs: 3600000,
      mode: "announce",
      accountId: "main",
    },
  },
}
```

- `enabled`: enable failure alerts for cron jobs (default: `false`).
- `after`: consecutive failures before an alert fires (positive integer, min: `1`).
- `cooldownMs`: minimum milliseconds between repeated alerts for the same job (non-negative integer).
- `mode`: delivery mode — `"announce"` sends via a channel message; `"webhook"` posts to the configured webhook.
- `accountId`: optional account or channel id to scope alert delivery.

### `cron.failureDestination`

```json5
{
  cron: {
    failureDestination: {
      mode: "announce",
      channel: "last",
      to: "channel:C1234567890",
      accountId: "main",
    },
  },
}
```

- Default destination for cron failure notifications across all jobs.
- `mode`: `"announce"` or `"webhook"`; defaults to `"announce"` when enough target data exists.
- `channel`: channel override for announce delivery. `"last"` reuses the last known delivery channel.
- `to`: explicit announce target or webhook URL. Required for webhook mode.
- `accountId`: optional account override for delivery.
- Per-job `delivery.failureDestination` overrides this global default.
- When neither global nor per-job failure destination is set, jobs that already deliver via `announce` fall back to that primary announce target on failure.
- `delivery.failureDestination` is only supported for `sessionTarget="isolated"` jobs unless the job's primary `delivery.mode` is `"webhook"`.

See [Cron Jobs](/automation/cron-jobs). Isolated cron executions are tracked as [background tasks](/automation/tasks).

---

## Media model template variables

Template placeholders expanded in `tools.media.models[].args`:

| Variable           | Description                                       |
| ------------------ | ------------------------------------------------- |
| `{{Body}}`         | Full inbound message body                         |
| `{{RawBody}}`      | Raw body (no history/sender wrappers)             |
| `{{BodyStripped}}` | Body with group mentions stripped                 |
| `{{From}}`         | Sender identifier                                 |
| `{{To}}`           | Destination identifier                            |
| `{{MessageSid}}`   | Channel message id                                |
| `{{SessionId}}`    | Current session UUID                              |
| `{{IsNewSession}}` | `"true"` when new session created                 |
| `{{MediaUrl}}`     | Inbound media pseudo-URL                          |
| `{{MediaPath}}`    | Local media path                                  |
| `{{MediaType}}`    | Media type (image/audio/document/…)               |
| `{{Transcript}}`   | Audio transcript                                  |
| `{{Prompt}}`       | Resolved media prompt for CLI entries             |
| `{{MaxChars}}`     | Resolved max output chars for CLI entries         |
| `{{ChatType}}`     | `"direct"` or `"group"`                           |
| `{{GroupSubject}}` | Group subject (best effort)                       |
| `{{GroupMembers}}` | Group members preview (best effort)               |
| `{{SenderName}}`   | Sender display name (best effort)                 |
| `{{SenderE164}}`   | Sender phone number (best effort)                 |
| `{{Provider}}`     | Provider hint (whatsapp, telegram, discord, etc.) |

---

## Config includes (`$include`)

Split config into multiple files:

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789 },
  agents: { $include: "./agents.json5" },
  broadcast: {
    $include: ["./clients/mueller.json5", "./clients/schmidt.json5"],
  },
}
```

**Merge behavior:**

- Single file: replaces the containing object.
- Array of files: deep-merged in order (later overrides earlier).
- Sibling keys: merged after includes (override included values).
- Nested includes: up to 10 levels deep.
- Paths: resolved relative to the including file, but must stay inside the top-level config directory (`dirname` of `openclaw.json`). Absolute/`../` forms are allowed only when they still resolve inside that boundary.
- OpenClaw-owned writes that change only one top-level section backed by a single-file include write through to that included file. For example, `plugins install` updates `plugins: { $include: "./plugins.json5" }` in `plugins.json5` and leaves `openclaw.json` intact.
- Root includes, include arrays, and includes with sibling overrides are read-only for OpenClaw-owned writes; those writes fail closed instead of flattening the config.
- Errors: clear messages for missing files, parse errors, and circular includes.

---

_Related: [Configuration](/gateway/configuration) · [Configuration Examples](/gateway/configuration-examples) · [Doctor](/gateway/doctor)_

## Related

- [Configuration](/gateway/configuration)
- [Configuration examples](/gateway/configuration-examples)
