// Msteams type declarations define plugin contracts.
import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import type { MSTeamsPollStore } from "./polls.js";
import type { MSTeamsApp } from "./sdk.js";

type MSTeamsApprovalGatewayRuntime = {
  request: (
    method: "approval.resolve",
    params: {
      id: string;
      kind: "exec" | "plugin" | "system-agent";
      decision: "allow-once" | "allow-always" | "deny";
    },
    options?: { clientDisplayName?: string },
  ) => Promise<ApprovalResolveResult>;
};

export type MSTeamsMessageHandlerDeps = {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  appId: string;
  app: MSTeamsApp;
  tokenProvider: {
    getAccessToken: (scope: string) => Promise<string>;
  };
  textLimit: number;
  mediaMaxBytes: number;
  conversationStore: MSTeamsConversationStore;
  pollStore: MSTeamsPollStore;
  log: MSTeamsMonitorLogger;
  approvalGatewayRuntime?: MSTeamsApprovalGatewayRuntime;
};
