import { buildInboundMediaNoteProjection } from "../../../auto-reply/media-note.js";
import {
  normalizeMediaFacts,
  readRuntimePromptMediaFacts,
  resolveMediaFacts,
  type MediaFact,
} from "../../../media/media-facts.js";
/**
 * Prunes already-processed image payloads from replayed prompt history.
 */
import { buildLateMediaAttachedProjection } from "../../../sessions/user-turn-transcript.js";
import type { AgentMessage } from "../../runtime/index.js";
import { hasNonBlankUserText } from "./attempt.user-message-boundary.js";
import { hydratePromptMediaMessages } from "./images.js";

/** Replacement text for old image blocks that were already available to the model. */
const PRUNED_HISTORY_IMAGE_MARKER = "[image data removed - already processed by model]";

/** Replacement text for fact-owned late-media projections already processed by the model. */
const PRUNED_HISTORY_MEDIA_REFERENCE_MARKER =
  "[media reference removed - already processed by model]";

// Legacy replay hygiene only: factless pre-MediaFact rows past the prune cutoff
// retain no attachment ownership. Fact-bearing messages never use these patterns.
const LEGACY_MEDIA_ATTACHED_PATTERN = /\[media attached(?:\s+\d+\/\d+)?:\s*[^\]]+\]/gi;
const LEGACY_IMAGE_SOURCE_PATTERN = /\[Image:\s*source:\s*[^\]]+\]/gi;
const LEGACY_INBOUND_MEDIA_URI_PATTERN = /\bmedia:\/\/inbound\/[^\]\s/\\]+/g;

type PrunableContextAgent = {
  transformContext?: (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ) => AgentMessage[] | Promise<AgentMessage[]>;
};

/**
 * Number of most-recent completed turns whose preceding user/toolResult image
 * blocks are kept intact. Counts all completed turns, not just image-bearing
 * ones, so text-only turns consume the window.
 */
const PRESERVE_RECENT_COMPLETED_TURNS = 3;
const PERSISTED_MEDIA_FIELD_KEYS = [
  "media",
  "MediaPath",
  "MediaPaths",
  "MediaUrl",
  "MediaUrls",
  "MediaType",
  "MediaTypes",
  "MediaTranscribedIndexes",
  "MediaWorkspaceDir",
] as const;

function resolvePruneBeforeIndex(messages: AgentMessage[]): number {
  const completedTurnStarts: number[] = [];
  let currentTurnStart = -1;
  let currentTurnHasAssistantReply = false;

  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]?.role;
    if (role === "user") {
      if (currentTurnStart >= 0 && currentTurnHasAssistantReply) {
        completedTurnStarts.push(currentTurnStart);
      }
      currentTurnStart = i;
      currentTurnHasAssistantReply = false;
      continue;
    }
    if (role === "toolResult") {
      if (currentTurnStart < 0) {
        currentTurnStart = i;
      }
      continue;
    }
    if (role === "assistant" && currentTurnStart >= 0) {
      currentTurnHasAssistantReply = true;
    }
  }

  if (currentTurnStart >= 0 && currentTurnHasAssistantReply) {
    completedTurnStarts.push(currentTurnStart);
  }

  if (completedTurnStarts.length <= PRESERVE_RECENT_COMPLETED_TURNS) {
    return -1;
  }
  return completedTurnStarts.at(-PRESERVE_RECENT_COMPLETED_TURNS) ?? -1;
}

function resolveMessageMediaFacts(message: AgentMessage): MediaFact[] {
  const runtimeMedia = readRuntimePromptMediaFacts(message);
  if (runtimeMedia) {
    return runtimeMedia;
  }
  const meta = (message as unknown as Record<string, unknown>)["__openclaw"];
  const nestedMedia =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, unknown>).media
      : undefined;
  return Array.isArray(nestedMedia)
    ? normalizeMediaFacts(nestedMedia as MediaFact[])
    : resolveMediaFacts(message as unknown as Parameters<typeof resolveMediaFacts>[0]);
}

function wasStructurallyMediaPruned(message: AgentMessage): boolean {
  const meta = (message as unknown as Record<string, unknown>)["__openclaw"];
  return (
    Boolean(meta) &&
    typeof meta === "object" &&
    !Array.isArray(meta) &&
    (meta as Record<string, unknown>).mediaImagePruned === true
  );
}

