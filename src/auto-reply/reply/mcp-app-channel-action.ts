import type { McpAppChannelView } from "../../agents/mcp-ui-resource.js";
import { materializeMcpAppChannelPresentation } from "../../gateway/mcp-app-channel-action.js";
import { isReplyPayloadStatusNotice } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

function isEligibleTerminalPayload(payload: ReplyPayload): boolean {
  return Boolean(
    payload.text?.trim() &&
    payload.isError !== true &&
    payload.isReasoning !== true &&
    payload.isCommentary !== true &&
    !isReplyPayloadStatusNotice(payload),
  );
}

/** Attach one late-minted portable action to the final visible channel reply. */
export function attachMcpAppChannelAction(params: {
  payloads: ReplyPayload[];
  channel?: string;
  sessionKey?: string;
  view?: McpAppChannelView;
}): ReplyPayload[] {
  if (!params.channel || params.channel === "webchat" || !params.sessionKey || !params.view) {
    return params.payloads;
  }
  const index = params.payloads.findLastIndex(isEligibleTerminalPayload);
  if (index < 0) {
    return params.payloads;
  }
  const presentation = materializeMcpAppChannelPresentation({
    sessionKey: params.sessionKey,
    view: params.view,
  });
  if (!presentation) {
    return params.payloads;
  }
  const payloads = params.payloads.slice();
  const payload = payloads[index]!;
  payloads[index] = {
    ...payload,
    presentation: payload.presentation
      ? {
          ...payload.presentation,
          blocks: [...payload.presentation.blocks, ...presentation.blocks],
        }
      : presentation,
  };
  return payloads;
}
