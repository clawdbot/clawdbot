/**
 * Rendered channel message batch planner.
 *
 * Summarizes reply payloads so delivery can pick adapter paths and recovery metadata.
 */
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type {
  RenderedMessageBatch,
  RenderedMessageBatchPlan,
  RenderedMessageBatchPlanItem,
  RenderedMessageBatchPlanKind,
} from "./types.js";

function collectMediaUrls(payload: ReplyPayload): string[] {
  const mediaUrls = normalizeTrimmedStringList(payload.mediaUrls);
  const mediaUrl = payload.mediaUrl?.trim();
  return mediaUrl && !mediaUrls.includes(mediaUrl) ? [mediaUrl, ...mediaUrls] : mediaUrls;
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
  if (presentationBlockCount > 0 || payload.presentation?.title?.trim()) {
    kinds.push("presentation");
  }
  if (payload.interactive) {
    kinds.push("interactive");
  }
  if (payload.channelData || payload.location) {
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
    ...(payload.channelData || payload.location ? { hasChannelData: true } : {}),
  };
}

/** Summarizes rendered reply payloads so delivery can choose adapter paths and recovery metadata. */
export function createRenderedMessageBatchPlan(
  payloads: readonly ReplyPayload[],
): RenderedMessageBatchPlan {
  const items = payloads.map(createRenderedMessageBatchPlanItem);
  return items.reduce<RenderedMessageBatchPlan>(
    (plan, item) => ({
      payloadCount: plan.payloadCount + 1,
      textCount: plan.textCount + (item.text ? 1 : 0),
      mediaCount: plan.mediaCount + item.mediaUrls.length,
      voiceCount: plan.voiceCount + (item.audioAsVoice ? 1 : 0),
      presentationCount: plan.presentationCount + (item.kinds.includes("presentation") ? 1 : 0),
      interactiveCount: plan.interactiveCount + (item.hasInteractive ? 1 : 0),
      channelDataCount: plan.channelDataCount + (item.hasChannelData ? 1 : 0),
      items: plan.items,
    }),
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

/** Pairs reply payloads with their render plan for durable send and live-preview flows. */
export function createRenderedMessageBatch(
  payloads: ReplyPayload[],
): RenderedMessageBatch<ReplyPayload> {
  return {
    payloads,
    plan: createRenderedMessageBatchPlan(payloads),
  };
}
