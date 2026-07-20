// Defines gateway runtime and networking configuration types.
import type { SecretInput } from "./types.secrets.js";

/** Gateway bind-address policy for local server startup. */
export type GatewayBindMode = "auto" | "lan" | "loopback" | "custom" | "tailnet";

export type GatewayTlsConfig = {
  /** Enable TLS for the gateway server. */
  enabled?: boolean;
  /** Auto-generate a self-signed cert if cert/key are missing (default: true). */
  autoGenerate?: boolean;
  /** PEM certificate path for the gateway server. */
  certPath?: string;
  /** PEM private key path for the gateway server. */
  keyPath?: string;
  /** Optional PEM CA bundle for TLS clients (mTLS or custom roots). */
  caPath?: string;
};

export type WideAreaDiscoveryConfig = {
  /** Enable DNS-SD style wide-area discovery. */
  enabled?: boolean;
  /** Optional unicast DNS-SD domain (e.g. "openclaw.internal"). */
  domain?: string;
};

/** mDNS/Bonjour metadata exposure level for local gateway discovery. */
export type MdnsDiscoveryMode = "off" | "minimal" | "full";

export type MdnsDiscoveryConfig = {
  /**
   * mDNS/Bonjour discovery broadcast mode (default: minimal).
   * - off: disable mDNS entirely
   * - minimal: omit cliPath/sshPort from TXT records
   * - full: include cliPath/sshPort in TXT records
   */
  mode?: MdnsDiscoveryMode;
};

export type DiscoveryConfig = {
  /** Wide-area DNS-SD discovery settings. */
  wideArea?: WideAreaDiscoveryConfig;
  /** Local mDNS/Bonjour discovery settings. */
  mdns?: MdnsDiscoveryConfig;
};

export type TalkProviderConfig = {
  /** Provider API key (optional; provider-specific env fallback may apply). */
  apiKey?: SecretInput;
  /** Provider-owned Talk config fields. */
  [key: string]: unknown;
};

export type TalkRealtimeConfig = {
  /** Active realtime voice provider. */
  provider?: string;
  /** Provider-specific realtime voice config keyed by provider id. */
  providers?: Record<string, TalkProviderConfig>;
  /** Provider model override for realtime sessions. */
  model?: string;
  /** Provider speaker voice name override for realtime sessions. */
  speakerVoice?: string;
  /** Provider speaker voice id override for realtime sessions. */
  speakerVoiceId?: string;
  /** Additional system instructions appended to realtime Talk sessions. */
  instructions?: string;
  /** Realtime execution mode. */
  mode?: "realtime" | "stt-tts" | "transcription";
  /** Byte/session transport. */
  transport?: "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room";
  /** Voice activity detection threshold from 0 (most sensitive) to 1 (least sensitive). */
  vadThreshold?: number;
  /** Milliseconds of silence before the current user turn is committed. */
  silenceDurationMs?: number;
  /** Milliseconds of audio retained before detected speech begins. */
  prefixPaddingMs?: number;
  /** Provider-specific realtime reasoning effort. */
  reasoningEffort?: string;
  /** Tool/agent strategy for realtime sessions. */
  brain?: "agent-consult" | "direct-tools" | "none";
  /** How Gateway relay handles final user transcripts when the provider skips a consult. */
  consultRouting?: "provider-direct" | "force-agent-consult";
};

export type ResolvedTalkConfig = {
  /** Active Talk TTS provider resolved from the current config payload. */
  provider: string;
  /** Provider config for the active Talk provider. */
  config: TalkProviderConfig;
};

export type TalkConfig = {
  /** Active Talk TTS provider (for example "acme-speech"). */
  provider?: string;
  /** Provider-specific Talk config keyed by provider id. */
  providers?: Record<string, TalkProviderConfig>;
  /** Realtime Talk provider, model, voice, mode, transport, and brain config. */
  realtime?: TalkRealtimeConfig;
  /** Optional thinking level override for the agent run behind Talk realtime consults. */
  consultThinkingLevel?:
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "adaptive"
    | "max"
    | "ultra";
  /** Optional fast mode override for the agent run behind Talk realtime consults. */
  consultFastMode?: boolean;
  /** BCP 47 locale id used for Talk speech recognition on device nodes. */
  speechLocale?: string;
  /** Stop speaking when user starts talking (default: true). */
  interruptOnSpeech?: boolean;
  /** Milliseconds of user silence before Talk mode sends the transcript after a pause. */
  silenceTimeoutMs?: number;
};

