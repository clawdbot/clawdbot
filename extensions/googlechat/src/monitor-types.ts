import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
// Googlechat plugin module implements monitor types behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatAudienceType } from "./auth.js";
import type { GoogleChatIngressMonitor } from "./monitor-ingress.js";
import type { getGoogleChatRuntime } from "./runtime.js";

export type GoogleChatRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type GoogleChatStatusSink = (patch: Partial<ChannelAccountSnapshot>) => void;

export type GoogleChatMonitorOptions = {
  account: ResolvedGoogleChatAccount;
  config: OpenClawConfig;
  runtime: GoogleChatRuntimeEnv;
  abortSignal: AbortSignal;
  webhookPath?: string;
  webhookUrl?: string;
  statusSink?: GoogleChatStatusSink;
};

export type GoogleChatCoreRuntime = ReturnType<typeof getGoogleChatRuntime>;

export type WebhookTarget = {
  account: ResolvedGoogleChatAccount;
  config: OpenClawConfig;
  runtime: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  path: string;
  audienceType?: GoogleChatAudienceType;
  audience?: string;
  statusSink?: GoogleChatStatusSink;
  mediaMaxMb: number;
  ingress: Pick<GoogleChatIngressMonitor, "receive">;
};
