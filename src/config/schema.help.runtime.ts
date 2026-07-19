// Defines user-facing config field help text for docs and UI surfaces.
import { MEDIA_AUDIO_FIELD_HELP } from "./media-audio-field-metadata.js";
import { NODE_CAPABILITY_FIELD_HELP } from "./schema.node-capabilities.js";

export const RUNTIME_FIELD_HELP: Record<string, string> = {
  browser:
    "Browser runtime controls for local or remote CDP attachment, profile routing, and screenshot/snapshot behavior. Keep defaults unless your automation workflow requires custom browser transport settings.",
  "browser.enabled":
    "Enables browser capability wiring in the gateway so browser tools and CDP-driven workflows can run. Disable when browser automation is not needed to reduce surface area and startup work.",
  "browser.allowSystemProfileImport":
    "Allows macOS hosts to import cookies from a local Chrome-family system profile into a managed OpenClaw browser profile. Disable this to prevent browser profile cookie import and its macOS Keychain consent prompt.",
  "browser.cdpUrl":
    "CDP/DevTools endpoint URL used to attach to an externally managed browser instance. Use this for centralized browser hosts, tunnels, or existing-session attachment, and keep URL access restricted to trusted network paths.",
  "browser.actionTimeoutMs":
    "Default timeout in milliseconds for browser act requests before the client gives up waiting. Raise this when healthy waits or UI interactions exceed the default request budget.",
  "browser.localLaunchTimeoutMs":
    "Timeout in milliseconds for locally launched managed Chrome to expose its CDP HTTP endpoint after process start. Raise this on slow single-board computers or older hosts.",
  "browser.localCdpReadyTimeoutMs":
    "Timeout in milliseconds for a locally launched managed browser to finish CDP websocket readiness after the process is discovered. Raise this when Chrome starts but browser start still reports CDP not reachable.",
  "browser.color":
    "Default accent color used for browser profile/UI cues where colored identity hints are displayed. Use consistent colors to help operators identify active browser profile context quickly.",
  "browser.executablePath":
    "Explicit browser executable path when auto-discovery is insufficient for your host environment. Use an absolute stable path, or a path starting with ~ for your OS home directory, so launch behavior stays deterministic across restarts.",
  "browser.headless":
    "Forces browser launch in headless mode when the local launcher starts browser instances. Keep headless enabled for server environments and disable only when visible UI debugging is required.",
  "browser.noSandbox":
    "Disables Chromium sandbox isolation flags for environments where sandboxing fails at runtime. Keep this off whenever possible because process isolation protections are reduced.",
  "browser.attachOnly":
    "Restricts browser mode to attach-only behavior without starting local browser processes. Use this when all browser sessions are externally managed by a remote CDP provider.",
  "browser.cdpPortRangeStart":
    "Starting local CDP port used for auto-allocated browser profile ports. Increase this when host-level port defaults conflict with other local services.",
  "browser.defaultProfile":
    "Default browser profile name selected when callers do not explicitly choose a profile. Use a stable low-privilege profile as the default to reduce accidental cross-context state use.",
  "browser.profiles":
    "Named browser profile connection map used for explicit routing to CDP ports or URLs with optional metadata. Keep profile names consistent and avoid overlapping endpoint definitions.",
  "browser.profiles.*.cdpPort":
    "Per-profile local CDP port used when connecting to browser instances by port instead of URL. Use unique ports per profile to avoid connection collisions.",
  "browser.profiles.*.cdpUrl":
    "Per-profile CDP/DevTools endpoint URL used for explicit browser routing by profile name. Use this for remote CDP hosts, tunnels, or existing-session profiles that should attach through a running Chrome DevTools endpoint.",
  "browser.profiles.*.userDataDir":
    "Per-profile Chromium user data directory for existing-session attachment through Chrome DevTools MCP. Use this for Brave, Edge, Chromium, or non-default Chrome profiles when the built-in auto-connect path would pick the wrong browser data directory on the selected host or browser node. Paths starting with ~ expand to the OS home directory.",
  "browser.profiles.*.mcpCommand":
    "Per-profile Chrome DevTools MCP command for existing-session attachment. Defaults to npx.",
  "browser.profiles.*.mcpArgs":
    "Extra per-profile Chrome DevTools MCP arguments for existing-session attachment, such as --no-usage-statistics. Endpoint arguments here override the built-in auto-connect or browser URL selection.",
  "browser.profiles.*.driver":
    'Per-profile browser driver mode. Use "openclaw" (or legacy "clawd") for CDP-based profiles, or use "existing-session" for Chrome DevTools MCP attachment on the selected host or browser node.',
  "browser.profiles.*.executablePath":
    "Per-profile browser executable path for locally launched managed browser profiles. Overrides browser.executablePath and accepts paths starting with ~ for the OS home directory.",
  "browser.profiles.*.headless":
    "Per-profile headless override for locally launched browser instances. Use this when one profile should stay headless without forcing browser.headless for every other profile.",
  "browser.profiles.*.attachOnly":
    "Per-profile attach-only override that skips local browser launch and only attaches to an existing CDP endpoint. Useful when one profile is externally managed but others are locally launched.",
  "browser.profiles.*.color":
    "Per-profile accent color for visual differentiation in dashboards and browser-related UI hints. Use distinct colors for high-signal operator recognition of active profiles.",
  "browser.evaluateEnabled":
    "Enables browser-side evaluate helpers for runtime script evaluation capabilities where supported. Keep disabled unless your workflows require evaluate semantics beyond snapshots/navigation.",
  "browser.snapshotDefaults":
    "Default snapshot capture configuration used when callers do not provide explicit snapshot options. Tune this for consistent capture behavior across channels and automation paths.",
  "browser.snapshotDefaults.mode":
    "Default snapshot extraction mode controlling how page content is transformed for agent consumption. Choose the mode that balances readability, fidelity, and token footprint for your workflows.",
  "browser.tabCleanup":
    "Best-effort cleanup policy for browser tabs opened by primary-agent sessions. Keep enabled to avoid stale sandbox or managed-browser tabs accumulating across long-lived gateways.",
  "browser.tabCleanup.enabled":
    "Enables cleanup of idle tracked browser tabs for primary-agent sessions. Disable only when external tooling owns tab lifecycle completely.",
  "browser.tabCleanup.idleMinutes":
    "Minutes of inactivity before a tracked primary-agent browser tab is eligible for closure. Set 0 to disable idle-time cleanup while keeping the per-session tab cap.",
  "browser.tabCleanup.maxTabsPerSession":
    "Maximum tracked browser tabs kept per primary-agent session. Oldest inactive tabs are closed first. Set 0 to disable the cap.",
  "browser.tabCleanup.sweepMinutes":
    "Minutes between browser tab cleanup sweeps. Keep this modest so idle tabs are reclaimed without adding frequent background work.",
  "browser.ssrfPolicy":
    "Server-side request forgery guardrail settings for browser/network fetch paths that could reach internal hosts. Keep restrictive defaults in production and open only explicitly approved targets.",
  "browser.ssrfPolicy.dangerouslyAllowPrivateNetwork":
    "Allows access to private-network address ranges from browser tooling. Default is disabled when unset; enable only for explicitly trusted private-network destinations.",
  "browser.ssrfPolicy.allowedHostnames":
    "Explicit hostname allowlist exceptions for SSRF policy checks on browser/network requests. Keep this list minimal and review entries regularly to avoid stale broad access.",
  "browser.ssrfPolicy.hostnameAllowlist":
    "Legacy/alternate hostname allowlist field used by SSRF policy consumers for explicit host exceptions. Use stable exact hostnames and avoid wildcard-like broad patterns.",
  "browser.remoteCdpTimeoutMs":
    "Timeout in milliseconds for connecting to a remote CDP endpoint before failing the browser attach attempt. The larger of this value and remoteCdpHandshakeTimeoutMs also bounds persistent remote tab enumeration. Increase for high-latency tunnels, or lower for faster failure detection.",
  "browser.remoteCdpHandshakeTimeoutMs":
    "Timeout in milliseconds for post-connect CDP handshake readiness checks against remote browser targets. The larger of this value and remoteCdpTimeoutMs also bounds persistent remote tab enumeration. Raise this for slow-start remote browsers and lower to fail fast in automation loops.",
  "discovery.mdns.mode":
    'mDNS broadcast mode ("minimal" default, "full" includes cliPath/sshPort, "off" disables mDNS).',
  discovery:
    "Service discovery settings for local mDNS advertisement and optional wide-area presence signaling. Keep discovery scoped to expected networks to avoid leaking service metadata.",
  "discovery.wideArea":
    "Wide-area discovery configuration group for exposing discovery signals beyond local-link scopes. Enable only in deployments that intentionally aggregate gateway presence across sites.",
  "discovery.wideArea.enabled":
    "Enables wide-area discovery signaling when your environment needs non-local gateway discovery. Keep disabled unless cross-network discovery is operationally required.",
  "discovery.wideArea.domain":
    "Optional unicast DNS-SD domain for wide-area discovery, such as openclaw.internal. Use this when you intentionally publish gateway discovery beyond local mDNS scopes.",
  "discovery.mdns":
    "mDNS discovery configuration group for local network advertisement and discovery behavior tuning. Keep minimal mode for routine LAN discovery unless extra metadata is required.",
  tools:
    "Global tool access policy and capability configuration across web, exec, media, messaging, and elevated surfaces. Use this section to constrain risky capabilities before broad rollout.",
  "tools.allow":
    "Absolute tool allowlist that replaces profile-derived defaults for strict environments. Use this only when you intentionally run a tightly curated subset of tool capabilities.",
  "tools.deny":
    "Global tool denylist that blocks listed tools even when profile or provider rules would allow them. Use deny rules for emergency lockouts and long-term defense-in-depth.",
  "tools.web":
    "Web-tool policy grouping for search/fetch providers, limits, and fallback behavior tuning. Keep enabled settings aligned with API key availability and outbound networking policy.",
  "tools.exec":
    "Exec-tool policy grouping for shell execution host, security mode, approval behavior, and runtime bindings. Keep conservative defaults in production and tighten elevated execution paths.",
  "tools.exec.host":
    'Selects execution target strategy for shell commands. Use "auto" for runtime-aware behavior (sandbox when available, otherwise gateway), or pin sandbox/gateway/node explicitly when you need a fixed surface.',
  "tools.exec.mode":
    'Normalized exec policy selector. Use "auto" for classifier-reviewed approval misses, "ask" for human-reviewed misses, "allowlist" for deterministic safe commands only, or "full" for trusted local operation.',
  "tools.exec.reviewer":
    "Model-backed exec reviewer used by auto mode before human approval fallback. Configure a narrow model override here when you want exec review isolated from the main agent model.",
  "tools.exec.reviewer.model":
    "Optional provider/model override for the exec reviewer agent. Omit to reuse the configured primary model for the target agent.",
  "tools.exec.reviewer.timeoutMs":
    "Per-stage exec reviewer timeout in milliseconds for model preparation and completion before falling back to human approval (default: 30000).",
  "tools.exec.security":
    "Execution security posture selector controlling sandbox/approval expectations for command execution. Keep strict security mode for untrusted prompts and relax only for trusted operator workflows.",
  "tools.exec.ask":
    "Approval strategy for when exec commands require human confirmation before running. Use stricter ask behavior in shared channels and lower-friction settings in private operator contexts.",
  "tools.exec.node":
    "Node binding configuration for exec tooling when command execution is delegated through connected nodes. Use explicit node binding only when multi-node routing is required.",
  "tools.agentToAgent":
    "Policy for allowing agent-to-agent tool calls and constraining which target agents can be reached. Keep disabled or tightly scoped unless cross-agent orchestration is intentionally enabled.",
  "tools.agentToAgent.enabled":
    "Enables the agent_to_agent tool surface so one agent can invoke another agent at runtime. Keep off in simple deployments and enable only when orchestration value outweighs complexity.",
  "tools.agentToAgent.allow":
    "Allowlist of target agent IDs permitted for agent_to_agent calls when orchestration is enabled. Use explicit allowlists to avoid uncontrolled cross-agent call graphs.",
  "tools.experimental":
    "Experimental built-in tool flags. Use each tool's switch to opt in or out of its documented default.",
  "tools.experimental.planTool":
    "Structured `update_plan` checklist tool for non-trivial multi-step work. Enabled by default for embedded models; set false to opt out.",
  "tools.toolSearch":
    "Compact large OpenClaw, MCP, and client tool catalogs. Set to true for the default code bridge or use the object form to choose structured controls or a compact visible tool directory.",
  "tools.toolSearch.enabled":
    "Enables Tool Search. When on, OpenClaw hides large tool catalogs behind `tool_search_code` or structured search/describe/call tools during embedded runtime runs.",
  "tools.toolSearch.mode":
    'Choose the model-facing surface: "code" exposes `tool_search_code`; "tools" exposes structured search/describe/call fallback tools; "directory" keeps a bounded tool directory visible, exposes a bounded set of likely or required schemas, and defers the rest behind search/describe/call.',
  "tools.toolSearch.codeTimeoutMs":
    "Maximum milliseconds for one `tool_search_code` execution. Runtime clamps values to the supported 1s..60s range.",
  "tools.toolSearch.searchDefaultLimit":
    "Default number of Tool Search results returned when the model omits a limit. Runtime clamps this to `maxSearchLimit`.",
  "tools.toolSearch.maxSearchLimit":
    "Maximum number of Tool Search results a model can request. Runtime clamps values to the supported 1..50 range.",
  "tools.codeMode":
    "Generic OpenClaw code mode. When enabled, agent runs expose only `exec` and `wait` to the model and hide normal tools behind a QuickJS-WASI catalog bridge.",
  "tools.codeMode.enabled":
    "Enables generic code mode. Default is off. When explicitly enabled, OpenClaw fails closed if the runtime is unavailable instead of exposing the full tool list.",
  "tools.codeMode.runtime": 'Guest JavaScript runtime. Only "quickjs-wasi" is supported.',
  "tools.codeMode.mode":
    'Model-facing surface. Only "only" is supported: expose code-mode `exec` and `wait` and hide normal tools.',
  "tools.codeMode.languages":
    'Accepted source languages for `exec`. Supported values are "javascript" and "typescript".',
  "tools.codeMode.timeoutMs": "Maximum milliseconds for one code-mode `exec` or `wait` call.",
  "tools.codeMode.memoryLimitBytes": "QuickJS heap limit for one code-mode VM.",
  "tools.codeMode.maxOutputBytes": "Maximum serialized bytes returned through code-mode output.",
  "tools.codeMode.maxSnapshotBytes":
    "Maximum serialized bytes retained for one suspended QuickJS snapshot.",
  "tools.codeMode.maxPendingToolCalls":
    "Maximum concurrent nested tool calls a code-mode VM can start before it must resume later.",
  "tools.codeMode.snapshotTtlSeconds":
    "How long suspended code-mode snapshots can be resumed with `wait` before they expire.",
  "tools.codeMode.searchDefaultLimit":
    "Default number of hidden catalog search results returned by `tools.search` inside code mode.",
  "tools.codeMode.maxSearchLimit":
    "Maximum number of hidden catalog search results a code-mode program can request.",
  "tools.swarm":
    "Collector-mode subagent orchestration. Default is off; enable it to expose agents_wait and swarm spawn options.",
  "tools.swarm.enabled": "Enables collector-mode subagents and agents_wait. Default is off.",
  "tools.swarm.maxConcurrent": "Maximum concurrently running collector children per swarm group.",
  "tools.swarm.maxChildrenPerGroup": "Maximum live collector children per swarm group.",
  "tools.swarm.maxTotalPerGroup": "Maximum lifetime collector spawns per swarm group.",
  "tools.swarm.waitTimeoutSecondsMax": "Maximum timeout accepted by agents_wait, in seconds.",
  "tools.swarm.defaultAgentId":
    "Default target agent for swarm spawns that omit agentId. The subagent allowlist still applies.",
  "tools.elevated":
    "Elevated tool access controls for privileged command surfaces that should only be reachable from trusted senders. Keep disabled unless operator workflows explicitly require elevated actions.",
  "tools.elevated.enabled":
    "Enables elevated tool execution path when sender and policy checks pass. Keep disabled in public/shared channels and enable only for trusted owner-operated contexts.",
  "tools.elevated.allowFrom":
    "Sender allow rules for elevated tools, usually keyed by channel/provider identity formats. Use narrow, explicit identities so elevated commands cannot be triggered by unintended users.",
  "tools.subagents":
    "Tool policy wrapper for spawned subagents to restrict or expand tool availability compared to parent defaults. Use this to keep delegated agent capabilities scoped to task intent.",
  "tools.subagents.tools":
    "Allow/deny tool policy applied to spawned subagent runtimes for per-subagent hardening. Keep this narrower than parent scope when subagents run semi-autonomous workflows.",
  "tools.sandbox":
    "Tool policy wrapper for sandboxed agent executions so sandbox runs can have distinct capability boundaries. Use this to enforce stronger safety in sandbox contexts.",
  "tools.sandbox.tools":
    "Allow/deny tool policy applied when agents run in sandboxed execution environments. Keep policies minimal so sandbox tasks cannot escalate into unnecessary external actions.",
  web: "Web channel runtime settings for heartbeat and reconnect behavior when operating web-based chat surfaces. Use reconnect values tuned to your network reliability profile and expected uptime needs.",
  "web.enabled":
    "Enables the web channel runtime and related websocket lifecycle behavior. Keep disabled when web chat is unused to reduce active connection management overhead.",
  "web.heartbeatSeconds":
    "Heartbeat interval in seconds for web channel connectivity and liveness maintenance. Use shorter intervals for faster detection, or longer intervals to reduce keepalive chatter.",
  "web.reconnect":
    "Reconnect backoff policy for web channel reconnect attempts after transport failure. Keep bounded retries and jitter tuned to avoid thundering-herd reconnect behavior.",
  "web.reconnect.initialMs":
    "Initial reconnect delay in milliseconds before the first retry after disconnection. Use modest delays to recover quickly without immediate retry storms.",
  "web.reconnect.maxMs":
    "Maximum reconnect backoff cap in milliseconds to bound retry delay growth over repeated failures. Use a reasonable cap so recovery remains timely after prolonged outages.",
  "web.reconnect.factor":
    "Exponential backoff multiplier used between reconnect attempts in web channel retry loops. Keep factor above 1 and tune with jitter for stable large-fleet reconnect behavior.",
  "web.reconnect.jitter":
    "Randomization factor (0-1) applied to reconnect delays to desynchronize clients after outage events. Keep non-zero jitter in multi-client deployments to reduce synchronized spikes.",
  "web.reconnect.maxAttempts":
    "Maximum reconnect attempts before giving up for the current failure sequence (0 means no retries). Use finite caps for controlled failure handling in automation-sensitive environments.",
  "web.whatsapp":
    "WhatsApp Web socket timing controls used by Baileys and OpenClaw's local outbound and inbound read-receipt operation bounds. Tune these when network edges, proxies, or NATs are closing otherwise healthy WhatsApp Web sessions.",
  "web.whatsapp.keepAliveIntervalMs":
    "Baileys WhatsApp Web application ping interval in milliseconds. Lower values detect and refresh idle links sooner; keep this comfortably below your network's idle-flow timeout.",
  "web.whatsapp.connectTimeoutMs":
    "Maximum time in milliseconds Baileys waits for the WhatsApp WebSocket opening handshake. Use a higher value on slow or lossy networks that report opening handshake 408 timeouts.",
  "web.whatsapp.defaultQueryTimeoutMs":
    "Default Baileys query timeout and OpenClaw outbound send/presence and inbound read-receipt operation bound in milliseconds for WhatsApp Web requests. Keep aligned with upstream unless a network-specific investigation shows socket operations need longer.",
  talk: "Talk-mode voice synthesis settings for voice identity, model selection, output format, and interruption behavior. Use this section to tune human-facing voice UX while controlling latency and cost.",
  "gateway.auth.token":
    "Required by default for gateway access (unless using Tailscale Serve identity); required for non-loopback binds.",
  "gateway.auth.password": "Required for Tailscale funnel.",
  "agents.defaults.sandbox.browser.network":
    "Docker network for sandbox browser containers (default: openclaw-sandbox-browser). Avoid bridge if you need stricter isolation.",
  "agents.list[].sandbox.browser.network": "Per-agent override for sandbox browser Docker network.",
  "agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin":
    "DANGEROUS break-glass override that allows sandbox Docker network mode container:<id>. This joins another container namespace and weakens sandbox isolation.",
  "agents.list[].sandbox.docker.dangerouslyAllowContainerNamespaceJoin":
    "Per-agent DANGEROUS override for container namespace joins in sandbox Docker network mode.",
  "agents.defaults.sandbox.docker.gpus":
    'Optional Docker GPU passthrough value passed to --gpus, for example "all" or "device=GPU-uuid". Requires a compatible host runtime such as NVIDIA Container Toolkit.',
  "agents.list[].sandbox.docker.gpus":
    "Per-agent Docker GPU passthrough override for sandbox containers.",
  "agents.defaults.sandbox.browser.cdpSourceRange":
    "Optional CIDR allowlist for container-edge CDP ingress (for example 172.21.0.1/32).",
  "agents.list[].sandbox.browser.cdpSourceRange":
    "Per-agent override for CDP source CIDR allowlist.",
  "gateway.controlUi.basePath":
    "Optional URL prefix where the Control UI is served (e.g. /openclaw).",
  "gateway.controlUi.root":
    "Optional filesystem root for Control UI assets (defaults to dist/control-ui).",
  "gateway.controlUi.toolTitles":
    "Opt-in AI purpose titles for tool calls in Control UI chat (default off). When enabled, the chat.toolTitles method generates short titles for complex tool calls with the agent's utility model (an explicit utilityModel may route bounded tool arguments to the operator-chosen provider like every utility task; the derived default stays on the session's provider) and caches them in the per-agent state database. Setting utilityModel to an empty string disables titles too. Leave off to keep tool rendering fully deterministic with no background model calls.",
  "gateway.controlUi.embedSandbox":
    'Iframe sandbox policy for hosted Control UI embeds. "strict" disables scripts, "scripts" allows interactive embeds while keeping origin isolation (default), and "trusted" adds `allow-same-origin` for same-site documents that intentionally need stronger privileges.',
  "gateway.controlUi.allowExternalEmbedUrls":
    "DANGEROUS toggle that allows hosted embeds to load absolute external http(s) URLs. Keep this off unless your Control UI intentionally embeds trusted third-party pages; hosted /__openclaw__/canvas and /__openclaw__/a2ui documents do not need it.",
  "gateway.controlUi.chatMessageMaxWidth":
    'Optional CSS max-width for the centered Control UI chat transcript, for example "960px", "82%", or "min(1280px, 82%)". Values are validated against a constrained width grammar before reaching the browser.',
  "gateway.controlUi.allowedOrigins":
    'Allowed browser origins for Control UI/WebChat websocket connections (full origins only, e.g. https://control.example.com). Required for non-loopback Control UI deployments unless dangerous Host-header fallback is explicitly enabled. Setting ["*"] means allow any browser origin and should be avoided outside tightly controlled local testing.',
  "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback":
    "DANGEROUS toggle that enables Host-header based origin fallback for Control UI/WebChat websocket checks. This mode is supported when your deployment intentionally relies on Host-header origin policy; explicit gateway.controlUi.allowedOrigins remains the recommended hardened default.",
  "gateway.controlUi.allowInsecureAuth":
    "Loosens strict browser auth checks for Control UI when you must run a non-standard setup. Keep this off unless you trust your network and proxy path, because impersonation risk is higher.",
  "gateway.controlUi.dangerouslyDisableDeviceAuth":
    "Disables Control UI device identity checks and relies on token/password only. Use only for short-lived debugging on trusted networks, then turn it off immediately.",
  "mcp.apps":
    "MCP Apps UI support. When enabled, configured MCP servers may provide interactive HTML views for their tool results.",
  "mcp.apps.enabled":
    "Opt-in MCP Apps rendering and app-to-server bridge. Keep disabled unless you trust the configured MCP servers that provide app UI resources.",
  "mcp.apps.sandboxOrigin":
    "Optional dedicated public HTTP(S) origin for MCP Apps. Use this behind a reverse proxy or TLS terminator and proxy it only to the configured MCP Apps sandbox port. It must differ from the Control UI origin and must not serve authenticated content.",
  "mcp.apps.sandboxPort":
    "Dedicated MCP Apps sandbox listener port. Defaults to the Gateway port plus one. Set an unused port when another local service or Gateway profile already owns that port.",
  "gateway.push":
    "Push-delivery settings used by the gateway when it needs to wake or notify paired devices. Configure relay-backed APNs here for official iOS builds; direct APNs auth remains env-based for local/manual builds.",
  "gateway.push.apns":
    "APNs delivery settings for iOS devices paired to this gateway. Use relay settings for official App Store builds that register through the external push relay.",
  "gateway.push.apns.relay":
    "External relay settings for relay-backed APNs sends. The gateway uses the hosted OpenClaw relay by default, or this custom relay for push.test, wake nudges, and reconnect wakes after a paired official iOS build publishes a relay-backed registration.",
  "gateway.push.apns.relay.baseUrl":
    "Optional custom base HTTPS URL for the external APNs relay service used by official App Store iOS builds. Keep this aligned with the relay URL baked into the iOS build so registration and send traffic hit the same deployment.",
  "gateway.push.apns.relay.timeoutMs":
    "Timeout in milliseconds for relay send requests from the gateway to the APNs relay (default: 10000). Increase for slower relays or networks, or lower to fail wake attempts faster.",
  "gateway.http.endpoints.chatCompletions.enabled":
    "Enable the OpenAI-compatible `POST /v1/chat/completions` endpoint (default: false).",
  "gateway.http.endpoints.chatCompletions.maxBodyBytes":
    "Max request body size in bytes for `/v1/chat/completions` (default: 20MB).",
  "gateway.http.endpoints.chatCompletions.maxImageParts":
    "Max number of `image_url` parts accepted from the latest user message (default: 8).",
  "gateway.http.endpoints.chatCompletions.maxTotalImageBytes":
    "Max cumulative decoded bytes across all `image_url` parts in one request (default: 20MB).",
  "gateway.http.endpoints.chatCompletions.images":
    "Image fetch/validation controls for OpenAI-compatible `image_url` parts.",
  "gateway.http.endpoints.chatCompletions.images.allowUrl":
    "Allow server-side URL fetches for `image_url` parts (default: false; data URIs remain supported). Set this to `false` to disable URL fetching entirely.",
  "gateway.http.endpoints.chatCompletions.images.urlAllowlist":
    "Optional hostname allowlist for `image_url` URL fetches; supports exact hosts and `*.example.com` wildcards. Empty or omitted lists mean no hostname allowlist restriction.",
  "gateway.http.endpoints.chatCompletions.images.allowedMimes":
    "Allowed MIME types for `image_url` parts (case-insensitive list).",
  "gateway.http.endpoints.chatCompletions.images.maxBytes":
    "Max bytes per fetched/decoded `image_url` image (default: 10MB).",
  "gateway.http.endpoints.chatCompletions.images.maxRedirects":
    "Max HTTP redirects allowed when fetching `image_url` URLs (default: 3).",
  "gateway.http.endpoints.chatCompletions.images.timeoutMs":
    "Timeout in milliseconds for `image_url` URL fetches (default: 10000).",
  "gateway.reload.mode":
    'Controls how config edits are applied: "off" ignores live edits, "restart" always restarts, "hot" applies in-process, and "hybrid" tries hot then restarts if required. Keep "hybrid" for safest routine updates.',
  "gateway.reload.debounceMs": "Debounce window (ms) before applying config changes.",
  "gateway.reload.deferralTimeoutMs":
    "Optional maximum time (ms) to wait for in-flight operations before forcing a restart. Omit to use the default bounded wait; set 0 to wait indefinitely with periodic still-pending warnings. Lower positive values risk aborting active subagent LLM calls.",
  "gateway.nodes.browser.mode":
    'Node browser routing ("auto" = pick single connected browser node, "manual" = require node param, "off" = disable).',
  "gateway.nodes.browser.node": "Pin browser routing to a specific node id or name (optional).",
  "gateway.nodes.pairing":
    "Node pairing policy settings. SSH-verified auto-approval is enabled by default; CIDR auto-approval stays disabled unless explicit trusted CIDR/IP allowlists are configured.",
  "gateway.nodes.pairing.autoApproveCidrs":
    "Opt-in CIDR/IP allowlist for auto-approving first-time node-role device pairing with no requested scopes. Disabled when unset. Operator, browser, Control UI, and any role, scope, metadata, or public-key upgrade pairing still require manual approval.",
  "gateway.nodes.pairing.sshVerify":
    "SSH-verified auto-approval for first-time node-role device pairing (default: enabled). The gateway SSHes back to the pairing host (BatchMode, strict host keys) and approves only when the remote `openclaw node identity` output matches the pending device key. Set false to disable SSH verification (independent of autoApproveCidrs, which stays active); for manual-only pairing also unset autoApproveCidrs. Pass an object to override user/identity/timeoutMs/cidrs.",
  ...NODE_CAPABILITY_FIELD_HELP,
  "gateway.nodes.allowCommands":
    "Extra node.invoke commands to allow beyond the gateway defaults (array of command strings). Enabling dangerous commands here is a security-sensitive override and is flagged by `openclaw security audit`.",
  "gateway.nodes.denyCommands":
    "Node command names to block even if present in node claims or default allowlist (exact command-name matching only, e.g. `system.run`; does not inspect shell text inside that command).",
  nodeHost:
    "Node host controls for features exposed from this gateway node to other nodes or clients. Keep defaults unless you intentionally proxy local capabilities across your node network.",
  "nodeHost.agentRuns":
    "Opt in to approval-gated native agent turns on this headless node host. Disabled by default.",
  "nodeHost.agentRuns.claude":
    "Controls whether this headless node host may advertise Claude CLI agent turns to the gateway.",
  "nodeHost.agentRuns.claude.enabled":
    "Advertise paired-node Claude session continuation when the local claude binary is available (default: false). Runs still require node exec approval.",
  "nodeHost.browserProxy":
    "Groups browser-proxy settings for exposing local browser control through node routing. Enable only when remote node workflows need your local browser profiles.",
  "nodeHost.browserProxy.enabled":
    "Expose the local browser control server through node proxy routing so remote clients can use this host's browser capabilities. Keep disabled unless remote automation explicitly depends on it.",
  "nodeHost.browserProxy.allowProfiles":
    "Optional allowlist of browser profile names exposed through node proxy routing. Leave empty to preserve the default full profile surface, including profile create/delete routes. When set, OpenClaw enforces least-privilege profile access and blocks persistent profile create/delete through the proxy.",
  "nodeHost.mcp":
    "Use MCP servers started by the headless node host and published to its paired gateway as agent tools. Restart the node host after changing this section.",
  "nodeHost.mcp.servers":
    "Named MCP server definitions local to this node. Uses the same server shape as mcp.servers; OAuth servers are not supported by the node host.",
  "nodeHost.skills":
    "Use this section to publish skills installed in ~/.openclaw/skills from the headless node host. Restart the node host after changing skill files.",
  "nodeHost.skills.enabled":
    "Scan and publish node-hosted skills after connecting (default: true). Set false to disable node skill publication.",
  media:
    "Top-level media behavior shared across providers and tools that handle inbound files. Keep defaults unless you need stable filenames for external processing pipelines or longer-lived inbound media retention.",
  "media.preserveFilenames":
    "When enabled, uploaded media keeps its original filename instead of a generated temp-safe name. Turn this on when downstream automations depend on stable names, and leave off to reduce accidental filename leakage.",
  "media.ttlHours":
    "Optional retention window in hours for persisted media cleanup across the full media tree. Leave unset to disable automatic cleanup (media writes never prune), or set values like 24 (1 day) or 168 (7 days) to periodically remove media older than the window.",
  bindings:
    "Top-level binding rules for routing and persistent ACP conversation ownership. Use type=route for normal routing and type=acp for persistent ACP harness bindings.",
  "bindings[].type":
    'Binding kind. Use "route" (or omit for legacy route entries) for normal routing, and "acp" for persistent ACP conversation bindings.',
  "bindings[].agentId":
    "Target agent ID that receives traffic when the corresponding binding match rule is satisfied. Use valid configured agent IDs only so routing does not fail at runtime.",
  "bindings[].session":
    "Optional route session overrides for conversations matched by this binding. Use this when a narrow route should keep the same agent but isolate session continuity differently.",
  "bindings[].session.dmScope":
    'Optional DM session scope override for this route binding. For example, keep global session.dmScope="main" while using "per-account-channel-peer" for selected direct peers.',
  "bindings[].match":
    "Match rule object for deciding when a binding applies, including channel and optional account/peer constraints. Keep rules narrow to avoid accidental agent takeover across contexts.",
  "bindings[].match.channel":
    "Channel/provider identifier this binding applies to, such as `telegram`, `discord`, or a plugin channel ID. Use the configured channel key exactly so binding evaluation works reliably.",
  "bindings[].match.accountId":
    "Optional account selector for multi-account channel setups so the binding applies only to one identity. Use this when account scoping is required for the route and leave unset otherwise.",
  "bindings[].match.peer":
    "Optional peer matcher for specific conversations including peer kind and peer id. Use this when only one direct/group/channel target should be pinned to an agent.",
  "bindings[].match.peer.kind":
    'Peer conversation type: "direct", "group", "channel", or legacy "dm" (deprecated alias for direct). Prefer "direct" for new configs and keep kind aligned with channel semantics.',
  "bindings[].match.peer.id":
    "Conversation identifier used with peer matching, such as a chat ID, channel ID, or group ID from the provider. Keep this exact to avoid silent non-matches.",
  "bindings[].match.guildId":
    "Optional Discord-style guild/server ID constraint for binding evaluation in multi-server deployments. Use this when the same peer identifiers can appear across different guilds.",
  "bindings[].match.teamId":
    "Optional team/workspace ID constraint used by providers that scope chats under teams. Add this when you need bindings isolated to one workspace context.",
  "bindings[].match.roles":
    "Optional role-based filter list used by providers that attach roles to chat context. Use this to route privileged or operational role traffic to specialized agents.",
  "bindings[].acp":
    "Optional per-binding ACP overrides for bindings[].type=acp. This layer overrides agents.list[].runtime.acp defaults for the matched conversation.",
  "bindings[].acp.mode": "ACP session mode override for this binding (persistent or oneshot).",
  "bindings[].acp.label":
    "Human-friendly label for ACP status/diagnostics in this bound conversation.",
  "bindings[].acp.cwd": "Working directory override for ACP sessions created from this binding.",
  "bindings[].acp.backend":
    "ACP backend override for this binding (falls back to agent runtime ACP backend, then global acp.backend).",
  broadcast:
    "Broadcast routing map for sending the same outbound message to multiple peer IDs per source conversation. Keep this minimal and audited because one source can fan out to many destinations.",
  "broadcast.strategy":
    'Delivery order for broadcast fan-out: "parallel" sends to all targets concurrently, while "sequential" sends one-by-one. Use "parallel" for speed and "sequential" for stricter ordering/backpressure control.',
  "broadcast.*":
    "Per-source broadcast destination list where each key is a source peer ID and the value is an array of destination peer IDs. Keep lists intentional to avoid accidental message amplification.",
  "diagnostics.flags":
    'Enable targeted diagnostics logs by flag (e.g. ["telegram.http"]). Supports wildcards like "telegram.*" or "*".',
  "diagnostics.enabled":
    "Master toggle for diagnostics instrumentation output in logs and telemetry wiring paths. Defaults to enabled; set false only in tightly constrained environments.",
  "diagnostics.stuckSessionWarnMs":
    "No-progress age threshold in milliseconds for classifying long processing sessions as long-running, stalled, or stuck. Reply, tool, status, block, and ACP progress reset the timer; repeated stuck diagnostics back off while unchanged.",
  "diagnostics.stuckSessionAbortMs":
    "No-progress age threshold in milliseconds before eligible stalled active work may be abort-drained for recovery. Defaults to the safer extended embedded-run recovery window.",
  "diagnostics.otel.enabled":
    "Enables OpenTelemetry export pipeline for traces, metrics, and logs based on configured endpoint/protocol settings. Keep disabled unless your collector endpoint and auth are fully configured.",
  "diagnostics.otel.endpoint":
    "Collector endpoint URL used for OpenTelemetry export transport, including scheme and port. Use a reachable, trusted collector endpoint and monitor ingestion errors after rollout.",
  "diagnostics.otel.tracesEndpoint":
    "Signal-specific OTLP/HTTP trace endpoint. When set, this overrides diagnostics.otel.endpoint and OTEL_EXPORTER_OTLP_ENDPOINT for trace export only.",
  "diagnostics.otel.metricsEndpoint":
    "Signal-specific OTLP/HTTP metrics endpoint. When set, this overrides diagnostics.otel.endpoint and OTEL_EXPORTER_OTLP_ENDPOINT for metrics export only.",
  "diagnostics.otel.logsEndpoint":
    "Signal-specific OTLP/HTTP logs endpoint. When set, this overrides diagnostics.otel.endpoint and OTEL_EXPORTER_OTLP_ENDPOINT for log export only.",
  "diagnostics.otel.protocol":
    'OTel transport protocol for telemetry export: "http/protobuf" or "grpc" depending on collector support. Use the protocol your observability backend expects to avoid dropped telemetry payloads.',
  "diagnostics.otel.headers":
    "Additional HTTP/gRPC metadata headers sent with OpenTelemetry export requests, often used for tenant auth or routing. Keep secrets in env-backed values and avoid unnecessary header sprawl.",
  "diagnostics.otel.serviceName":
    "Service name reported in telemetry resource attributes to identify this gateway instance in observability backends. Use stable names so dashboards and alerts remain consistent over deployments.",
  "diagnostics.otel.traces":
    "Enable trace signal export to the configured OpenTelemetry collector endpoint. Keep enabled when latency/debug tracing is needed, and disable if you only want metrics/logs.",
  "diagnostics.otel.metrics":
    "Enable metrics signal export to the configured OpenTelemetry collector endpoint. Keep enabled for runtime health dashboards, and disable only if metric volume must be minimized.",
  "diagnostics.otel.logs":
    "Enable log signal export through OpenTelemetry in addition to local logging sinks. Use this when centralized log correlation is required across services and agents.",
  "diagnostics.otel.logsExporter":
    'Log export sink for diagnostics.otel.logs. Use "otlp" for the configured OTLP logs endpoint, "stdout" for one JSON record per stdout line in container log pipelines, and "both" when both sinks are required.',
  "diagnostics.otel.sampleRate":
    "Trace sampling rate (0-1) controlling how much trace traffic is exported to observability backends. Lower rates reduce overhead/cost, while higher rates improve debugging fidelity.",
  "diagnostics.otel.flushIntervalMs":
    "Interval in milliseconds for periodic telemetry flush from buffers to the collector. Increase to reduce export chatter, or lower for faster visibility during active incident response.",
  "diagnostics.otel.captureContent":
    "Opt-in OTEL span content capture. Defaults to off; boolean true captures non-system message/tool content, while the object form lets you enable specific content classes.",
  "diagnostics.otel.captureContent.enabled":
    "Master switch for granular OTEL content capture fields. Keep disabled unless your collector is approved for raw prompt, response, or tool content.",
  "diagnostics.otel.captureContent.inputMessages":
    "Capture model input message text on OTEL spans when content capture is enabled.",
  "diagnostics.otel.captureContent.outputMessages":
    "Capture model output message text on OTEL spans when content capture is enabled.",
  "diagnostics.otel.captureContent.toolInputs":
    "Capture tool input text on OTEL spans when content capture is enabled.",
  "diagnostics.otel.captureContent.toolOutputs":
    "Capture tool output text on OTEL spans when content capture is enabled.",
  "diagnostics.otel.captureContent.systemPrompt":
    "Capture system prompt text on OTEL spans when content capture is enabled. This remains off unless explicitly enabled.",
  "diagnostics.otel.captureContent.toolDefinitions":
    "Capture model tool definition schemas on OTEL spans when content capture is enabled.",
  "diagnostics.cacheTrace.enabled":
    "Log cache trace snapshots for embedded agent runs (default: false).",
  "diagnostics.cacheTrace.filePath":
    "JSONL output path for cache trace logs (default: $OPENCLAW_STATE_DIR/logs/cache-trace.jsonl).",
  "diagnostics.cacheTrace.includeMessages":
    "Include full message payloads in trace output (default: true).",
  "diagnostics.cacheTrace.includePrompt": "Include prompt text in trace output (default: true).",
  "diagnostics.cacheTrace.includeSystem": "Include system prompt in trace output (default: true).",
  "tools.exec.applyPatch.enabled":
    "Enable or disable apply_patch for OpenAI and OpenAI Codex models when allowed by tool policy (default: true).",
  "tools.exec.applyPatch.workspaceOnly":
    "Restrict apply_patch paths to the workspace directory (default: true). Set false to allow writing outside the workspace (dangerous).",
  "tools.exec.applyPatch.allowModels":
    'Optional allowlist of model ids (e.g. "gpt-5.4" or "openai/gpt-5.4").',
  "tools.loopDetection.enabled":
    "Enable repetitive tool-call loop detection and backoff safety checks (default: false).",
  "tools.loopDetection.historySize": "Tool history window size for loop detection (default: 30).",
  "tools.loopDetection.warningThreshold":
    "Warning threshold for repetitive patterns when detector is enabled (default: 10).",
  "tools.loopDetection.unknownToolThreshold":
    "Block repeated calls to the same unavailable tool after this many misses (default: 10).",
  "tools.loopDetection.criticalThreshold":
    "Critical threshold for repetitive patterns when detector is enabled (default: 20).",
  "tools.loopDetection.globalCircuitBreakerThreshold":
    "Global no-progress breaker threshold (default: 30).",
  "tools.loopDetection.detectors.genericRepeat":
    "Enable generic repeated same-tool/same-params loop detection (default: true).",
  "tools.loopDetection.detectors.knownPollNoProgress":
    "Enable known poll tool no-progress loop detection (default: true).",
  "tools.loopDetection.detectors.pingPong": "Enable ping-pong loop detection (default: true).",
  "tools.loopDetection.postCompactionGuard.windowSize":
    "Number of post-compaction attempts during which the guard stays armed (default: 3). Lower values are stricter; higher values give the agent more attempts before abort.",
  "tools.exec.notifyOnExit":
    "When true (default), backgrounded exec sessions on exit and node exec lifecycle events enqueue a system event and request a heartbeat.",
  "tools.exec.notifyOnExitEmptySuccess":
    "When true, successful backgrounded exec exits with empty output still enqueue a completion system event (default: false).",
  "tools.exec.pathPrepend": "Directories to prepend to PATH for exec runs (gateway/sandbox).",
  "tools.exec.safeBins":
    "Allow stdin-only safe binaries to run without explicit allowlist entries.",
  "tools.exec.strictInlineEval":
    "Require explicit approval for interpreter inline-eval forms such as `python -c`, `node -e`, `ruby -e`, or `osascript -e`. Prevents silent allowlist reuse and downgrades allow-always to ask-each-time for those forms.",
  "tools.exec.commandHighlighting":
    "Show parser-derived command highlights in exec approval prompts (default: false). Enable this to render highlighted command text without changing exec approval policy.",
  "tools.exec.safeBinTrustedDirs":
    "Additional explicit directories trusted for safe-bin path checks (PATH entries are never auto-trusted).",
  "tools.exec.safeBinProfiles":
    "Optional per-binary safe-bin profiles (positional limits + allowed/denied flags).",
  "tools.profile":
    "Global tool profile name used to select a predefined tool policy baseline before applying allow/deny overrides. Use this for consistent environment posture across agents and keep profile names stable.",
  "tools.alsoAllow":
    "Extra tool allowlist entries merged on top of the selected tool profile and default policy. Keep this list small and explicit so audits can quickly identify intentional policy exceptions.",
  "tools.byProvider":
    "Per-provider tool allow/deny overrides keyed by channel/provider ID to tailor capabilities by surface. Use this when one provider needs stricter controls than global tool policy.",
  "agents.list[].tools.profile":
    "Per-agent override for tool profile selection when one agent needs a different capability baseline. Use this sparingly so policy differences across agents stay intentional and reviewable.",
  "agents.list[].tools.alsoAllow":
    "Per-agent additive allowlist for tools on top of global and profile policy. Keep narrow to avoid accidental privilege expansion on specialized agents.",
  "agents.list[].tools.codeMode":
    "Per-agent code mode override. Use this to test or roll out exec/wait tool-surface mode for one agent without enabling it fleet-wide.",
  "agents.list[].tools.swarm":
    "Per-agent swarm override. Values merge over the top-level tools.swarm configuration.",
  "agents.list[].tools.byProvider":
    "Per-agent provider-specific tool policy overrides for channel-scoped capability control. Use this when a single agent needs tighter restrictions on one provider than others.",
  "agents.list[].tools.message.crossContext.allowWithinProvider":
    "Per-agent message guard for sending to other conversations on the same provider. Set false for current-conversation-only public agents.",
  "agents.list[].tools.message.crossContext.allowAcrossProviders":
    "Per-agent message guard for sending across providers. Keep false for public or sandboxed agents.",
  "agents.list[].tools.message.actions.allow":
    'Per-agent message action allowlist for the message tool. Set to a minimal list such as ["send"] for public sandbox agents so read, edit, delete, reaction, and other provider-specific message actions stay hidden and blocked.',
  "tools.exec.approvalRunningNoticeMs":
    "Delay in milliseconds before showing an in-progress notice after an exec approval is granted. Increase to reduce flicker for fast commands, or lower for quicker operator feedback.",
  "tools.links.enabled":
    "Enable automatic link understanding pre-processing so URLs can be summarized before agent reasoning. Keep enabled for richer context, and disable when strict minimal processing is required.",
  "tools.links.maxLinks":
    "Maximum number of links expanded per turn during link understanding. Use lower values to control latency/cost in chatty threads and higher values when multi-link context is critical.",
  "tools.links.timeoutSeconds":
    "Per-link understanding timeout budget in seconds before unresolved links are skipped. Keep this bounded to avoid long stalls when external sites are slow or unreachable.",
  "tools.links.models":
    "Preferred model list for link understanding tasks, evaluated in order as fallbacks when supported. Use lightweight models first for routine summarization and heavier models only when needed.",
  "tools.links.scope":
    "Controls when link understanding runs relative to conversation context and message type. Keep scope conservative to avoid unnecessary fetches on messages where links are not actionable.",
  "tools.media.models":
    "Shared fallback model list used by media understanding tools when modality-specific model lists are not set. Keep this aligned with available multimodal providers to avoid runtime fallback churn.",
  "tools.media.concurrency":
    "Maximum number of concurrent media understanding operations per turn across image, audio, and video tasks. Lower this in resource-constrained deployments to prevent CPU/network saturation.",
  "tools.media.asyncCompletion.directSend":
    "Deprecated compatibility flag. Async media generation completions are requester-session mediated so the agent can decide how to tell the user and use the message tool when source delivery requires it.",
  "tools.media.image.enabled":
    "Enable image understanding so attached or referenced images can be interpreted into textual context. Disable if you need text-only operation or want to avoid image-processing cost.",
  "tools.media.image.maxBytes":
    "Maximum accepted image payload size in bytes before the item is skipped or truncated by policy. Keep limits realistic for your provider caps and infrastructure bandwidth.",
  "tools.media.image.maxChars":
    "Maximum characters returned from image understanding output after model response normalization. Use tighter limits to reduce prompt bloat and larger limits for detail-heavy OCR tasks.",
  "tools.media.image.prompt":
    "Instruction template used for image understanding requests to shape extraction style and detail level. Keep prompts deterministic so outputs stay consistent across turns and channels.",
  "tools.media.image.timeoutSeconds":
    "Timeout in seconds for each image understanding request before it is aborted. Increase for high-resolution analysis and lower it for latency-sensitive operator workflows.",
  "tools.media.image.attachments":
    "Attachment handling policy for image inputs, including which message attachments qualify for image analysis. Use restrictive settings in untrusted channels to reduce unexpected processing.",
  "tools.media.image.models":
    "Ordered model preferences specifically for image understanding when you want to override shared media models. Put the most reliable multimodal model first to reduce fallback attempts.",
  "tools.media.image.scope":
    "Scope selector for when image understanding is attempted (for example only explicit requests versus broader auto-detection). Keep narrow scope in busy channels to control token and API spend.",
  ...MEDIA_AUDIO_FIELD_HELP,
  "tools.media.video.enabled":
    "Enable video understanding so clips can be summarized into text for downstream reasoning and responses. Disable when processing video is out of policy or too expensive for your deployment.",
  "tools.media.video.maxBytes":
    "Maximum accepted video payload size in bytes before policy rejection or trimming occurs. Tune this to provider and infrastructure limits to avoid repeated timeout/failure loops.",
  "tools.media.video.maxChars":
    "Maximum characters retained from video understanding output to control prompt growth. Raise for dense scene descriptions and lower when concise summaries are preferred.",
  "tools.media.video.prompt":
    "Instruction template for video understanding describing desired summary granularity and focus areas. Keep this stable so output quality remains predictable across model/provider fallbacks.",
  "tools.media.video.timeoutSeconds":
    "Timeout in seconds for each video understanding request before cancellation. Use conservative values in interactive channels and longer values for offline or batch-heavy processing.",
  "tools.media.video.attachments":
    "Attachment eligibility policy for video analysis, defining which message files can trigger video processing. Keep this explicit in shared channels to prevent accidental large media workloads.",
  "tools.media.video.models":
    "Ordered model preferences specifically for video understanding before shared media fallback applies. Prioritize models with strong multimodal video support to minimize degraded summaries.",
  "tools.media.video.scope":
    "Scope selector controlling when video understanding is attempted across incoming events. Narrow scope in noisy channels, and broaden only where video interpretation is core to workflow.",
  "skills.load.extraDirs":
    "Additional shared skill roots to scan at lowest precedence. Use this for sibling repos or shared skill packs that should be available without copying them into the OpenClaw workspace.",
  "skills.load.allowSymlinkTargets":
    "Trusted real target roots that skill symlinks may resolve into when they sit outside their configured source root. Keep this narrow, such as a sibling repo skills directory.",
  "skills.load.watch":
    "Enable filesystem watching for skill-definition changes so updates can be applied without full process restart. Keep enabled in development workflows and disable in immutable production images.",
  "skills.load.watchDebounceMs":
    "Debounce window in milliseconds for coalescing rapid skill file changes before reload logic runs. Increase to reduce reload churn on frequent writes, or lower for faster edit feedback.",
  "skills.workshop.allowSymlinkTargetWrites":
    "Allows Skill Workshop apply to write through symlinked workspace skill paths whose real target is already trusted by skills.load.allowSymlinkTargets. Keep disabled unless operators intentionally want generated proposal applies to mutate those shared skill roots.",
  approvals:
    "Approval routing controls for forwarding exec and plugin approval requests to chat destinations outside the originating session. Keep these disabled unless operators need explicit out-of-band approval visibility.",
  "approvals.exec":
    "Groups exec-approval forwarding behavior including enablement, routing mode, filters, and explicit targets. Configure here when approval prompts must reach operational channels instead of only the origin thread.",
  "approvals.exec.enabled":
    "Enables forwarding of exec approval requests to configured delivery destinations (default: false). Keep disabled in low-risk setups and enable only when human approval responders need channel-visible prompts.",
  "approvals.exec.mode":
    'Controls where approval prompts are sent: "session" uses origin chat, "targets" uses configured targets, and "both" sends to both paths. Use "session" as baseline and expand only when operational workflow requires redundancy.',
  "approvals.exec.agentFilter":
    'Optional allowlist of agent IDs eligible for forwarded approvals, for example `["primary", "ops-agent"]`. Use this to limit forwarding blast radius and avoid notifying channels for unrelated agents.',
  "approvals.exec.sessionFilter":
    'Optional session-key filters matched as substring or regex-style patterns, for example `["discord:", "^agent:ops:"]`. Use narrow patterns so only intended approval contexts are forwarded to shared destinations.',
  "approvals.exec.targets":
    "Explicit delivery targets used when forwarding mode includes targets, each with channel and destination details. Keep target lists least-privilege and validate each destination before enabling broad forwarding.",
  "approvals.exec.targets[].channel":
    "Channel/provider ID used for forwarded approval delivery, such as discord, slack, or a plugin channel id. Use valid channel IDs only so approvals do not silently fail due to unknown routes.",
  "approvals.exec.targets[].to":
    "Destination identifier inside the target channel (channel ID, user ID, or thread root depending on provider). Verify semantics per provider because destination format differs across channel integrations.",
  "approvals.exec.targets[].accountId":
    "Optional account selector for multi-account channel setups when approvals must route through a specific account context. Use this only when the target channel has multiple configured identities.",
  "approvals.exec.targets[].threadId":
    "Optional thread/topic target for channels that support threaded delivery of forwarded approvals. Use this to keep approval traffic contained in operational threads instead of main channels.",
  "approvals.plugin":
    "Groups plugin-approval forwarding behavior including enablement, routing mode, filters, and explicit targets. Independent of exec approval forwarding. Configure here when plugin approval prompts must reach operational channels.",
  "approvals.plugin.enabled":
    "Enables forwarding of plugin approval requests to configured delivery destinations (default: false). Independent of approvals.exec.enabled.",
  "approvals.plugin.mode":
    'Controls where plugin approval prompts are sent: "session" uses origin chat, "targets" uses configured targets, and "both" sends to both paths.',
  "approvals.plugin.agentFilter":
    'Optional allowlist of agent IDs eligible for forwarded plugin approvals, for example `["primary", "ops-agent"]`. Use this to limit forwarding blast radius.',
  "approvals.plugin.sessionFilter":
    'Optional session-key filters matched as substring or regex-style patterns, for example `["discord:", "^agent:ops:"]`. Use narrow patterns so only intended approval contexts are forwarded.',
  "approvals.plugin.targets":
    "Explicit delivery targets used when plugin approval forwarding mode includes targets, each with channel and destination details.",
  "approvals.plugin.targets[].channel":
    "Channel/provider ID used for forwarded plugin approval delivery, such as discord, slack, or a plugin channel id.",
  "approvals.plugin.targets[].to":
    "Destination identifier inside the target channel (channel ID, user ID, or thread root depending on provider).",
  "approvals.plugin.targets[].accountId":
    "Optional account selector for multi-account channel setups when plugin approvals must route through a specific account context.",
  "approvals.plugin.targets[].threadId":
    "Optional thread/topic target for channels that support threaded delivery of forwarded plugin approvals.",
  "tools.fs.workspaceOnly":
    "Restrict filesystem tools (read/write/edit/apply_patch) to the workspace directory (default: false).",
  "tools.sessions.visibility":
    'Controls which sessions can be targeted by sessions_list/sessions_history/sessions_search/sessions_send. ("tree" default = current session + spawned subagent sessions; "self" = only current; "agent" = any session in the current agent id; "all" = any session; cross-agent still requires tools.agentToAgent).',
  "tools.message.allowCrossContextSend":
    "Legacy override: allow cross-context sends across all providers.",
  "tools.message.crossContext.allowWithinProvider":
    "Allow sends to other channels within the same provider (default: true).",
  "tools.message.crossContext.allowAcrossProviders":
    "Allow sends across different providers (default: false).",
  "tools.message.crossContext.marker.enabled":
    "Add a visible origin marker when sending cross-context (default: true).",
  "tools.message.crossContext.marker.prefix":
    'Text prefix for cross-context markers (supports "{channel}").',
  "tools.message.crossContext.marker.suffix":
    'Text suffix for cross-context markers (supports "{channel}").',
  "tools.message.broadcast.enabled": "Enable broadcast action (default: true).",
  "tools.message.actions.allow":
    "Global message action allowlist for the message tool. Use only when the whole runtime should expose and accept a reduced action set; prefer per-agent allowlists for public or sandboxed agents.",
  "tools.web.search.enabled":
    "Enable managed web_search and optional Codex-native search for eligible models.",
  "tools.web.search.provider":
    "Search provider id. Auto-detected from available API keys if omitted.",
  "tools.web.search.maxResults": "Number of results to return (1-10).",
  "tools.web.search.timeoutSeconds": "Timeout in seconds for web_search requests.",
  "tools.web.search.cacheTtlMinutes": "Cache TTL in minutes for web_search results.",
  "tools.web.search.openaiCodex.enabled":
    "Enable native Codex web search for Codex-capable models.",
  "tools.web.search.openaiCodex.mode":
    'Native Codex web search preference: "cached" (default; unrestricted Codex turns resolve it to live) or "live".',
  "tools.web.search.openaiCodex.allowedDomains":
    "Optional domain allowlist passed to the native Codex web_search tool.",
  "tools.web.search.openaiCodex.contextSize":
    'Native Codex search context size hint: "low", "medium", or "high".',
  "tools.web.search.openaiCodex.userLocation.country":
    "Approximate country sent to native Codex web search.",
  "tools.web.search.openaiCodex.userLocation.region":
    "Approximate region/state sent to native Codex web search.",
  "tools.web.search.openaiCodex.userLocation.city":
    "Approximate city sent to native Codex web search.",
  "tools.web.search.openaiCodex.userLocation.timezone":
    "Approximate timezone sent to native Codex web search.",
  "tools.web.search.brave.mode":
    'Brave Search mode: "web" (URL results) or "llm-context" (pre-extracted page content for LLM grounding).',
  "tools.web.fetch.enabled": "Enable the web_fetch tool (lightweight HTTP fetch).",
  "tools.web.fetch.maxChars": "Max characters returned by web_fetch (truncated).",
  "tools.web.fetch.maxCharsCap":
    "Hard cap for web_fetch maxChars (applies to config and tool calls).",
  "tools.web.fetch.maxResponseBytes": "Max download size before truncation.",
  "tools.web.fetch.provider": "Web fetch fallback provider id.",
  "tools.web.fetch.timeoutSeconds": "Timeout in seconds for web_fetch requests.",
  "tools.web.fetch.cacheTtlMinutes": "Cache TTL in minutes for web_fetch results.",
  "tools.web.fetch.maxRedirects": "Maximum redirects allowed for web_fetch (default: 3).",
  "tools.web.fetch.userAgent": "Override User-Agent header for web_fetch requests.",
  "tools.web.fetch.readability":
    "Use Readability to extract main content from HTML (fallbacks to basic HTML cleanup).",
  "tools.web.fetch.useTrustedEnvProxy":
    "Route web_fetch through a trusted HTTP(S) env proxy and let the proxy resolve DNS. Enable only when that proxy is operator-controlled and enforces outbound policy after DNS resolution.",
  "tools.web.fetch.ssrfPolicy":
    "Scoped SSRF policy overrides for web_fetch. Keep this narrow and opt in only for known local-network proxy environments.",
  "tools.web.fetch.ssrfPolicy.allowRfc2544BenchmarkRange":
    "Allow RFC 2544 benchmark-range IPs (198.18.0.0/15) for fake-IP proxy compatibility such as Clash or Surge.",
  "tools.web.fetch.ssrfPolicy.allowIpv6UniqueLocalRange":
    "Allow IPv6 Unique Local Addresses (fc00::/7) for trusted fake-IP proxy compatibility such as sing-box, Clash, or Surge.",
};