export type TalkConfigResponse = TalkConfig & {
  /** Canonical active Talk payload for clients. */
  resolved?: ResolvedTalkConfig;
};

export type GatewayControlUiConfig = {
  /** If false, the Gateway will not serve the Control UI (default /). */
  enabled?: boolean;
  /** Optional base path prefix for the Control UI (e.g. "/openclaw"). */
  basePath?: string;
  /** Optional filesystem root for Control UI assets (defaults to dist/control-ui). */
  root?: string;
  /**
   * Opt-in AI purpose titles for tool calls in Control UI chat (default false).
   * When enabled, chat.toolTitles generates short titles through standard
   * utility-model routing and caches them per agent.
   */
  toolTitles?: boolean;
  /**
   * Embed sandbox mode for hosted Control UI previews.
   * - strict: no script execution inside embeds
   * - scripts: allow scripts while keeping embeds origin-isolated (default)
   * - trusted: allow scripts and same-origin privileges
   */
  embedSandbox?: "strict" | "scripts" | "trusted";
  /**
   * DANGEROUS: Allow hosted embeds to load absolute external http(s) URLs.
   * Default off; prefer hosted /__openclaw__/canvas or /__openclaw__/a2ui content.
   */
  allowExternalEmbedUrls?: boolean;
  /** Optional max-width for grouped Control UI chat messages (default: min(900px, 68%)). */
  chatMessageMaxWidth?: string;
  /** Allowed browser origins for Control UI/WebChat websocket connections. */
  allowedOrigins?: string[];
  /**
   * DANGEROUS: Keep Host-header origin fallback behavior.
   * Supported long-term for deployments that intentionally rely on this policy.
   */
  dangerouslyAllowHostHeaderOriginFallback?: boolean;
  /**
   * Insecure-auth toggle.
   * Control UI still requires secure context + device identity unless
   * dangerouslyDisableDeviceAuth is enabled.
   */
  allowInsecureAuth?: boolean;
  /** DANGEROUS: Disable device identity checks for the Control UI (default: false). */
  dangerouslyDisableDeviceAuth?: boolean;
};

/** Gateway authentication strategy for WebSocket and HTTP clients. */
export type GatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";

/**
 * Configuration for trusted reverse proxy authentication.
 * Used when Clawdbot runs behind an identity-aware proxy (Pomerium, Caddy + OAuth, etc.)
 * that handles authentication and passes user identity via headers.
 */
export type GatewayTrustedProxyConfig = {
  /**
   * Header name containing the authenticated user identity (required).
   * Common values: "x-forwarded-user", "x-remote-user", "x-pomerium-claim-email"
   */
  userHeader: string;
  /**
   * Additional headers that MUST be present for the request to be trusted.
   * Use this to verify the request actually came through the proxy.
   * Example: ["x-forwarded-proto", "x-forwarded-host"]
   */
  requiredHeaders?: string[];
  /**
   * Optional allowlist of user identities that can access the gateway.
   * If empty or omitted, all authenticated users from the proxy are allowed.
   * Example: ["nick@example.com", "admin@company.org"]
   */
  allowUsers?: string[];
  /**
   * Allow loopback proxy sources (127.0.0.1, ::1) in trusted-proxy mode.
   * Default false; enable only when a same-host reverse proxy is the intended
   * trust boundary and direct Gateway access is otherwise locked down.
   */
  allowLoopback?: boolean;
  /**
   * Automatically approve new browser device identities after trusted-proxy
   * authentication. Disabled by default; existing-device upgrades stay manual.
   */
  deviceAutoApprove?: {
    /** Enable automatic approval for new browser devices. @default false */
    enabled?: boolean;
    /**
     * Maximum operator scopes granted by automatic approval. Listing
     * operator.admin explicitly lets every proxy-authenticated user request
     * automatic full-admin device grants. Requests without scopes receive the
     * configured maximum. @default operator.read, operator.write,
     * operator.approvals
     */
    scopes?: string[];
  };
};

export type GatewayAuthConfig = {
  /** Authentication mode for Gateway connections. Defaults to token when unset. */
  mode?: GatewayAuthMode;
  /** Shared token for token mode (plaintext or SecretRef). */
  token?: SecretInput;
  /** Shared password for password mode (consider env instead). */
  password?: SecretInput;
  /** Allow Tailscale identity headers when serve mode is enabled. */
  allowTailscale?: boolean;
  /** Rate-limit configuration for failed authentication attempts. */
  rateLimit?: GatewayAuthRateLimitConfig;
  /**
   * Configuration for trusted-proxy auth mode.
   * Required when mode is "trusted-proxy".
   */
  trustedProxy?: GatewayTrustedProxyConfig;
};

