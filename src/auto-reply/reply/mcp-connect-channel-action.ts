import type { McpConnectAction } from "../../agents/mcp-connect-action.js";
import { isReplyPayloadTerminalContent } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

function isEligibleTerminalPayload(payload: ReplyPayload): boolean {
  return Boolean(
    payload.text?.trim() && payload.isError !== true && isReplyPayloadTerminalContent(payload),
  );
}

export function attachMcpConnectChannelAction(params: {
  payloads: ReplyPayload[];
  action?: McpConnectAction;
}): ReplyPayload[] {
  if (!params.action) {
    return params.payloads;
  }
  const index = params.payloads.findLastIndex(isEligibleTerminalPayload);
  if (index < 0) {
    return params.payloads;
  }
  const block = {
    type: "buttons" as const,
    buttons: [
      {
        label: `Connect ${params.action.serverName}`,
        action: { type: "url" as const, url: params.action.authorizationUrl },
      },
    ],
  };
  const payloads = params.payloads.slice();
  const payload = payloads[index]!;
  payloads[index] = {
    ...payload,
    presentation: payload.presentation
      ? { ...payload.presentation, blocks: [...payload.presentation.blocks, block] }
      : { blocks: [block] },
  };
  return payloads;
}
