import type { CronCreatorAuthorityGrant } from "../../gateway/cron-creator-authority-grant.js";
// Cron tool type declarations shared with the cron tool implementation.
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import type { callGatewayTool } from "./gateway.js";

export type CronCreatorToolAllowlistEntry =
  | string
  | {
      name: string;
      pluginId?: string;
    };

type CronToolsAllowCaptureProvenance = {
  version: 1;
  source: "final-executable-surface";
};

export type CronToolsAllowCaptureRef = {
  value?: CronToolsAllowCaptureProvenance;
};

export type CronCreatorToolAuthorityMaterialization = {
  tools: readonly CronCreatorToolAllowlistEntry[];
  provenance: CronToolsAllowCaptureProvenance;
};

export type CronCreatorToolAuthoritySnapshot = CronCreatorToolAuthorityMaterialization & {
  /** Gateway-process one-shot proof consumed only at the matching cron write. */
  grant: CronCreatorAuthorityGrant;
};

export type CronToolOptions = {
  agentSessionKey?: string;
  /** Authenticated source account; authority must not be inferred from delivery. */
  agentAccountId?: string;
  currentDeliveryContext?: DeliveryContext;
  /**
   * Effective tool surface visible to the caller that created or edited a cron job.
   * Cron agent turns and trigger scripts use fresh runtimes, so agent-origin jobs
   * need this cap persisted before the original session policy is lost.
   */
  creatorToolAllowlist?: CronCreatorToolAllowlistEntry[];
  /** Host-owned proof that creatorToolAllowlist reached the final executable surface. */
  creatorToolAllowlistCaptureRef?: CronToolsAllowCaptureRef;
  /** Attempt-cached authority resolved only when a mutation changes its tool cap. */
  resolveCreatorToolAuthority?: (options?: {
    signal?: AbortSignal;
  }) => Promise<CronCreatorToolAuthoritySnapshot>;
  /** Visible fail-closed reason when a queued local turn cannot retain fresh MCP authority. */
  creatorAuthorityUnavailableReason?: "queued-local-operator-configured-mcp";
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
