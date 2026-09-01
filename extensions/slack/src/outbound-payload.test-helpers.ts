import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { slackOutbound } from "../test-api.js";
import { createSlackSendTestClient } from "./blocks.test-helpers.js";
import { sendMessageSlack } from "./send.js";

type SlackTestBlock = {
  block_id?: string;
  elements?: Array<{ action_id?: string; text?: string }>;
  text?: { text?: string; type?: string };
  type?: string;
};

export type SlackSendOptions = {
  authoredTextPlacement?: "none" | "blocks" | "outside-blocks";
  blocks?: SlackTestBlock[];
  mediaUrl?: string;
  nativeDataFallbackBaseText?: string;
  textIsSlackPlainText?: boolean;
};

type PostedSlackMessage = Pick<SlackSendOptions, "blocks"> & {
  mrkdwn?: boolean;
  text?: string;
};

export function postedSlackMessage(
  client: ReturnType<typeof createSlackSendTestClient>,
  index: number,
): PostedSlackMessage {
  const message = client.chat.postMessage.mock.calls[index]?.[0];
  if (!message) {
    throw new Error(`expected Slack postMessage call ${index}`);
  }
  return message as PostedSlackMessage;
}

export async function renderPresentation(payload: ReplyPayload, text = ""): Promise<ReplyPayload> {
  const rendered = await slackOutbound.renderPresentation?.({
    payload,
    presentation: payload.presentation!,
    ctx: { cfg: {}, to: "C12345", text, payload },
  });
  if (!rendered) {
    throw new Error("Expected rendered Slack presentation");
  }
  return rendered;
}

export async function renderPayloadForSend(
  payload: ReplyPayload,
  text = "",
): Promise<ReplyPayload> {
  const { presentation: _presentation, ...payloadForSend } = await renderPresentation(
    payload,
    text,
  );
  return payloadForSend;
}

export async function sendThroughRealSlack(params: {
  payload: ReplyPayload;
  rejectFirstNativeBlocks?: boolean;
  renderText?: string;
  deliveryQueueId?: string;
  onPlatformSendDispatch?: () => Promise<void>;
}) {
  const payload = await renderPayloadForSend(params.payload, params.renderText);
  const client = createSlackSendTestClient();
  if (params.rejectFirstNativeBlocks) {
    client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
  }
  const cfg = { channels: { slack: { botToken: "xoxb-test" } } };
  const capturedSendOptions: Array<NonNullable<Parameters<typeof sendMessageSlack>[2]>> = [];
  const sendSlack: typeof sendMessageSlack = async (to, text, opts) => {
    capturedSendOptions.push(opts);
    return await sendMessageSlack(to, text, { ...opts, cfg, token: "xoxb-test", client });
  };

  await slackOutbound.sendPayload?.({
    cfg,
    to: "channel:C123",
    text: "",
    payload,
    deps: { sendSlack },
    deliveryQueueId: params.deliveryQueueId,
    onPlatformSendDispatch: params.onPlatformSendDispatch,
  });
  return { capturedSendOptions, client };
}

export function valueButtons(label: string, value: string) {
  return { type: "buttons" as const, buttons: [{ label, value }] };
}
