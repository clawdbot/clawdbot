import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type {
  RenderedMessageBatch,
  RenderedMessageBatchPlan,
  RenderedMessageBatchPlanItem,
  RenderedMessageBatchPlanKind,
} from "./types.js";

function countMedia(payload: ReplyPayload): number {
  return (payload.mediaUrls?.filter(Boolean).length ?? 0) + (payload.mediaUrl ? 1 : 0);
}

function collectMediaUrls(payload: ReplyPayload): string[] {
  return [payload.mediaUrl, ...(payload.mediaUrls ?? [])]
    .map((url) => url?.trim())
    .filter((url): url is string => Boolean(url));
}

function createRenderedMessageBatchPlanItem(
  payload: ReplyPayload,
  index: number,
): RenderedMessageBatchPlanItem {
  const text = payload.text?.trim();
  const mediaUrls = collectMediaUrls(payload);
  const presentationBlockCount = payload.presentation?.blocks?.length ?? 0;
  const kinds: RenderedMessageBatchPlanKind[] = [];
  if (text) {
    kinds.push("text");
  }
  if (mediaUrls.length > 0) {
    kinds.push(payload.audioAsVoice ? "voice" : "media");
  }
  if (presentationBlockCount > 0) {
    kinds.push("presentation");
  }
  if (payload.interactive) {
    kinds.push("interactive");
  }
  if (payload.channelData) {
    kinds.push("channelData");
  }
  return {
    index,
    kinds: kinds.length > 0 ? kinds : ["empty"],
    ...(text ? { text } : {}),
    mediaUrls,
    ...(payload.audioAsVoice && mediaUrls.length > 0 ? { audioAsVoice: true } : {}),
    ...(presentationBlockCount > 0 ? { presentationBlockCount } : {}),
    ...(payload.interactive ? { hasInteractive: true } : {}),
    ...(payload.channelData ? { hasChannelData: true } : {}),
  };
}

export function createRenderedMessageBatchPlan(
  payloads: readonly ReplyPayload[],
): RenderedMessageBatchPlan {
  const items = payloads.map(createRenderedMessageBatchPlanItem);
  return payloads.reduce<RenderedMessageBatchPlan>(
    (plan, payload) => {
      const text = payload.text?.trim();
      const mediaCount = countMedia(payload);
      return {
        payloadCount: plan.payloadCount + 1,
        textCount: plan.textCount + (text ? 1 : 0),
        mediaCount: plan.mediaCount + mediaCount,
        voiceCount: plan.voiceCount + (payload.audioAsVoice && mediaCount > 0 ? 1 : 0),
        presentationCount: plan.presentationCount + (payload.presentation?.blocks?.length ? 1 : 0),
        interactiveCount: plan.interactiveCount + (payload.interactive ? 1 : 0),
        channelDataCount: plan.channelDataCount + (payload.channelData ? 1 : 0),
        items: plan.items,
      };
    },
    {
      payloadCount: 0,
      textCount: 0,
      mediaCount: 0,
      voiceCount: 0,
      presentationCount: 0,
      interactiveCount: 0,
      channelDataCount: 0,
      items,
    },
  );
}

export function createRenderedMessageBatch(
  payloads: ReplyPayload[],
): RenderedMessageBatch<ReplyPayload> {
  return {
    payloads,
    plan: createRenderedMessageBatchPlan(payloads),
  };
}
