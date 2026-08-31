import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TranscriptToolCaller } from "../transcripts/provider-types.js";
import { bindActiveOperatorTurnAuthority } from "./cron-creator-authority-context.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createTranscriptsTool } from "./tools/transcripts-tool.js";

function resolveTranscriptCaller(options: {
  agentChannel?: string;
  agentAccountId?: string;
  agentGroupId?: string | null;
  agentGroupSpace?: string | null;
  agentMemberRoleIds?: string[];
  gatewayCallerAccountId?: string;
  gatewayCallerChannel?: string | null;
  gatewayCallerLocal?: boolean;
  gatewayCallerScheduled?: boolean;
  requesterSenderId?: string | null;
  runId?: string;
}): { caller: TranscriptToolCaller; assertCallerActive?: () => void } | undefined {
  const accountId = options.gatewayCallerAccountId ?? options.agentAccountId;
  const channel =
    options.gatewayCallerLocal || options.gatewayCallerChannel === null
      ? undefined
      : (options.gatewayCallerChannel ?? options.agentChannel)?.trim().toLowerCase();
  const operatorAuthority = bindActiveOperatorTurnAuthority(options.runId);
  if (options.gatewayCallerScheduled) {
    return {
      caller: Object.freeze({ kind: "operator", source: "scheduled" }),
    };
  }
  if (operatorAuthority) {
    return {
      caller: Object.freeze({ kind: "operator", source: operatorAuthority.source }),
      assertCallerActive: operatorAuthority.assertActive,
    };
  }
  if (!channel) {
    return undefined;
  }
  const senderId = options.requesterSenderId?.trim();
  if (!senderId) {
    return undefined;
  }
  return {
    caller: Object.freeze({
      kind: "channel",
      channel,
      ...(accountId ? { accountId } : {}),
      senderId,
      ...(options.agentGroupId?.trim() ? { groupId: options.agentGroupId.trim() } : {}),
      ...(options.agentGroupSpace?.trim() ? { groupSpace: options.agentGroupSpace.trim() } : {}),
      roleIds: Object.freeze([...(options.agentMemberRoleIds ?? [])]),
    }),
  };
}

export function resolveTranscriptsTool(
  config: OpenClawConfig | undefined,
  agentId: string,
  options:
    | {
        agentChannel?: string;
        agentAccountId?: string;
        gatewayCallerAccountId?: string;
        gatewayCallerChannel?: string | null;
        gatewayCallerLocal?: boolean;
        gatewayCallerScheduled?: boolean;
        requesterSenderId?: string | null;
        runId?: string;
        agentGroupId?: string | null;
        agentGroupSpace?: string | null;
        agentMemberRoleIds?: string[];
      }
    | undefined,
): AnyAgentTool | undefined {
  if (config?.transcripts?.enabled === false) {
    return undefined;
  }
  const caller = resolveTranscriptCaller(options ?? {});
  if (!caller) {
    return undefined;
  }
  return createTranscriptsTool({
    agentId,
    agentChannel: options?.gatewayCallerLocal
      ? undefined
      : (options?.gatewayCallerChannel ?? options?.agentChannel),
    agentAccountId: options?.gatewayCallerAccountId ?? options?.agentAccountId,
    caller: caller.caller,
    ...(caller.assertCallerActive ? { assertCallerActive: caller.assertCallerActive } : {}),
    config,
  });
}
