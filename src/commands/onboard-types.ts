import type { ChatProviderId } from "../providers/registry.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

export type OnboardMode = "local" | "remote";
export type AuthChoice =
  | "oauth"
  | "claude-cli"
  | "openai-codex"
  | "codex-cli"
  | "antigravity"
  | "apiKey"
  | "minimax"
  | "skip";
export type GatewayAuthChoice = "off" | "token" | "password";
export type ResetScope = "config" | "config+creds+sessions" | "full";
export type GatewayBind = "loopback" | "lan" | "tailnet" | "auto";
export type TailscaleMode = "off" | "serve" | "funnel";
export type NodeManagerChoice = "npm" | "pnpm" | "bun";
export type ProviderChoice = ChatProviderId;

export type OnboardOptions = {
  mode?: OnboardMode;
  workspace?: string;
  nonInteractive?: boolean;
  authChoice?: AuthChoice;
  anthropicApiKey?: string;
  gatewayPort?: number;
  gatewayBind?: GatewayBind;
  gatewayAuth?: GatewayAuthChoice;
  gatewayToken?: string;
  gatewayPassword?: string;
  tailscale?: TailscaleMode;
  tailscaleResetOnExit?: boolean;
  installDaemon?: boolean;
  daemonRuntime?: GatewayDaemonRuntime;
  skipSkills?: boolean;
  skipHealth?: boolean;
  nodeManager?: NodeManagerChoice;
  remoteUrl?: string;
  remoteToken?: string;
  json?: boolean;
};
