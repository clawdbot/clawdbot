---
summary: "Gateway config: bind, auth, roles, Control UI, terminal, remote, nodes, TLS, and reload"
read_when:
  - Binding or authenticating the gateway
  - Assigning gateway roles or node pairing
  - Configuring gateway TLS or reload behavior
title: "Configuration — gateway"
---

Gateway runtime keys under `gateway.*`.

For the full key index and the other top-level config domains, see [Configuration reference](/gateway/configuration-reference).

## Gateway

```json5
{
  gateway: {
    mode: "local", // local | remote
    port: 18789,
    bind: "loopback",
    publicOrigin: "https://gateway.example.com",
    auth: {
      mode: "token", // none | token | password | trusted-proxy
      token: "your-token",
      // password: "your-password", // or OPENCLAW_GATEWAY_PASSWORD
      // trustedProxy: { userHeader: "x-forwarded-user" }, // for mode=trusted-proxy; see /gateway/trusted-proxy-auth
      allowTailscale: true,
      identityScopes: {
        "admin@example.com": ["operator.admin"],
      },
      rateLimit: {
        maxAttempts: 10,
        windowMs: 60000,
        lockoutMs: 300000,
        exemptLoopback: true,
      },
    },
    // Optional person-level access policy for team Gateway deployments.
    roles: {
      default: "guest",
      definitions: {
        maintainer: {
          sessions: { others: "write" }, // none | view | suggest | write
          agents: ["roboclaw"],
          scopes: ["operator.read", "operator.write", "operator.approvals"],
        },
        guest: {
          sessions: { others: "view" },
          agents: ["roboclaw"],
          scopes: ["operator.read", "operator.write"],
          sandbox: "required", // inherit (default) | required
        },
      },
    },
    tailscale: {
      mode: "off", // off | serve | funnel
    },
    controlUi: {
      enabled: true,
      basePath: "/openclaw",
      // experimental: { customPlugins: false }, // Labs: native UI from user-installed plugins
      // environment: { label: "edge", color: "amber" },
      // communityInvite: true, // show the sidebar Discord invitation unless dismissed
      // root: "dist/control-ui",
      // github: { token: { source: "store", provider: "default", id: "CONTROL_UI_GITHUB" } },
      // embedSandbox: "scripts", // strict | scripts | trusted
      // allowExternalEmbedUrls: false, // dangerous: allow absolute external http(s) embed URLs
      // automaticallyFetchFavicons: true, // SSRF-guarded link favicon fetches
      // allowedOrigins: ["https://control.example.com"], // required for non-loopback Control UI
      // dangerouslyAllowHostHeaderOriginFallback: false, // dangerous Host-header origin fallback mode
    },
    cliAgents: {
      enabled: true, // show create-capable CLI session targets in the model picker
    },
    terminal: {
      enabled: false,
      // shell: "/bin/zsh",
    },
    remote: {
      url: "ws://127.0.0.1:18789",
      transport: "ssh", // ssh | direct
      token: "your-token",
      // password: "your-password",
    },
    trustedProxies: ["10.0.0.1"],
    // Optional. Default false.
    allowRealIpFallback: false,
    nodes: {
      pairing: {
        // Silent same-host pairing and access upgrades. Default: enabled.
        // Set false to require explicit approval for every device.
        autoApproveLocal: true,
        // Optional. Default unset/disabled.
        autoApproveCidrs: ["192.168.1.0/24", "fd00:1234:5678::/64"],
        // SSH-verified auto-approval. Default: enabled (true).
        // Set false to disable SSH verification only; this does not affect
        // autoApproveCidrs above. For manual-only node pairing, set false AND
        // unset autoApproveCidrs. Pass an object to tune: { user, identity,
        // timeoutMs, cidrs }.
        sshVerify: true,
      },
      commands: {
        allow: ["canvas.navigate"],
        deny: ["system.run"],
      },
    },
    tools: {
      // Additional /tools/invoke HTTP denies
      deny: ["browser"],
      // Remove tools from the default HTTP deny list for owner/admin callers
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
- `publicOrigin`: optional externally reachable HTTPS origin of the Gateway,
  without a path, query, or credentials. HTTP is accepted only for literal
  loopback hosts (`localhost`, `127.0.0.1`, or `[::1]`) during local development.
  Per-requester MCP OAuth requires this value and uses
  `<publicOrigin>/oauth/mcp/callback` as its callback URL.
  Slack session-card actions, plugin-generated viewer links, and chat deep links
  into the Control UI also use this origin. Set `gateway.controlUi.basePath`
  separately when the Control UI is served below a reverse-proxy path prefix.
- `bind`: `auto`, `loopback` (default), `lan` (`0.0.0.0`), `tailnet` (Tailscale IPv4 when available, otherwise loopback), or `custom` (one IPv4 address). A resolved `tailnet` address and any `custom` address other than `127.0.0.1` or `0.0.0.0` require `127.0.0.1` on the same port for same-host clients; startup fails if either listener cannot bind. Non-loopback exposure remains limited to the selected interface.
- **Legacy bind aliases**: use bind mode values in `gateway.bind` (`auto`, `loopback`, `lan`, `tailnet`, `custom`), not host aliases (`0.0.0.0`, `127.0.0.1`, `localhost`, `::`, `::1`).
- **Docker note**: the default `loopback` bind listens on `127.0.0.1` inside the container. With Docker bridge networking (`-p 18789:18789`), traffic arrives on `eth0`, so the gateway is unreachable. Use `--network host`, or set `bind: "lan"` (or `bind: "custom"` with `customBindHost: "0.0.0.0"`) to listen on all interfaces.
- **Auth**: required by default. Non-loopback binds require gateway auth. In practice that means a shared token/password or an identity-aware reverse proxy with `gateway.auth.mode: "trusted-proxy"`. Onboarding wizard generates a token by default.
- If both `gateway.auth.token` and `gateway.auth.password` are configured (including SecretRefs), set `gateway.auth.mode` explicitly to `token` or `password`. Startup and service install/repair flows fail when both are configured and mode is unset.
- `gateway.auth.mode: "none"`: explicit no-auth mode. Use only for trusted local loopback setups; this is intentionally not offered by onboarding prompts.
- `gateway.auth.mode: "trusted-proxy"`: delegate browser/user auth to an identity-aware reverse proxy and trust identity headers from `gateway.trustedProxies` (see [Trusted Proxy Auth](/gateway/trusted-proxy-auth)). This mode expects a **non-loopback** proxy source by default; same-host loopback reverse proxies require explicit `gateway.auth.trustedProxy.allowLoopback = true`. Internal same-host callers can use `gateway.auth.password` as a local direct fallback; `gateway.auth.token` remains mutually exclusive with trusted-proxy mode.
- `gateway.auth.allowTailscale`: when `true`, Tailscale Serve identity headers can satisfy Control UI/WebSocket auth (verified via `tailscale whois`). HTTP API endpoints do **not** use that Tailscale header auth; they follow the gateway's normal HTTP auth mode instead. This tokenless flow assumes the gateway host is trusted. Defaults to `true` when `tailscale.mode = "serve"`.
- `gateway.auth.identityScopes`: maps a verified trusted-proxy user or Tailscale WhoIs login to connection-only operator scopes. Email keys match case-insensitively; other identities match exactly. For trusted-proxy Control UI connections, `x-openclaw-scopes` caps device enrollment or upgrade requests and the final device-plus-identity session scopes. Grants do not create or modify pairing records. Token, password, and no-auth connections have no verified identity and receive no grant.
- `gateway.roles`: optional named operator roles for authenticated user profiles on team Gateways. Every definition specifies `sessions.others` (`none`, `view`, `suggest`, or `write`), allowed session-creation and agent-run `agents` (`"*"` or an array of agent IDs), and a closed `scopes` ceiling that also applies to identity-authenticated HTTP requests and signed Control UI plugin grants. Optional `sandbox` is `"inherit"` by default or `"required"` to sandbox sessions created under that role even when the agent's sandbox mode is `"off"`. This requirement is recorded once from the authenticated creator, cannot be changed through role updates or session mutation, and does not affect existing sessions. A sandbox-required person cannot start a host-execution session, including through an invitation; unavailable sandbox backends fail closed, and elevated or host-target overrides cannot escape. The administrator-scoped `users.setRole` Gateway method assigns or clears a profile's role and immediately disconnects its active clients so they reconnect with current authority. Identity-authenticated operator sessions do not receive reusable, person-unbound device/bootstrap tokens while roles are configured, and identity-less device-token or bootstrap-token operator authentication is rejected; reconnect through trusted-proxy or other supported verified identity instead. `default` is required, must name a configured definition, and applies to unassigned profiles. `sessions.others: "none"` also denies Gateway-wide `usage.cost`; audit diagnostics and other `operator.write` control-plane capabilities remain shared-domain surfaces, not hostile-tenant isolation. Omitting `roles` leaves existing solo and shared-secret deployments unchanged. See [Operator scopes](/gateway/operator-scopes#named-operator-roles).
- `gateway.auth.rateLimit`: optional failed-auth limiter. Applies per client IP and per auth scope (shared-secret and device-token are tracked independently). Blocked attempts return `429` + `Retry-After`. Changes hot-apply to the existing limiters: recorded failures, earned lockout deadlines, and pending loopback delays survive. New limits and exemptions apply to subsequent attempts; deleting the section restores defaults.
  - On the async Tailscale Serve Control UI path, failed attempts for the same `{scope, clientIp}` are serialized before the failure write. Concurrent bad attempts from the same client can therefore trip the limiter on the second request instead of both racing through as plain mismatches.
  - `gateway.auth.rateLimit.exemptLoopback` defaults to `true`; set `false` when you intentionally want localhost traffic rate-limited too (for test setups or strict proxy deployments).
- Browser-origin WS auth attempts are always throttled with loopback exemption disabled (defense-in-depth against browser-based localhost brute force).
- On loopback, those browser-origin lockouts are isolated per normalized `Origin`
  value, so repeated failures from one localhost origin do not automatically
  lock out a different origin.
- `tailscale.mode`: `serve` (tailnet only, loopback bind) or `funnel` (public, requires auth).
  OpenClaw holds the route as a foreground claim, so startup fails unless the
  route is active and the route is released when the Gateway stops. Named
  Tailscale Services are unsupported because the Tailscale CLI permits them
  only as persistent background routes.
- `tailscale.preserveFunnel`: deprecated migration guard. When `true` and
  `tailscale.mode = "serve"`, OpenClaw checks `tailscale funnel status` before
  re-applying Serve at startup. If that status cannot be inspected, startup
  fails before the ordinary Gateway listener opens. An external Funnel that
  still targets the ordinary Gateway port does not receive managed-ingress
  provenance. OpenClaw leaves the external route unchanged and warns. The
  route can use generic proxy attribution only through an explicitly configured
  `gateway.trustedProxies` source with a valid forwarded client address;
  Gateway-protected routes then require configured auth, while aggregate probes
  and plugin-authenticated webhooks retain their own response and authentication
  policies. First configure `gateway.auth.password` (prefer a SecretRef) or
  `OPENCLAW_GATEWAY_PASSWORD`, and set `gateway.auth.mode` to `password`. Then
  run `openclaw config set gateway.tailscale.mode funnel`, followed by
  `openclaw config unset gateway.tailscale.preserveFunnel`. Default `false`.
- `controlUi.experimental.customPlugins`: allow native browser UI from user-installed plugins, including local development plugins. Default: `false`. Enable through **Settings → Labs → Custom plugin UI** or set this boolean to `true`. Native UI runs with the signed-in operator's Gateway authority, so enable it only for trusted plugins. Native UI from enabled bundled plugins remains available with the setting off; backend plugin APIs, ordinary plugin loading, sandboxed dashboard widgets, and MCP Apps are unaffected. Restart the Gateway and reload connected browser tabs after changing it. See [Feature plugins](/plugins/feature-plugins#enable-custom-plugin-ui).
- `controlUi.allowedOrigins`: explicit browser-origin allowlist for Gateway WebSocket connects. Required for public non-loopback browser origins. Private same-origin LAN/Tailnet UI loads from loopback, RFC1918/link-local, `.local`, `.ts.net`, or Tailscale CGNAT hosts are accepted without enabling Host-header fallback.
- `controlUi.environment`: optional visual identity for distinguishing Gateway environments. Set `{ label: "edge", color: "amber" }` to show a matching top stripe, agent-avatar ring, environment pills, browser-title suffix, and tinted favicon. `label` is trimmed and must contain 1–24 characters. `color` must be `teal`, `amber`, `purple`, `coral`, `pink`, `blue`, `green`, `red`, or `gray`. The label and color are visible before sign-in; omit the setting to keep the default appearance unchanged.
- `controlUi.communityInvite`: show the Discord community invitation in the sidebar. Default: `true`. Set `false` on the Gateway serving the UI to hide it for every browser using that deployment, including browsers connected to a different remote Gateway. The setting hot-reloads; existing pages pick it up after browser refresh or reconnect. Re-enabling preserves browser-local dismissals.
- `controlUi.github.token`: optional SecretRef-backed service credential for GitHub-backed profile verification, Control UI project discovery, and GitHub hover previews without a managed agent identity. Profile verification uses the service credential only for public account metadata; the sign-in provider owns the person's identity. Metadata caching and quota cooldowns are automatic; see [Gateway profile and GitHub credit](/concepts/user-model#gateway-profile-and-github-credit). Hover previews prefer the selected agent's effective `tools.github` identity, including an inherited system identity, and remain restricted to public repositories. Prefer this explicit setting when the Gateway should own service access independently of its shared process environment. When omitted, service access retains the shipped `GH_TOKEN` then `GITHUB_TOKEN` process-environment fallback. An explicitly configured but unavailable credential fails closed instead of using an unrelated credential. Its exact environment or store name is excluded from agent execution; a custom name does not clear unrelated native `GH_TOKEN` or `GITHUB_TOKEN` values. This credential is separate from `tools.github` agent identities and does not create an OS-user security boundary.
- Tool activity descriptions appear automatically when supplied by the acting agent; viewing tool calls does not request utility-model completions. The former `controlUi.toolTitles` setting is retired. Run `openclaw doctor --fix` to remove it from existing configs.
- `controlUi.automaticallyFetchFavicons`: link favicons in Control UI chat. Default: `true`. The authenticated browser asks its same-origin Gateway for each hostname. The Gateway requests only `https://<hostname>/favicon.ico`, rejects IP literals and private/internal destinations, pins public DNS results, revalidates every redirect under the same strict SSRF policy, limits redirects/time/bytes/concurrency, validates the image, and returns a private-cacheable image blob. OpenClaw does not use Google or another favicon service for this flow. This discloses linked hostnames and the Gateway's network address to those destination sites. Set `false` to prevent the browser from requesting favicon routes and the Gateway from contacting link destinations.
- `controlUi.dangerouslyAllowHostHeaderOriginFallback`: dangerous mode that enables Host-header origin fallback for deployments that intentionally rely on Host-header origin policy.
- `cliAgents.enabled`: show the experimental **CLI agents** group in the Control UI new-session model picker. Default: `true`; set `false` to disable CLI agents and native CLI session creation. The group appears only when the Gateway advertises `sessions.catalog.list`, and it includes only catalog providers that support creating sessions. Selecting one opens the same catalog-target new-session flow used by the sidebar catalog action.

  Catalog providers can also advertise terminal-based session creation. The method is available only when Labs `cliAgents.enabled` is on, the Gateway terminal is available, and the selected provider exposes the capability. Callers supply `cwd`; create a fresh worktree first with `worktrees.create` when needed, because terminal start does not provision one.

