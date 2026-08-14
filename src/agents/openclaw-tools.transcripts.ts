import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createTranscriptsTool } from "./tools/transcripts-tool.js";

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
      }
    | undefined,
): AnyAgentTool | undefined {
  const callerOriginKnown =
    options?.gatewayCallerLocal === true || options?.gatewayCallerChannel !== null;
  if (!callerOriginKnown || config?.transcripts?.enabled === false) {
    return undefined;
  }
  return createTranscriptsTool({
    agentId,
    agentChannel: options?.gatewayCallerLocal
      ? undefined
      : (options?.gatewayCallerChannel ?? options?.agentChannel),
    agentAccountId: options?.gatewayCallerAccountId ?? options?.agentAccountId,
    config,
  });
}