export type GatewayAuthRateLimitConfig = {
  /** Maximum failed attempts per IP before blocking.  @default 10 */
  maxAttempts?: number;
  /** Sliding window duration in milliseconds.  @default 60000 (1 min) */
  windowMs?: number;
  /** Lockout duration in milliseconds after the limit is exceeded.  @default 300000 (5 min) */
  lockoutMs?: number;
  /** Exempt localhost/loopback addresses from auth rate limiting.  @default true */
  exemptLoopback?: boolean;
};

/** Tailscale exposure mode for gateway HTTP/WebSocket surfaces. */
export type GatewayTailscaleMode = "off" | "serve" | "funnel";

export type GatewayTailscaleConfig = {
  /** Tailscale exposure mode for the Gateway control UI. */
  mode?: GatewayTailscaleMode;
  /** Reset serve/funnel configuration on shutdown. */
  resetOnExit?: boolean;
  /** Optional Tailscale Service name, such as `svc:openclaw`, for Serve mode. */
  serviceName?: string;
  /**
   * When `mode="serve"` and an externally configured Tailscale Funnel route
   * already covers the gateway port, skip re-applying `tailscale serve` on
   * startup. Lets operators manage Funnel exposure outside OpenClaw without
   * losing it across gateway restarts.
   */
  preserveFunnel?: boolean;
};

export type GatewayRemoteConfig = {
  /** Remote Gateway WebSocket URL (ws:// or wss://). */
  url?: string;
  /** Transport for macOS remote connections (ssh tunnel or direct WS). */
  transport?: "ssh" | "direct";
  /** Gateway port on the remote SSH host. Defaults to 18789. */
  remotePort?: number;
  /** Token for remote auth (when the gateway requires token auth). */
  token?: SecretInput;
  /** Password for remote auth (when the gateway requires password auth). */
  password?: SecretInput;
  /** Expected TLS certificate fingerprint (sha256) for remote gateways. */
  tlsFingerprint?: string;
  /** SSH target for tunneling remote Gateway (user@host). */
  sshTarget?: string;
  /** SSH identity file path for tunneling remote Gateway. */
  sshIdentity?: string;
  /** macOS SSH host-key policy. Defaults to strict; openssh delegates to effective SSH config. */
  sshHostKeyPolicy?: "strict" | "openssh";
};

/**
 * Operator terminal surface served to Control UI and mobile clients.
 *
 * The terminal opens a PTY-backed shell on the gateway host, gated to
 * admin-scope operator sessions. It starts in the target agent's workspace; if
 * that agent is fully sandboxed (`sandbox.mode: "all"`) the terminal is refused
 * rather than handed an unconfined host shell (workspace isolation is
 * fail-closed). Under "non-main" the agent's main session runs on the host, so a
 * host terminal is allowed.
 */
export type GatewayTerminalConfig = {
  /** Master switch for the operator terminal. Default: false. */
  enabled?: boolean;
  /**
   * Shell executable to launch. When unset the host login shell is used
   * ($SHELL on Unix, %ComSpec% on Windows).
   */
  shell?: string;
  /**
   * How long (seconds) a session survives after its connection drops, staying
   * reattachable via terminal.attach. 0 kills sessions on disconnect
   * immediately. Default: 300.
   */
  detachedSessionTimeoutSeconds?: number;
};

/** Gateway config reload strategy for managed installs. */
export type GatewayReloadMode = "off" | "restart" | "hot" | "hybrid";

export type GatewayReloadConfig = {
  /** Reload strategy for config changes (default: hybrid). */
  mode?: GatewayReloadMode;
};

export type GatewayHttpChatCompletionsConfig = {
  /**
   * If false, the Gateway will not serve `POST /v1/chat/completions`.
   * Default: false when absent.
   */
  enabled?: boolean;
  /** Image input controls for `image_url` parts. */
  images?: GatewayHttpChatCompletionsImagesConfig;
};

