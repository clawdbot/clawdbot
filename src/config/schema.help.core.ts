// Defines user-facing config field help text for docs and UI surfaces.
import { describeTalkSilenceTimeoutDefaults } from "./talk-defaults.js";

export const CORE_FIELD_HELP: Record<string, string> = {
  "channels.discord.activities":
    "Discord Activities configuration for launching interactive HTML widgets inside Discord. Leave unset to keep all Activity routes, tools, and handlers disabled.",
  "channels.discord.activities.clientSecret":
    "OAuth2 client secret for the Discord application that hosts Activities. Keep this value secret; DISCORD_CLIENT_SECRET is used when this field is unset.",
  "channels.discord.activities.applicationId":
    "Optional Discord application ID for Activities. Defaults to the bot application ID learned from Discord at gateway startup.",
  meta: "Backward-readable compatibility metadata retained so older binaries can refuse unsafe config downgrades.",
  "meta.lastTouchedVersion": "OpenClaw version that most recently wrote this config.",
  "meta.migrations": "Bounded compatibility markers for completed config migrations.",
  "meta.migrations.modelPolicyAllowlist":
    "Records that legacy model-map restrictions were preserved or evaluated.",
  env: "Environment import and override settings used to supply runtime variables to the gateway process. Use this section to control shell-env loading and explicit variable injection behavior.",
  "env.shellEnv":
    "Shell environment import controls for loading variables from your login shell during startup. Keep this enabled when you depend on profile-defined secrets or PATH customizations.",
  "env.shellEnv.enabled":
    "Enables loading environment variables from the user shell profile during startup initialization. Keep enabled for developer machines, or disable in locked-down service environments with explicit env management.",
  "env.shellEnv.timeoutMs":
    "Maximum time in milliseconds allowed for shell environment resolution before fallback behavior applies. Use tighter timeouts for faster startup, or increase when shell initialization is heavy.",
  "env.vars":
    "Explicit key/value environment variable overrides merged into runtime process environment for OpenClaw. Use this for deterministic env configuration instead of relying only on shell profile side effects.",
  wizard:
    "User-owned setup preferences. Machine-owned wizard history and acknowledgement state live in the shared state database.",
  "wizard.accessMode":
    'Discovery consent for guided setup: "full" scans silently while "guarded" asks before inspecting local applications.',
  "wizard.appRecommendations":
    "Controls whether guided setup may use installed-application labels to recommend relevant plugins and skills.",
  "wizard.lastRunAt": "Timestamp of the last successfully committed wizard run.",
  "wizard.lastRunVersion": "OpenClaw version used by the last wizard run.",
  "wizard.lastRunCommit": "Source commit used by the last development wizard run.",
  "wizard.lastRunCommand": "Command that invoked the last wizard run.",
  "wizard.lastRunMode": 'Whether the last wizard run targeted "local" or "remote" setup.',
  "wizard.localModelLeanAutoModel":
    "Model reference whose lean-mode setting remains owned by onboarding.",
  "wizard.securityAcknowledgedAt":
    "Timestamp of the setup security acknowledgement, committed with the target config.",
  "logging.audit":
    "Bounded metadata-only audit history for operator review. Run and tool records are enabled by default; message lifecycle metadata is a separate privacy-sensitive opt-in. The background writer is best-effort rather than a lossless compliance archive.",
  "logging.audit.enabled":
    "Records new run, tool, and enabled message audit events. Default: true. Disabling event inserts does not immediately delete existing records; retained rows remain queryable until they expire.",
  "logging.audit.messages":
    'Controls content-free message lifecycle records: "off" (default), "direct" for known direct conversations only, or "all" for direct, group, channel, and unknown conversation kinds. Both logging.audit.enabled and logging.audit.messages are startup-scoped; restart the Gateway after changing either setting.',
  diagnostics:
    "Diagnostics controls for targeted tracing, telemetry export, and cache inspection during debugging. Keep baseline diagnostics minimal in production and enable deeper signals only when investigating issues.",
  "diagnostics.otel":
    "OpenTelemetry export settings for traces, metrics, and logs emitted by gateway components. Use this when integrating with centralized observability backends and distributed tracing pipelines.",
  "diagnostics.cacheTrace":
    "Cache-trace logging settings for observing cache decisions and payload context in embedded runs. Enable this temporarily for debugging and disable afterward to reduce sensitive log footprint.",
  logging:
    "Logging behavior controls for severity, output destinations, formatting, and sensitive-data redaction. Keep levels and redaction strict enough for production while preserving useful diagnostics.",
  "logging.level":
    'Primary log level threshold for runtime logger output: "silent", "fatal", "error", "warn", "info", "debug", or "trace". Keep "info" or "warn" for production, and use debug/trace only during investigation.',
  "logging.file":
    "Optional file path for persisted log output in addition to or instead of console logging. Use a managed writable path and align retention/rotation with your operational policy.",
  "logging.consoleLevel":
    'Console-specific log threshold: "silent", "fatal", "error", "warn", "info", "debug", or "trace" for terminal output control. Use this to keep local console quieter while retaining richer file logging if needed.',
  "logging.consoleStyle":
    'Console output format style: "pretty" or "json". Use json for machine parsing pipelines and pretty for human-first terminal workflows.',
  "logging.redactPatterns":
    "Additional custom redact regex patterns applied to log output, persisted transcript text, and safety-boundary UI/tool/diagnostic payloads before emission. Use this to mask org-specific tokens and identifiers not covered by built-in redaction rules.",
  update:
    "Update-channel and startup-check behavior for keeping OpenClaw runtime versions current. Use conservative channels in production and more experimental channels only in controlled environments.",
  "update.channel":
    'Update channel for git + npm installs ("stable", "extended-stable", "beta", or "dev"). Extended-stable is package-only: installation is foreground-only, with optional read-only startup hints.',
  "update.checkOnStart":
    "Check for npm updates when the gateway starts, including read-only extended-stable hints (default: true).",
  "update.auto.enabled":
    "Enable background auto-update for stable and beta package installs; extended-stable never auto-applies (default: false).",
  cloudWorkers:
    "Opt-in cloud worker profiles for disposable remote environments. When this section is omitted or has no profiles, cloud worker creation remains unavailable and existing gateway/node status behavior is unchanged.",
  "cloudWorkers.profiles":
    "Named cloud worker profiles. Each profile selects a worker provider registered by a plugin and carries provider-owned settings.",
  "cloudWorkers.profiles.*":
    "One cloud worker profile selected by name when creating an environment. Keep provider credentials in supported references rather than embedding secret material in this block.",
  "cloudWorkers.profiles.*.provider":
    "Worker provider id registered by a plugin. The configured plugin must expose this id before the gateway can provision environments from the profile.",
  "cloudWorkers.profiles.*.install":
    'Worker installation method: "bundle" (default) transfers the gateway\'s content-hashed installed build and supports released, development, and unreleased versions; "npm" installs the exact gateway version and is available only when that version is released.',
  "cloudWorkers.profiles.*.settings":
    "Provider-owned settings validated by the selected plugin. Use SecretRef objects for secret-bearing values; opaque settings do not gain automatic secret resolution.",
  gateway:
    "Gateway runtime surface for bind mode, auth, control UI, remote transport, and operational safety controls. Keep conservative defaults unless you intentionally expose the gateway beyond trusted local interfaces.",
  "gateway.port":
    "TCP port used by the gateway listener for API, control UI, and channel-facing ingress paths. Use a dedicated port and avoid collisions with reverse proxies or local developer services.",
  "gateway.mode":
    'Gateway operation mode: "local" runs channels and agent runtime on this host, while "remote" connects through remote transport. Keep "local" unless you intentionally run a split remote gateway topology.',
  "gateway.bind":
    'Network bind profile: "auto", "lan", "loopback", "custom", or "tailnet" to control interface exposure. Keep "loopback" for local-only operation; "auto" can expose all interfaces.',
  "gateway.customBindHost":
    "IPv4 address used for a custom bind. Specific IPv4s also require the same Gateway port on 127.0.0.1; avoid 0.0.0.0 unless all-interface exposure is required.",
  "gateway.controlUi":
    "Control UI hosting settings including enablement, pathing, and browser-origin/auth hardening behavior. Keep UI exposure minimal and pair with strong auth controls before internet-facing deployments.",
  "gateway.controlUi.enabled":
    "Enables serving the gateway Control UI from the gateway HTTP process when true. Keep enabled for local administration, and disable when an external control surface replaces it.",
  "gateway.terminal":
    "Operator terminal served to Control UI and mobile clients: a PTY-backed shell on the gateway host, restricted to admin-scope operator sessions. It starts in the target agent's workspace and is refused for fully-sandboxed agents (sandbox.mode 'all') rather than handing back an unconfined host shell.",
  "gateway.terminal.enabled":
    "Enables the operator terminal for admin-scope clients when true (default: false). This exposes a browser/mobile shell with the gateway process environment, so enable it only for trusted operator deployments. Changing this restarts the gateway so connected clients reload with the correct terminal availability and content-security policy.",
  "gateway.terminal.shell":
    "Shell executable the operator terminal launches. Leave unset to use the host login shell ($SHELL on Unix, %ComSpec% on Windows), or pin an explicit interpreter for a consistent operator environment.",
  "gateway.terminal.detachedSessionTimeoutSeconds":
    "Seconds a terminal session survives after its connection drops (laptop sleep, page reload), staying reattachable via terminal.attach with its recent output replayed. Set 0 to kill sessions the moment the connection drops. Default: 300 (5 minutes). Detached sessions keep running their commands, so shorten this on shared or exposed hosts.",
  "gateway.auth":
    "Authentication policy for gateway HTTP/WebSocket access including mode, credentials, trusted-proxy behavior, and rate limiting. Keep auth enabled for every non-loopback deployment.",
  "gateway.auth.mode":
    'Gateway auth mode: "none", "token", "password", or "trusted-proxy" depending on your edge architecture. Use token/password for direct exposure, and trusted-proxy only behind hardened identity-aware proxies.',
  "gateway.auth.allowTailscale":
    "Allows trusted Tailscale identity paths to satisfy gateway auth checks when configured. Use this only when your tailnet identity posture is strong and operator workflows depend on it.",
  "gateway.auth.rateLimit":
    "Login/auth attempt throttling controls to reduce credential brute-force risk at the gateway boundary. Keep enabled in exposed environments and tune thresholds to your traffic baseline.",
  "gateway.auth.trustedProxy":
    "Trusted-proxy auth header mapping for upstream identity providers that inject user claims. Use only with known proxy CIDRs and strict header allowlists to prevent spoofed identity headers.",
  "gateway.auth.trustedProxy.deviceAutoApprove":
    "Optional policy for automatically approving new Control UI and WebChat device identities after trusted-proxy authentication. Existing-device scope upgrades always remain manual.",
  "gateway.auth.trustedProxy.deviceAutoApprove.enabled":
    "Automatically approves new browser device identities after the reverse proxy authenticates an allowed user. Default: false. Enable only when the proxy identity boundary is strong enough to replace manual device pairing.",
  "gateway.auth.trustedProxy.deviceAutoApprove.scopes":
    "Maximum scopes granted to auto-approved browser devices. Requested scopes are capped to this list; requests without scopes receive this list. Explicitly listing operator.admin lets every proxy-authenticated user auto-approve full admin and makes scope-less requests receive full admin automatically; it also triggers a critical security audit finding and Gateway startup warning.",
  "gateway.trustedProxies":
    "CIDR/IP allowlist of upstream proxies permitted to provide forwarded client identity headers. Keep this list narrow so untrusted hops cannot impersonate users.",
  "gateway.allowRealIpFallback":
    "Enables x-real-ip fallback when x-forwarded-for is missing in proxy scenarios. Keep disabled unless your ingress stack requires this compatibility behavior.",
  "gateway.tools":
    "Gateway-level tool exposure allow/deny policy that can restrict runtime tool availability independent of agent/tool profiles. Use this for coarse emergency controls and production hardening.",
  "gateway.tools.allow":
    "Explicit gateway-level tool allowlist when you want a narrow set of tools available at runtime. Use this for locked-down environments where tool scope must be tightly controlled.",
  "gateway.tools.deny":
    "Explicit gateway-level tool denylist to block risky tools even if lower-level policies allow them. Use deny rules for emergency response and defense-in-depth hardening.",
  "gateway.tailscale":
    "Tailscale integration settings for Serve/Funnel exposure and lifecycle handling on gateway start/exit. Keep off unless your deployment intentionally relies on Tailscale ingress.",
  "gateway.tailscale.mode":
    'Tailscale publish mode: "off", "serve", or "funnel" for private or public exposure paths. Use "serve" for tailnet-only access and "funnel" only when public internet reachability is required.',
  "gateway.tailscale.resetOnExit":
    "Resets Tailscale Serve/Funnel state on gateway exit to avoid stale published routes after shutdown. Keep enabled unless another controller manages publish lifecycle outside the gateway.",
  "gateway.tailscale.serviceName":
    'Optional Tailscale Service name for Serve mode, such as "svc:openclaw". The value must use Tailscale\'s svc:<dns-label> format. When set, OpenClaw passes it to tailscale serve --service and reports the derived Service URL.',
  "gateway.tailscale.preserveFunnel":
    "When mode='serve' and an externally configured Tailscale Funnel route already covers the gateway port, skip re-applying tailscale serve on startup. Lets operators keep Funnel exposure managed outside OpenClaw without losing it across gateway restarts.",
  "gateway.remote":
    "Remote gateway connection settings for direct or SSH transport when this instance proxies to another runtime host. Use remote mode only when split-host operation is intentionally configured.",
  "gateway.remote.transport":
    'Remote connection transport: "direct" uses configured URL connectivity, while "ssh" tunnels through SSH. Use SSH when you need encrypted tunnel semantics without exposing remote ports.',
  "gateway.reload":
    "Live config-reload policy for how edits are applied and when full restarts are triggered. Keep hybrid behavior for safest operational updates unless debugging reload internals.",
  "gateway.tls":
    "TLS certificate and key settings for terminating HTTPS directly in the gateway process. Use explicit certificates in production and avoid plaintext exposure on untrusted networks.",
  "gateway.tls.enabled":
    "Enables TLS termination at the gateway listener so clients connect over HTTPS/WSS directly. Keep enabled for direct internet exposure or any untrusted network boundary.",
  "gateway.tls.autoGenerate":
    "Auto-generates a local TLS certificate/key pair when explicit files are not configured. Use only for local/dev setups and replace with real certificates for production traffic.",
  "gateway.tls.certPath":
    "Filesystem path to the TLS certificate file used by the gateway when TLS is enabled. Use managed certificate paths and keep renewal automation aligned with this location.",
  "gateway.tls.keyPath":
    "Filesystem path to the TLS private key file used by the gateway when TLS is enabled. Keep this key file permission-restricted and rotate per your security policy.",
  "gateway.tls.caPath":
    "Optional CA bundle path for client verification or custom trust-chain requirements at the gateway edge. Use this when private PKI or custom certificate chains are part of deployment.",
  "gateway.http":
    "Gateway HTTP API configuration grouping endpoint toggles and transport-facing API exposure controls. Keep only required endpoints enabled to reduce attack surface.",
  "gateway.http.endpoints":
    "HTTP endpoint feature toggles under the gateway API surface for compatibility routes and optional integrations. Enable endpoints intentionally and monitor access patterns after rollout.",
  "gateway.http.securityHeaders":
    "Optional HTTP response security headers applied by the gateway process itself. Prefer setting these at your reverse proxy when TLS terminates there.",
  "gateway.http.securityHeaders.strictTransportSecurity":
    "Value for the Strict-Transport-Security response header. Set only on HTTPS origins that you fully control; use false to explicitly disable.",
  "gateway.remote.url": "Remote Gateway WebSocket URL (ws:// or wss://).",
  "gateway.remote.token":
    "Bearer token used to authenticate this client to a remote gateway in token-auth deployments. Store via secret/env substitution and rotate alongside remote gateway auth changes.",
  "gateway.remote.password":
    "Password credential used for remote gateway authentication when password mode is enabled. Keep this secret managed externally and avoid plaintext values in committed config.",
  "gateway.remote.tlsFingerprint":
    "Expected sha256 TLS fingerprint for the remote gateway (pin to avoid MITM).",
  "gateway.remote.sshTarget":
    "Remote gateway over SSH (tunnels the gateway port to localhost). Format: user@host or user@host:port.",
  "gateway.remote.sshIdentity": "Optional SSH identity file path (passed to ssh -i).",
  "gateway.remote.sshHostKeyPolicy":
    'macOS SSH host-key verification policy. "strict" requires an already trusted host key; "openssh" explicitly delegates to effective OpenSSH configuration.',
  "talk.provider": 'Active Talk provider id (for example "acme-speech").',
  "talk.providers":
    "Provider-specific Talk settings keyed by provider id. During migration, prefer this over legacy talk.* keys.",
  "talk.providers.*": "Provider-owned Talk config fields for the matching provider id.",
  "talk.providers.*.apiKey": "Provider API key for Talk mode.", // pragma: allowlist secret
  "talk.realtime":
    "Realtime Talk provider, model, voice, mode, transport, and brain strategy. Keep speech/TTS provider config in talk.provider and talk.providers.",
  "talk.realtime.provider": "Active realtime voice provider id, such as openai or google.",
  "talk.realtime.providers": "Provider-specific realtime voice settings keyed by provider id.",
  "talk.realtime.providers.*": "Provider-owned realtime voice config for the matching provider id.",
  "talk.realtime.providers.*.apiKey": "Provider API key for realtime Talk.", // pragma: allowlist secret
  "talk.realtime.model":
    "Realtime provider model id override for browser or Gateway-owned Talk sessions.",
  "talk.realtime.speakerVoice":
    "Realtime provider speaker voice name override for browser or Gateway-owned Talk sessions.",
  "talk.realtime.speakerVoiceId":
    "Realtime provider speaker voice id override for browser or Gateway-owned Talk sessions.",
  "talk.realtime.instructions":
    "Additional system instructions appended to OpenClaw's built-in realtime Talk prompt. Use this for voice style, tone, and other provider-facing realtime behavior while keeping agent-consult guidance intact.",
  "talk.realtime.mode": "Talk execution mode: realtime, stt-tts, or transcription.",
  "talk.realtime.transport":
    "Talk byte/session transport: webrtc, provider-websocket, gateway-relay, or managed-room.",
  "talk.realtime.vadThreshold":
    "Realtime voice activity detection threshold from 0 (most sensitive) to 1 (least sensitive).",
  "talk.realtime.silenceDurationMs":
    "Milliseconds of silence before a realtime Talk user turn is committed.",
  "talk.realtime.prefixPaddingMs":
    "Milliseconds of audio retained before realtime voice activity is detected.",
  "talk.realtime.reasoningEffort":
    "Provider-specific reasoning effort for realtime Talk sessions, such as minimal, low, medium, or high.",
  "talk.realtime.brain":
    "Talk reasoning strategy: agent-consult for Gateway-mediated agent help, direct-tools for local tool calls, or none.",
  "talk.realtime.consultRouting":
    "Gateway relay fallback for final user transcripts when the realtime provider skips openclaw_agent_consult. provider-direct preserves provider replies; force-agent-consult routes through OpenClaw.",
  "talk.consultThinkingLevel":
    "Use this to override the thinking level for the regular agent run behind Talk realtime consults.",
  "talk.consultFastMode":
    "Use this to set true or false fast mode for the regular agent run behind Talk realtime consults.",
  "talk.speechLocale":
    'BCP 47 locale id for Talk speech recognition on device nodes, for example "ru-RU". Leave unset to use each device default.',
  "talk.interruptOnSpeech":
    "If true (default), stop assistant speech when the user starts speaking in Talk mode. Keep enabled for conversational turn-taking.",
  "talk.silenceTimeoutMs": `Milliseconds of user silence before Talk mode finalizes and sends the current transcript. Leave unset to keep the platform default pause window (${describeTalkSilenceTimeoutDefaults()}).`,
  acp: "ACP runtime controls for enabling dispatch, selecting backends, constraining allowed agent targets, and selecting streamed turn projection behavior.",
  "acp.enabled":
    "Global ACP feature gate. Keep disabled unless ACP runtime + policy are configured.",
  "acp.dispatch.enabled":
    "Independent dispatch gate for ACP session turns (default: true). Set false to keep ACP commands available while blocking ACP turn execution.",
  "acp.backend":
    "Default ACP runtime backend id (for example: acpx). Must match a registered ACP runtime plugin backend.",
  "acp.fallbacks":
    "Ordered list of fallback ACP backend ids tried when the primary backend fails with UNAVAILABLE (for example: rate-limit / quota exhausted). Each entry must match a registered ACP runtime plugin backend.",
  "acp.defaultAgent":
    "Fallback ACP target agent id used when ACP spawns do not specify an explicit target.",
  "acp.allowedAgents":
    "Allowlist of ACP target agent ids permitted for ACP runtime sessions. Empty means no additional allowlist restriction.",
  "acp.stream":
    "ACP streaming projection controls for chunk sizing, metadata visibility, and deduped delivery behavior.",
  "acp.stream.repeatSuppression":
    "When true (default), suppress repeated ACP status/tool projection lines in a turn while keeping raw ACP events unchanged.",
  "acp.stream.deliveryMode":
    "ACP delivery style: live streams projected output incrementally, final_only buffers all projected ACP output until terminal turn events.",
  "acp.stream.tagVisibility":
    "Per-sessionUpdate visibility overrides for ACP projection (for example usage_update, available_commands_update).",
  "acp.runtime.installCommand":
    "Optional operator install/setup command shown by `/acp install` and `/acp doctor` when ACP backend wiring is missing.",
  surfaces:
    "Per-surface message policy overrides keyed by the resolved delivery surface id. Use this only when one deployed surface needs stricter silent-reply handling than the agent default.",
  "surfaces.*.silentReply":
    "Overrides silent-reply policy for one resolved delivery surface. Unset fields inherit agents.defaults.silentReply; use narrow surface ids so internal or group-specific behavior does not spill into other destinations.",
  "agents.entries.*.skills":
    "Optional allowlist of skills for this agent. If omitted, the agent inherits agents.defaults.skills when set; otherwise skills stay unrestricted. Set [] for no skills. An explicit list fully replaces inherited defaults instead of merging with them.",
  agents:
    "Agent runtime configuration root. Root siblings own infrastructure and cross-agent defaults; agents.defaults owns agent-loop behavior; agent entries may override either where supported.",
  "agents.defaults":
    "Shared default settings inherited by agents unless overridden per entry in agents.entries. Use defaults to enforce consistent baseline behavior and reduce duplicated per-agent configuration.",
  "agents.defaults.skills":
    "Optional default skill allowlist inherited by agents that omit agents.entries.*.skills. Omit for unrestricted skills, set [] to give inheriting agents no skills, and remember explicit agents.entries.*.skills replaces this default instead of merging with it.",
  "agents.defaults.subagents.delegationMode":
    'Prompt-only sub-agent delegation strength. "suggest" keeps the default guidance; "prefer" strongly instructs the main agent to delegate anything more involved than a direct reply via sessions_spawn.',
  "agents.entries.*.subagents.delegationMode":
    "Per-agent override for sub-agent delegation strength. Use this for coordinator agents that should stay responsive and push non-trivial work into spawned sub-agents.",
  "agents.entries.*.contextInjection":
    "Per-agent override for when workspace bootstrap files are injected into this agent's system prompt. Omit to inherit agents.defaults.contextInjection.",
  "agents.entries.*.bootstrapMaxChars":
    "Per-agent override for max characters of each workspace bootstrap file injected into this agent's system prompt. Omit to inherit agents.defaults.bootstrapMaxChars.",
  "agents.entries.*.bootstrapTotalMaxChars":
    "Per-agent override for max total characters across all workspace bootstrap files injected into this agent's system prompt. Omit to inherit agents.defaults.bootstrapTotalMaxChars.",
  "agents.entries.*.experimental":
    "Per-agent experimental flags. Omitted fields inherit agents.defaults.experimental.",
  "agents.entries.*.experimental.localModelLean":
    "Per-agent override for lean local-model mode. Enable it for one smaller local-model agent without trimming tools from every agent.",
  "agents.defaults.contextLimits":
    "Focused per-agent-context budget defaults for selected high-volume excerpts and injected prompt blocks. Use this to tune bounded read/injection sizes without reopening any unbounded call paths.",
  "agents.defaults.contextLimits.memoryGetMaxChars":
    "Default max characters returned by memory_get before truncation metadata and continuation notice are added. Increase to approximate older larger excerpts, but keep it bounded.",
  "agents.defaults.contextLimits.postCompactionMaxChars":
    "Default max characters retained from AGENTS.md during post-compaction context refresh injection. Lower this to make compaction recovery cheaper, or raise it for agents that depend on longer startup guidance.",
  "agents.entries":
    "Explicit list of configured agents with IDs and optional overrides for model, tools, identity, and workspace. Keep IDs stable over time so bindings, approvals, and session routing remain deterministic.",
  "agents.entries.*.skillsLimits":
    "Optional per-agent overrides for skills subsystem budgets. Use this when an agent needs a different skills prompt budget without introducing a second generic context-limits path.",
  "agents.entries.*.skillsLimits.maxSkillsPromptChars":
    "Per-agent override for the skills prompt character budget. This extends the existing skills.limits.maxSkillsPromptChars path instead of routing the same budget through contextLimits.",
  "agents.entries.*.contextLimits":
    "Optional per-agent overrides for the focused context budget knobs. Omitted fields inherit agents.defaults.contextLimits.",
  "agents.entries.*.contextLimits.memoryGetMaxChars":
    "Per-agent override for the default memory_get max character budget.",
  "agents.entries.*.contextLimits.postCompactionMaxChars":
    "Per-agent override for the post-compaction AGENTS.md excerpt budget.",
  "agents.entries.*.thinkingDefault":
    "Optional per-agent default thinking level. Overrides agents.defaults.thinkingDefault for this agent when no per-message or session override is set.",
  "agents.entries.*.reasoningDefault":
    "Optional per-agent default reasoning visibility (on|off|stream). Applies when no per-message or session reasoning override is set.",
  "agents.entries.*.fastModeDefault":
    'Optional per-agent default for fast mode ("auto", true, or false). Applies when no per-message or session fast-mode override is set.',
  "agents.defaults.fastModeDefault":
    'Default fast-mode policy for the agent loop ("auto", true, or false). Individual agent entries override it.',
  "agents.entries.*.runtime":
    "Optional runtime descriptor for this agent. Use embedded for default OpenClaw execution or acp for external ACP harness defaults.",
  "agents.entries.*.runtime.type":
    'Runtime type for this agent: "embedded" (default OpenClaw runtime) or "acp" (ACP harness defaults).',
  "agents.entries.*.runtime.acp":
    "ACP runtime defaults for this agent when runtime.type=acp. Binding-level ACP overrides still take precedence per conversation.",
  "agents.entries.*.runtime.acp.agent":
    "Optional ACP harness agent id to use for this OpenClaw agent (for example codex, claude, cursor, gemini, openclaw).",
  "agents.entries.*.runtime.acp.backend":
    "Optional ACP backend override for this agent's ACP sessions (falls back to global acp.backend).",
  "agents.entries.*.runtime.acp.mode":
    "Optional ACP session mode default for this agent (persistent or oneshot).",
  "agents.entries.*.runtime.acp.cwd":
    "Optional default working directory for this agent's ACP sessions.",
  "agents.entries.*.identity.avatar":
    "Avatar image path (relative to the agent workspace only) or a remote URL/data URL.",
  "agents.defaults.heartbeat.timeoutSeconds":
    "Maximum time in seconds allowed for a heartbeat agent turn before it is aborted. Leave unset to use agents.defaults.timeoutSeconds when set, otherwise the heartbeat cadence capped at 600 seconds.",
  "agents.entries.*.heartbeat.timeoutSeconds":
    "Per-agent maximum time in seconds allowed for a heartbeat agent turn before it is aborted. Leave unset to inherit the merged heartbeat timeout, then agents.defaults.timeoutSeconds when set, otherwise the heartbeat cadence capped at 600 seconds.",
};