function replaceLegacyFactlessMediaText(text: string): string {
  return text
    .replace(LEGACY_MEDIA_ATTACHED_PATTERN, PRUNED_HISTORY_MEDIA_REFERENCE_MARKER)
    .replace(LEGACY_IMAGE_SOURCE_PATTERN, PRUNED_HISTORY_MEDIA_REFERENCE_MARKER)
    .replace(LEGACY_INBOUND_MEDIA_URI_PATTERN, PRUNED_HISTORY_MEDIA_REFERENCE_MARKER);
}

function factOwnsMarkerIdentity(identity: string, media: MediaFact[]): boolean {
  const normalizedIdentity = identity.replaceAll("\\", "/");
  return media.some((fact) =>
    [fact.path, fact.url].some((alias) => alias?.replaceAll("\\", "/") === normalizedIdentity),
  );
}

function extractMediaAttachedIdentity(marker: string): string {
  const content = marker.replace(/^\[media attached(?:\s+\d+\/\d+)?:\s*/i, "").slice(0, -1);
  const mimeIndex = content.lastIndexOf(" (");
  const urlIndex = content.indexOf(" | ");
  const endIndexes = [mimeIndex, urlIndex].filter((index) => index >= 0);
  const endIndex = endIndexes.length > 0 ? Math.min(...endIndexes) : content.length;
  return content.slice(0, endIndex).trim();
}

function replaceOwnedLegacyMediaMarkers(text: string, media: MediaFact[]): string {
  return text
    .replace(LEGACY_MEDIA_ATTACHED_PATTERN, (marker) =>
      factOwnsMarkerIdentity(extractMediaAttachedIdentity(marker), media)
        ? PRUNED_HISTORY_MEDIA_REFERENCE_MARKER
        : marker,
    )
    .replace(LEGACY_IMAGE_SOURCE_PATTERN, (marker) => {
      const identity = marker
        .replace(/^\[Image:\s*source:\s*/i, "")
        .slice(0, -1)
        .trim();
      return factOwnsMarkerIdentity(identity, media)
        ? PRUNED_HISTORY_MEDIA_REFERENCE_MARKER
        : marker;
    });
}

function replaceOwnedMediaProjection(text: string, media: MediaFact[]): string {
  if (media.length === 0) {
    return text;
  }
  const projectionLines = new Set<string>();
  for (const facts of [media, ...media.map((fact) => [fact])]) {
    const projection = buildInboundMediaNoteProjection({ media: facts }).text;
    for (const line of projection?.split("\n") ?? []) {
      if (line) {
        projectionLines.add(line);
      }
    }
  }
  let redacted = text;
  for (const line of projectionLines) {
    redacted = redacted.replaceAll(line, PRUNED_HISTORY_MEDIA_REFERENCE_MARKER);
  }
  for (const fact of media) {
    for (const alias of [fact.path, fact.url].filter((value): value is string => Boolean(value))) {
      redacted = redacted
        .replaceAll(`[Image: source: ${alias}]`, PRUNED_HISTORY_MEDIA_REFERENCE_MARKER)
        .replaceAll(`[media attached: ${alias}]`, PRUNED_HISTORY_MEDIA_REFERENCE_MARKER);
    }
  }
  return replaceOwnedLegacyMediaMarkers(redacted, media);
}

function cloneMessageWithContent(
  message: Extract<AgentMessage, { role: "user" | "toolResult" }>,
  content: typeof message.content,
  dropMedia = false,
  dropImageMetadata = dropMedia,
): AgentMessage {
  const clone = { ...message, content } as AgentMessage & Record<string, unknown>;
  if (dropMedia) {
    for (const key of PERSISTED_MEDIA_FIELD_KEYS) {
      delete clone[key];
    }
  }
  if (dropImageMetadata) {
    const meta = clone["__openclaw"];
    const nextMeta =
      meta && typeof meta === "object" && !Array.isArray(meta)
        ? { ...(meta as Record<string, unknown>) }
        : {};
    delete nextMeta.mediaImageBlockFactIndexes;
    delete nextMeta.mediaImageLayout;
    if (dropMedia) {
      delete nextMeta.media;
      nextMeta.mediaImagePruned = true;
    }
    if (Object.keys(nextMeta).length > 0) {
      clone["__openclaw"] = nextMeta;
    } else {
      delete clone["__openclaw"];
    }
  }
  return clone;
}

/** Prunes old image payloads and references before later LLM-boundary synthesis. */
export function pruneProcessedHistoryImages(messages: AgentMessage[]): AgentMessage[] | null {
  const pruneBeforeIndex = resolvePruneBeforeIndex(messages);
  if (pruneBeforeIndex < 0) {
    return null;
  }

  let prunedMessages: AgentMessage[] | null = null;
  for (let i = 0; i < pruneBeforeIndex; i++) {
    const message = messages[i];
    if (!message || (message.role !== "user" && message.role !== "toolResult")) {
      continue;
    }
    const media = message.role === "user" ? resolveMessageMediaFacts(message) : [];
    const hasOwnedMedia = media.length > 0;
    const structuredMediaWasPruned = wasStructurallyMediaPruned(message);

    // Materialize blank marked turns here so this earlier boundary still prunes stale paths.
    const lateMediaProjection =
      message.role === "user" && !hasNonBlankUserText(message.content)
        ? buildLateMediaAttachedProjection(message)
        : undefined;
    const lateMediaText = lateMediaProjection?.media
      .map(() => PRUNED_HISTORY_MEDIA_REFERENCE_MARKER)
      .join("\n");
    const content = lateMediaText
      ? Array.isArray(message.content)
        ? ([{ type: "text", text: lateMediaText }, ...message.content] as typeof message.content)
        : lateMediaText
      : message.content;

    if (typeof content === "string") {
      const nextText = hasOwnedMedia
        ? replaceOwnedMediaProjection(content, media)
        : structuredMediaWasPruned
          ? content
          : replaceLegacyFactlessMediaText(content);
      if (nextText !== message.content || hasOwnedMedia) {
        prunedMessages ??= messages.slice();
        prunedMessages[i] = cloneMessageWithContent(message, nextText, hasOwnedMedia);
      }
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    const nextContent = content.map((block) => {
      const typed = block as { type?: unknown; text?: unknown } | null | undefined;
      if (typed?.type === "text" && typeof typed.text === "string") {
        const text = hasOwnedMedia
          ? replaceOwnedMediaProjection(typed.text, media)
          : structuredMediaWasPruned
            ? typed.text
            : replaceLegacyFactlessMediaText(typed.text);
        if (text !== typed.text) {
          return { ...block, text } as (typeof content)[number];
        }
      }
      return typed?.type === "image"
        ? ({ type: "text", text: PRUNED_HISTORY_IMAGE_MARKER } as (typeof content)[number])
        : block;
    });
    const prunedImageBlock = content.some(
      (block) => (block as { type?: unknown } | null | undefined)?.type === "image",
    );
    if (
      hasOwnedMedia ||
      lateMediaText ||
      nextContent.some((block, index) => block !== content[index])
    ) {
      prunedMessages ??= messages.slice();
      prunedMessages[i] = cloneMessageWithContent(
        message,
        nextContent,
        hasOwnedMedia,
        hasOwnedMedia || prunedImageBlock,
      );
    }
  }

  return prunedMessages;
}

/** Installs an agent context transform that prunes old image/media history before model input. */
export function installHistoryImagePruneContextTransform(
  agent: PrunableContextAgent,
  mediaOptions?: Parameters<typeof hydratePromptMediaMessages>[1],
): () => void {
  const originalTransformContext = agent.transformContext;
  agent.transformContext = async (messages: AgentMessage[], signal?: AbortSignal) => {
    const prunedInput = pruneProcessedHistoryImages(messages) ?? messages;
    const hydratedInput = mediaOptions
      ? await hydratePromptMediaMessages(prunedInput, mediaOptions)
      : prunedInput;
    const transformed = originalTransformContext
      ? await originalTransformContext.call(agent, hydratedInput, signal)
      : hydratedInput;
    const sourceMessages = Array.isArray(transformed) ? transformed : hydratedInput;
    return pruneProcessedHistoryImages(sourceMessages) ?? sourceMessages;
  };
  return () => {
    agent.transformContext = originalTransformContext;
  };
}