export type GatewayHttpChatCompletionsImagesConfig = {
  /** Allow URL fetches for `image_url` parts. Default: false. */
  allowUrl?: boolean;
  /**
   * Optional hostname allowlist for URL fetches.
   * Supports exact hosts and `*.example.com` wildcards.
   */
  urlAllowlist?: string[];
  /** Allowed MIME types (case-insensitive). */
  allowedMimes?: string[];
  /** Max bytes per image. Default: 10MB. */
  maxBytes?: number;
  /** Max redirects when fetching a URL. Default: 3. */
  maxRedirects?: number;
  /** Fetch timeout in ms. Default: 10s. */
  timeoutMs?: number;
};

export type GatewayHttpResponsesConfig = {
  /**
   * If false, the Gateway will not serve `POST /v1/responses` (OpenResponses API).
   * Default: false when absent.
   */
  enabled?: boolean;
  /**
   * Max number of URL-based `input_file` + `input_image` parts per request.
   * Default: 8.
   */
  maxUrlParts?: number;
  /** File inputs (input_file). */
  files?: GatewayHttpResponsesFilesConfig;
  /** Image inputs (input_image). */
  images?: GatewayHttpResponsesImagesConfig;
};

export type GatewayHttpResponsesFilesConfig = {
  /** Allow URL fetches for input_file. Default: true. */
  allowUrl?: boolean;
  /**
   * Optional hostname allowlist for URL fetches.
   * Supports exact hosts and `*.example.com` wildcards.
   */
  urlAllowlist?: string[];
  /** Allowed MIME types (case-insensitive). */
  allowedMimes?: string[];
  /** Max bytes per file. Default: 5MB. */
  maxBytes?: number;
  /** Max decoded characters per file. Default: 200k. */
  maxChars?: number;
  /** Max redirects when fetching a URL. Default: 3. */
  maxRedirects?: number;
  /** Fetch timeout in ms. Default: 10s. */
  timeoutMs?: number;
  /** PDF handling (application/pdf). */
  pdf?: GatewayHttpResponsesPdfConfig;
};

export type GatewayHttpResponsesPdfConfig = {
  /** Max pages to parse/render. Default: 4. */
  maxPages?: number;
  /** Max pixels per rendered page. Default: 4M. */
  maxPixels?: number;
  /** Minimum extracted text length to skip rasterization. Default: 200 chars. */
  minTextChars?: number;
};

export type GatewayHttpResponsesImagesConfig = {
  /** Allow URL fetches for input_image. Default: true. */
  allowUrl?: boolean;
  /**
   * Optional hostname allowlist for URL fetches.
   * Supports exact hosts and `*.example.com` wildcards.
   */
  urlAllowlist?: string[];
  /** Allowed MIME types (case-insensitive). */
  allowedMimes?: string[];
  /** Max bytes per image. Default: 10MB. */
  maxBytes?: number;
  /** Max redirects when fetching a URL. Default: 3. */
  maxRedirects?: number;
  /** Fetch timeout in ms. Default: 10s. */
  timeoutMs?: number;
};

export type GatewayHttpEndpointsConfig = {
  /** OpenAI-compatible chat completions endpoint controls. */
  chatCompletions?: GatewayHttpChatCompletionsConfig;
  /** OpenResponses-compatible responses endpoint controls. */
  responses?: GatewayHttpResponsesConfig;
};

export type GatewayHttpSecurityHeadersConfig = {
  /**
   * Value for the Strict-Transport-Security response header.
   * Set to false to disable explicitly.
   *
   * Example: "max-age=31536000; includeSubDomains"
   */
  strictTransportSecurity?: string | false;
};

export type GatewayHttpConfig = {
  /** Per-endpoint HTTP API controls. */
  endpoints?: GatewayHttpEndpointsConfig;
  /** HTTP security header overrides. */
  securityHeaders?: GatewayHttpSecurityHeadersConfig;
};

export type GatewayPushApnsRelayConfig = {
  /** Base HTTPS URL for the external iOS APNs relay service. */
  baseUrl?: string;
  /** Timeout in milliseconds for relay send requests (default: 10000). */
  timeoutMs?: number;
};

export type GatewayPushApnsConfig = {
  /** External APNs relay used by iOS/mobile notification flows. */
  relay?: GatewayPushApnsRelayConfig;
};

export type GatewayPushConfig = {
  /** Apple Push Notification Service settings. */
  apns?: GatewayPushApnsConfig;
};

