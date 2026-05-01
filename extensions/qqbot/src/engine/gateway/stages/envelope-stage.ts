/**
 * Envelope stage — render the Web UI body, the dynamic-context block,
 * the final group system prompt, and the media classification arrays.
 *
 * All logic here is presentation-layer glue: it combines fields built by
 * earlier stages into the display-friendly strings the outbound
 * dispatcher needs. No decisions / gating.
 */

import type { ProcessedAttachments } from "../inbound-attachments.js";
import type { InboundGroupInfo, InboundPipelineDeps, ReplyToInfo } from "../inbound-context.js";
import type { QueuedMessage } from "../message-queue.js";

// ─────────────────────────── Envelope body ───────────────────────────

interface BuildBodyInput {
  event: QueuedMessage;
  deps: InboundPipelineDeps;
  userContent: string;
  isGroupChat: boolean;
  imageUrls: string[];
}

/** Format the inbound envelope (Web UI body). */
export function buildBody(input: BuildBodyInput): string {
  const { event, deps, userContent, isGroupChat, imageUrls } = input;
  const envelopeOptions = deps.runtime.channel.reply.resolveEnvelopeFormatOptions(deps.cfg);
  return deps.runtime.channel.reply.formatInboundEnvelope({
    channel: "qqbot",
    from: event.senderName ?? event.senderId,
    timestamp: new Date(event.timestamp).getTime(),
    body: userContent,
    chatType: isGroupChat ? "group" : "direct",
    sender: { id: event.senderId, name: event.senderName },
    envelope: envelopeOptions,
    ...(imageUrls.length > 0 ? { imageUrls } : {}),
  });
}

// ─────────────────────────── Quote / dynamic ctx ───────────────────────────

/** Render the `[Quoted message begins]...[ends]` block (empty if no reply-to). */
export function buildQuotePart(replyTo?: ReplyToInfo): string {
  if (!replyTo) {
    return "";
  }
  return replyTo.body
    ? `[Quoted message begins]\n${replyTo.body}\n[Quoted message ends]\n`
    : `[Quoted message begins]\nOriginal content unavailable\n[Quoted message ends]\n`;
}

interface BuildDynamicCtxInput {
  imageUrls: string[];
  uniqueVoicePaths: string[];
  uniqueVoiceUrls: string[];
  uniqueVoiceAsrReferTexts: string[];
}

/** Render the per-message dynamic metadata block (images / voice / ASR). */
export function buildDynamicCtx(input: BuildDynamicCtxInput): string {
  const lines: string[] = [];
  if (input.imageUrls.length > 0) {
    lines.push(`- Images: ${input.imageUrls.join(", ")}`);
  }
  if (input.uniqueVoicePaths.length > 0 || input.uniqueVoiceUrls.length > 0) {
    lines.push(`- Voice: ${[...input.uniqueVoicePaths, ...input.uniqueVoiceUrls].join(", ")}`);
  }
  if (input.uniqueVoiceAsrReferTexts.length > 0) {
    lines.push(`- ASR: ${input.uniqueVoiceAsrReferTexts.join(" | ")}`);
  }
  return lines.length > 0 ? lines.join("\n") + "\n\n" : "";
}

// ─────────────────────────── System prompt ───────────────────────────

/** Combine account-level system prompt with group-specific prompts. */
export function buildGroupSystemPrompt(
  accountSystemInstruction: string,
  groupInfo: InboundGroupInfo | undefined,
): string | undefined {
  const parts: string[] = [];
  if (accountSystemInstruction) {
    parts.push(accountSystemInstruction);
  }
  if (groupInfo?.display.introHint) {
    parts.push(groupInfo.display.introHint);
  }
  if (groupInfo?.display.behaviorPrompt) {
    parts.push(groupInfo.display.behaviorPrompt);
  }
  const combined = parts.filter(Boolean).join("\n");
  return combined || undefined;
}

// ─────────────────────────── Media classification ───────────────────────────

interface MediaClassification {
  localMediaPaths: string[];
  localMediaTypes: string[];
  remoteMediaUrls: string[];
  remoteMediaTypes: string[];
  uniqueVoicePaths: string[];
  uniqueVoiceUrls: string[];
  uniqueVoiceAsrReferTexts: string[];
  voiceMediaTypes: string[];
  hasAsrReferFallback: boolean;
  voiceTranscriptSources: string[];
}

/** Classify image URLs into local vs remote and de-duplicate voice arrays. */
export function classifyMedia(processed: ProcessedAttachments): MediaClassification {
  const localMediaPaths: string[] = [];
  const localMediaTypes: string[] = [];
  const remoteMediaUrls: string[] = [];
  const remoteMediaTypes: string[] = [];
  for (let i = 0; i < processed.imageUrls.length; i++) {
    const u = processed.imageUrls[i];
    const t = processed.imageMediaTypes[i] ?? "image/png";
    if (u.startsWith("http://") || u.startsWith("https://")) {
      remoteMediaUrls.push(u);
      remoteMediaTypes.push(t);
    } else {
      localMediaPaths.push(u);
      localMediaTypes.push(t);
    }
  }

  const uniqueVoicePaths = [...new Set(processed.voiceAttachmentPaths)];
  const uniqueVoiceUrls = [...new Set(processed.voiceAttachmentUrls)];
  const voiceMediaTypes = [...uniqueVoicePaths, ...uniqueVoiceUrls].map(() => "audio/wav");

  return {
    localMediaPaths,
    localMediaTypes,
    remoteMediaUrls,
    remoteMediaTypes,
    uniqueVoicePaths,
    uniqueVoiceUrls,
    uniqueVoiceAsrReferTexts: [...new Set(processed.voiceAsrReferTexts)].filter(Boolean),
    voiceMediaTypes,
    hasAsrReferFallback: processed.voiceTranscriptSources.includes("asr"),
    voiceTranscriptSources: processed.voiceTranscriptSources,
  };
}
