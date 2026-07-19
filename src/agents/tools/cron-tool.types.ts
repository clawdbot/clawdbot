// Cron tool type declarations shared with the cron tool implementation.
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import type { callGatewayTool } from "./gateway.js";

export type CronCreatorToolAllowlistEntry =
  | string
  | {
      name: string;
      pluginId?: string;
    };

export type CronToolOptions = {
  agentSessionKey?: string;
  currentDeliveryContext?: DeliveryContext;
  /**
   * Effective tool surface visible to the caller that created or edited a cron job.
   * Cron agent turns and trigger scripts use fresh runtimes, so agent-origin jobs
   * need this cap persisted before the original session policy is lost.
   */
  creatorToolAllowlist?: CronCreatorToolAllowlistEntry[];
  selfRemoveOnlyJobId?: string;
  runId?: string;
};

export type CronToolCallerScope = {
  kind: "agentTool";
  agentId: string;
};

export type GatewayToolCaller = typeof callGatewayTool;

export type CronToolDeps = {
  callGatewayTool?: GatewayToolCaller;
};

export type ChatMessage = {
  role?: unknown;
  content?: unknown;
};