export type GatewayNodePairingConfig = {
  /**
   * Opt-in CIDR/IP allowlist for auto-approving first-time node-role pairing.
   * Only applies to fresh node pairing requests with no requested scopes.
   * Default: unset/disabled.
   */
  autoApproveCidrs?: string[];
  /**
   * SSH-verified auto-approval for first-time node-role pairing (default: enabled).
   * The gateway connects back to the pairing host over SSH (BatchMode, strict
   * host keys) and approves only when the remote `openclaw node identity`
   * output matches the pending request's device key. Set false to disable SSH
   * verification; this is independent of autoApproveCidrs, so unset that too for
   * manual-only node pairing. The object form tunes the probe:
   * - user: remote user (default: gateway process user)
   * - identity: SSH identity file (default: standard SSH resolution)
   * - timeoutMs: probe timeout (default: 7000)
   * - cidrs: CIDRs/IPs eligible for probing (default: private/CGNAT ranges)
   */
  sshVerify?:
    | boolean
    | {
        user?: string;
        identity?: string;
        timeoutMs?: number;
        cidrs?: string[];
      };
};

export type GatewayNodesConfig = {
  /** Browser routing policy for node-hosted browser proxies. */
  browser?: {
    /** Routing mode (default: auto). */
    mode?: "auto" | "manual" | "off";
    /** Pin to a specific node id/name (optional). */
    node?: string;
  };
  /** Pairing policy for node-role gateway clients. */
  pairing?: GatewayNodePairingConfig;
  /** Controls whether paired nodes may publish agent-visible plugin tools (default: true). */
  pluginTools?: {
    /** Accept node-published plugin tool descriptors (default: true). */
    enabled?: boolean;
  };
  /** Controls whether paired nodes may publish agent-visible skills (default: true). */
  skills?: {
    /** Accept node-published skill descriptors (default: true). */
    enabled?: boolean;
  };
  /** Additional node.invoke commands to allow on the gateway. */
  allowCommands?: string[];
  /** Commands to deny even if they appear in the defaults or node claims. */
  denyCommands?: string[];
};

export type GatewayToolsConfig = {
  /** Tools to deny via gateway HTTP /tools/invoke (extends defaults). */
  deny?: string[];
  /** Tools to explicitly allow (removes from default deny list). */
  allow?: string[];
};

export type GatewayConfig = {
  /** Single multiplexed port for Gateway WS + HTTP (default: 18789). */
  port?: number;
  /**
   * Explicit gateway mode. When set to "remote", local gateway start is disabled.
   * When set to "local", the CLI may start the gateway locally.
   */
  mode?: "local" | "remote";
  /**
   * Bind address policy for the Gateway WebSocket + Control UI HTTP server.
   * - auto: Loopback (127.0.0.1) if available, else 0.0.0.0 (fallback to all interfaces)
   * - lan: 0.0.0.0 (all interfaces, no fallback, current BYOH path is IPv4-only)
   * - loopback: 127.0.0.1 (local-only)
   * - tailnet: Tailnet IPv4 plus 127.0.0.1 if available, else loopback only
   * - custom: User-specified IPv4 address (requires customBindHost); specific IPv4s also bind 127.0.0.1
   * IPv6-only BYOH is not natively supported on this path today. Use an IPv4 sidecar or proxy.
   * Default: loopback (127.0.0.1).
   */
  bind?: GatewayBindMode;
  /** Custom IPv4 address for bind="custom" mode. IPv6-only BYOH requires an IPv4 sidecar or proxy. */
  customBindHost?: string;
  controlUi?: GatewayControlUiConfig;
  terminal?: GatewayTerminalConfig;
  auth?: GatewayAuthConfig;
  tailscale?: GatewayTailscaleConfig;
  remote?: GatewayRemoteConfig;
  reload?: GatewayReloadConfig;
  tls?: GatewayTlsConfig;
  http?: GatewayHttpConfig;
  push?: GatewayPushConfig;
  nodes?: GatewayNodesConfig;
  /**
   * IPs of trusted reverse proxies (e.g. Traefik, nginx). When a connection
   * arrives from one of these IPs, the Gateway trusts `x-forwarded-for`
   * to determine the client IP for local pairing and HTTP checks.
   */
  trustedProxies?: string[];
  /**
   * Allow `x-real-ip` as a fallback only when `x-forwarded-for` is missing.
   * Default: false (safer fail-closed behavior).
   */
  allowRealIpFallback?: boolean;
  /** Tool access restrictions for HTTP /tools/invoke endpoint. */
  tools?: GatewayToolsConfig;
};