- `terminal.enabled`: the admin-scoped operator terminal. Default: `true`; set `false` to opt out. The terminal starts a host PTY in the selected agent workspace, inherits the Gateway process environment, and is refused for agents with `sandbox.mode: "all"`. Changes hot-apply: disabling closes attached, detached, and conversation-owned sessions and cancels pending opens; re-enabling allows fresh sessions. Reload open Control UI pages to pick up the updated content security policy.
- `terminal.shell`: optional shell executable. When unset, OpenClaw uses `$SHELL` on Unix and `%ComSpec%` on Windows. Changes hot-apply to newly opened terminals; existing terminals keep running their original shell.
- `terminal.detachedSessionTimeoutSeconds`: how long a terminal session survives after its connection drops (page reload, laptop sleep), staying reattachable via `terminal.attach` with its recent output replayed. Default: `300`. Set `0` to kill sessions the moment their connection drops. Changes hot-apply to existing detached sessions using their original disconnect time; expired sessions close immediately, while attached terminals keep running. Detached sessions keep running their commands, so shorten this on shared or exposed hosts.
- `remote.transport`: `ssh` (default) or `direct` (ws/wss). For `direct`, `remote.url` must be `wss://` for public hosts; plaintext `ws://` is accepted only for loopback, LAN, link-local, `.local`, `.ts.net`, and Tailscale CGNAT hosts.
- `remote.remotePort`: gateway port on the remote SSH host. Defaults to `18789`; use this when the local tunnel port differs from the remote gateway port.
- `remote.tlsFingerprint`: expected SHA-256 certificate fingerprint for a remote `wss://` Gateway. The macOS app applies it to both operator/control and companion-node connections. Without an explicit value, macOS records a first-use pin only after normal system trust succeeds.
- `remote.sshHostKeyPolicy`: macOS SSH tunnel host-key policy. `strict` is the default and requires an already trusted key. `openssh` is an explicit opt-in to the effective OpenSSH configuration for managed aliases; review matching user and system SSH settings before using it. The macOS app and `configure-remote` reset this policy to `strict` when changing targets unless explicitly opted in again.
- `gateway.remote.token` / `.password` are remote-client credential fields. They do not configure gateway auth by themselves.
- `gateway.push.apns.relay.baseUrl`: base HTTPS URL for the external APNs relay used after relay-backed iOS builds publish registrations to the gateway. Public App Store builds use the hosted OpenClaw relay. Custom relay URLs must match a deliberately separate iOS build/deployment path whose relay URL points at that relay.
- `gateway.push.apns.relay.timeoutMs`: gateway-to-relay send timeout in milliseconds. Defaults to `10000`.
- Relay-backed registrations are delegated to a specific gateway identity. The paired iOS app fetches `gateway.identity.get`, includes that identity in the relay registration, and forwards a registration-scoped send grant to the gateway. Another gateway cannot reuse that stored registration.
- `OPENCLAW_APNS_RELAY_BASE_URL` / `OPENCLAW_APNS_RELAY_TIMEOUT_MS`: temporary env overrides for the relay config above.
- `OPENCLAW_APNS_RELAY_ALLOW_HTTP=true`: development-only escape hatch for loopback HTTP relay URLs. Production relay URLs should stay on HTTPS.
- `OPENCLAW_HANDSHAKE_TIMEOUT_MS`: optional environment override for the built-in pre-auth Gateway WebSocket handshake timeout.
- `channels.<provider>.healthMonitor.enabled`: per-channel opt-out for health-monitor restarts while keeping the global monitor enabled.
- `channels.<provider>.accounts.<accountId>.healthMonitor.enabled`: per-account override for multi-account channels. When set, it takes precedence over the channel-level override.
- Local gateway call paths can use `gateway.remote.*` as fallback only when `gateway.auth.*` is unset.
- If `gateway.auth.token` / `gateway.auth.password` is explicitly configured via SecretRef and unresolved, resolution fails closed (no remote fallback masking).
- `trustedProxies`: reverse proxy IPs that terminate TLS or inject forwarded-client headers. Only list proxies you control. Loopback entries are still valid for same-host proxy/local-detection setups (for example Tailscale Serve or a local reverse proxy), but they do **not** make loopback requests eligible for `gateway.auth.mode: "trusted-proxy"`.
- `allowRealIpFallback`: when `true`, the gateway accepts `X-Real-IP` if `X-Forwarded-For` is missing. Default `false` for fail-closed behavior.
- `gateway.nodes.pairing.autoApproveLocal`: silently approves pairing, role upgrades, and scope upgrades from trusted local connections (default: `true`). Scope upgrades additionally require the connection itself to prove local-grade credentials (auth mode `none`, or the shared token/password); Tailscale, trusted-proxy, and device-token connects keep their paired scopes as a durable cap. Set `false` to require explicit approval for every device; metadata-only reconnect refreshes remain automatic.
- `gateway.nodes.pairing.autoApproveCidrs`: optional CIDR/IP allowlist for auto-approving first-time node device pairing with no requested scopes. It is disabled when unset. This does not auto-approve operator/browser/Control UI/WebChat pairing, and it does not auto-approve role, scope, metadata, or public-key upgrades.
- `gateway.nodes.pairing.sshVerify`: SSH-verified auto-approval for first-time node device pairing (default: enabled). The gateway SSHes back to the pairing host (BatchMode, strict host keys) and approves only on an exact `openclaw node identity` device-key match. Same eligibility floor as `autoApproveCidrs`; probes are limited to private/CGNAT source addresses unless `cidrs` overrides them. Set `false` to disable, or `{ user, identity, timeoutMs, cidrs }` to tune. See [Node pairing](/gateway/pairing#ssh-verified-device-auto-approval-default).
- `gateway.nodes.commands.allow` / `gateway.nodes.commands.deny`: global allow/deny shaping for declared node commands after pairing and platform allowlist evaluation. `commands.allow` is the persistent enable for classified commands such as `camera.snap`, `camera.clip`, `codex.exec-server.stdio.v1`, `desktop.stream`, `screen.record`, `health.summary`, `sms.search`, and `sms.send`; `commands.deny` removes a command even if a platform default or explicit allow would otherwise include it. Codex remote execution on a paired device or enrolled cloud node additionally requires a separate critical allow-once approval for every exec-server attempt; persistent allowlisting never grants that approval. Computer and mobile UI control instead rely on default-off node-local enablement plus pairing. iOS Health permission, Android SMS permission, and Gateway command authorization are independent. Gateway command-policy changes hot-apply to connected nodes under the default reload mode, without granting additional pairing approval. When a node changes its declared command list, reconnect it and approve the new command request so the Gateway stores the widened surface.
- `gateway.tools.deny`: extra tool names blocked for HTTP `POST /tools/invoke` (extends default deny list).
- `gateway.tools.allow`: remove tool names from the default HTTP deny list for
  owner/admin callers. This does not upgrade identity-bearing `operator.write`
  callers into owner/admin access; `cron`, `gateway`, and `nodes` remain
  unavailable to non-owner callers even when allowlisted.

</Accordion>

### OpenAI-compatible endpoints

- Admin HTTP RPC: off by default as the `admin-http-rpc` plugin. Enable the plugin to register `POST /api/v1/admin/rpc`. See [Admin HTTP RPC](/plugins/admin-http-rpc).
- Chat Completions: disabled by default. Enable with `gateway.http.endpoints.chatCompletions.enabled: true`.
- Responses API: `gateway.http.endpoints.responses.enabled`.
- Responses URL-input hardening:
  - `gateway.http.endpoints.responses.maxUrlParts`
  - `gateway.http.endpoints.responses.files.urlAllowlist`
  - `gateway.http.endpoints.responses.images.urlAllowlist`
    Empty allowlists are treated as unset; use `gateway.http.endpoints.responses.files.allowUrl=false`
    and/or `gateway.http.endpoints.responses.images.allowUrl=false` to disable URL fetching.
- Optional response hardening header:
  - `gateway.http.securityHeaders.strictTransportSecurity` hot-applies to subsequent responses, including health probes. Set only for HTTPS origins you control; use `false` or remove the value to stop sending the header. See [Trusted Proxy Auth](/gateway/trusted-proxy-auth#tls-termination-and-hsts).

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
- `autoGenerate`: defaults to `true`. Gateway startup generates a local self-signed cert/key pair only when both files are missing, including at configured paths; for local/dev use only. An existing partial pair is left untouched and startup fails. Generated files are published without overwriting existing paths and their parent directories are synchronized when the filesystem supports it; unsupported directory flushing emits a structured degraded-durability warning.
- `certPath`: filesystem path to the TLS certificate file.
- `keyPath`: filesystem path to the TLS private key file; keep permission-restricted.
- `caPath`: optional CA bundle path for client verification or custom trust chains.

Client commands such as `triage`, `gateway status`, and `gateway probe` only read the public certificate to determine a local TLS pin. They never generate or repair TLS files and do not need the server private key or CA bundle. Without `certPath`, they inspect `gateway/tls/gateway-cert.pem` under the state directory. A missing or unreadable certificate supplies no implicit pin; normal connection trust checks still apply. Start the Gateway to generate a missing pair, or provide the configured certificate files before connecting.

### `gateway.reload`

```json5
{
  gateway: {
    reload: {
      mode: "hybrid", // off | hybrid
    },
  },
}
```

- `mode`: controls how config edits are applied at runtime.
  - `"off"`: ignore live edits; changes require an explicit restart.
  - `"hybrid"` (default): apply hot-safe changes in-process, then restart when a change requires it.

The earlier `"restart"` and `"hot"` values are retired; [`openclaw doctor --fix`](/cli/doctor) maps both to `"hybrid"`.

Reload debounce and in-flight operation deferral are no longer configurable and run behind built-in defaults. [`openclaw doctor --fix`](/cli/doctor) removes the retired `debounceMs` and `deferralTimeoutMs` keys from older config files.

---
