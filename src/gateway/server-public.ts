import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { GatewayRestartEmitter } from "../infra/restart.js";
import type { GatewayTailscaleIngressEndpoint } from "./ingress-attribution.js";
import type { ChannelAutostartSuppression } from "./server-channels.js";
import type { GatewaySidecarStartupMode } from "./server-sidecar-startup-mode.js";

export type GatewayCloseOptions = {
  reason?: string;
  restartExpectedMs?: number | null;
  drainTimeoutMs?: number | null;
};

export type GatewayServer = {
  /** Process-local endpoint used by OpenClaw-managed Tailscale proxying. */
  getTailscaleIngressEndpoint: () => GatewayTailscaleIngressEndpoint | undefined;
  close: (opts?: GatewayCloseOptions) => Promise<void>;
  /**
   * Resolves when this generation finishes mandatory sidecar startup and rejects on failure.
   * Closing never forces settlement. Direct callers may safely ignore this pre-handled promise.
   */
  startupSettled: Promise<void>;
};

export type GatewayServerOptions = {
  /** Exact lifecycle generation projected to connected clients. */
  bootId?: string;
  /**
   * Bind address policy for the Gateway WebSocket/HTTP server.
   * - loopback: 127.0.0.1
   * - lan: 0.0.0.0
   * - tailnet: bind to the Tailscale IPv4 address (100.64.0.0/10) and local 127.0.0.1
   * - auto: prefer loopback, else LAN
   */
  bind?: import("../config/config.js").GatewayBindMode;
  /**
   * Advanced override for the bind host, bypassing bind resolution.
   * Prefer `bind` unless you really need a specific address.
   */
  host?: string;
  /**
   * If false, do not serve the browser Control UI.
   * Default: config `gateway.controlUi.enabled` (or true when absent).
   */
  controlUiEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/chat/completions`.
   * Default: config `gateway.http.endpoints.chatCompletions.enabled` (or false when absent).
   */
  openAiChatCompletionsEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/responses` (OpenResponses API).
   * Default: config `gateway.http.endpoints.responses.enabled` (or false when absent).
   */
  openResponsesEnabled?: boolean;
  /** Override gateway auth configuration (merges with config). */
  auth?: import("../config/config.js").GatewayAuthConfig;
  /** Override gateway Tailscale exposure configuration (merges with config). */
  tailscale?: import("../config/config.js").GatewayTailscaleConfig;
  /** Test-only: override the setup wizard runner. */
  wizardRunner?: import("./server-methods/wizard.js").SetupWizardRunner;
  /** Test-only: override the channel-setup wizard runner (wizard.start flow "channels"). */
  channelWizardRunner?: import("./server-methods/wizard.js").ChannelSetupWizardRunner;
  sidecarStartup?: GatewaySidecarStartupMode;
  channelAutostartSuppression?: ChannelAutostartSuppression;
  /** Internal lifecycle callback that re-proves and records crash-loop recovery. */
  tryRecoverChannelAutostartSuppression?: () => boolean;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
  /** Optional startup timestamp used for concise readiness logging. */
  startupStartedAt?: number;
  /**
   * Config snapshot already read by the CLI gateway preflight. Passing it avoids
   * reparsing openclaw.json during server startup.
   */
  startupConfigSnapshotRead?: import("../config/io.js").ReadConfigFileSnapshotWithPluginMetadataResult;
  /** Restart request override; direct servers fail closed on restart-required reloads. */
  hotReloadRecovery?: GatewayRestartEmitter;
};
