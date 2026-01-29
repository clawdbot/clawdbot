import type { ChannelId } from "../channels/plugins/types.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

export type OnboardMode = "local" | "remote";
export type AuthChoice =
  // Legacy alias for `setup-token` (kept for backwards CLI compatibility).
  | "oauth"
  | "setup-token"
  | "claude-cli"
  | "token"
  | "chutes"
  | "openai-codex"
  | "openai-api-key"
  | "openrouter-api-key"
  | "ai-gateway-api-key"
  | "moonshot-api-key"
  | "kimi-code-api-key"
  | "synthetic-api-key"
  | "venice-api-key"
  | "clarifai-api-key"
  | "codex-cli"
  | "apiKey"
  | "gemini-api-key"
  | "google-antigravity"
  | "google-gemini-cli"
  | "zai-api-key"
  | "minimax-cloud"
  | "minimax"
  | "minimax-api"
  | "minimax-api-lightning"
  | "opencode-zen"
  | "github-copilot"
  | "copilot-proxy"
  | "qwen-portal"
  | "skip";
export type GatewayAuthChoice = "token" | "password";
export type ResetScope = "config" | "config+creds+sessions" | "full";
export type GatewayBind = "loopback" | "lan" | "auto" | "custom" | "tailnet";
export type TailscaleMode = "off" | "serve" | "funnel";
export type NodeManagerChoice = "npm" | "pnpm" | "bun";
export type ChannelChoice = ChannelId;
// Legacy alias (pre-rename).
export type ProviderChoice = ChannelChoice;

export type OnboardOptions = {
  mode?: OnboardMode;
  /** "manual" is an alias for "advanced". */
  flow?: "quickstart" | "advanced" | "manual";
  workspace?: string;
  nonInteractive?: boolean;
  /** Required for non-interactive onboarding; skips the interactive risk prompt when true. */
  acceptRisk?: boolean;
  reset?: boolean;
  authChoice?: AuthChoice;
  /** Used when `authChoice=token` in non-interactive mode. */
  tokenProvider?: string;
  /** Used when `authChoice=token` in non-interactive mode. */
  token?: string;
  /** Used when `authChoice=token` in non-interactive mode. */
  tokenProfileId?: string;
  /** Used when `authChoice=token` in non-interactive mode. */
  tokenExpiresIn?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openrouterApiKey?: string;
  aiGatewayApiKey?: string;
  moonshotApiKey?: string;
  kimiCodeApiKey?: string;
  geminiApiKey?: string;
  zaiApiKey?: string;
  minimaxApiKey?: string;
  syntheticApiKey?: string;
  veniceApiKey?: string;
  opencodeZenApiKey?: string;
  gatewayPort?: number;
  gatewayBind?: GatewayBind;
  gatewayAuth?: GatewayAuthChoice;
  gatewayToken?: string;
  gatewayPassword?: string;
  tailscale?: TailscaleMode;
  tailscaleResetOnExit?: boolean;
  installDaemon?: boolean;
  daemonRuntime?: GatewayDaemonRuntime;
  skipChannels?: boolean;
  /** @deprecated Legacy alias for `skipChannels`. */
  skipProviders?: boolean;
  skipSkills?: boolean;
  skipHealth?: boolean;
  skipUi?: boolean;
  nodeManager?: NodeManagerChoice;
  remoteUrl?: string;
  remoteToken?: string;
  json?: boolean;
};
