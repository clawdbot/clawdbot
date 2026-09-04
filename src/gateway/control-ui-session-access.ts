import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  hasToolMessageEnvelope,
  isToolCallContentType,
  isToolResultContentType,
} from "../chat/tool-content.js";
import { visitSessionTranscriptMessageEvents } from "../config/sessions/session-accessor.sqlite-active-events.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readPersistedMediaFacts } from "../media/media-facts.js";
import { normalizeMediaReferenceForComparison } from "../media/media-reference-comparison.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { loadSessionEntriesForTarget } from "./server-methods/sessions-shared.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "./session-request-agent.js";
import { createSessionListEntryFilter } from "./session-sharing.js";
import { buildGatewaySessionRow } from "./session-utils.js";

export type ControlUiSessionAccess = {
  sessionKey: string;
  title?: string;
  derivedTitle?: string;
  agentId: string;
  kind?: string;
  channel?: string;
  updatedAt?: number | null;
  lastMessagePreview?: string;
  archived?: boolean;
};

function mediaSourceMatches(candidate: unknown, source: string): boolean {
  return (
    typeof candidate === "string" &&
    normalizeMediaReferenceForComparison(candidate) === normalizeMediaReferenceForComparison(source)
  );
}

function textReferencesMediaSource(text: unknown, source: string): boolean {
  return (
    typeof text === "string" &&
    splitMediaFromOutput(text).mediaUrls?.some((candidate) =>
      mediaSourceMatches(candidate, source),
    ) === true
  );
}

function messageReferencesMediaSource(message: Record<string, unknown>, source: string): boolean {
  if (
    (readPersistedMediaFacts(message) ?? []).some((fact) =>
      mediaSourceMatches(fact.path ?? fact.url, source),
    )
  ) {
    return true;
  }
  const blocks = Array.isArray(message.content) ? message.content.map(asNonArrayRecord) : [];
  const assistant =
    message.role === "assistant" &&
    !hasToolMessageEnvelope(message) &&
    !blocks.some(
      (block) => isToolCallContentType(block.type) || isToolResultContentType(block.type),
    );
  const text =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? undefined
        : message.text;
  if (assistant && textReferencesMediaSource(text, source)) {
    return true;
  }
  // Match only media rendered from top-level content blocks. Tool arguments,
  // result details and arbitrary nested path/url fields are not attachments.
  return blocks.some((block) => {
    const nestedSource = asNonArrayRecord(block.source);
    switch (block.type) {
      case "text":
      case "input_text":
      case "output_text":
        return assistant && textReferencesMediaSource(block.text, source);
      case "image":
        return (
          typeof block.data !== "string" &&
          !(nestedSource.type === "base64" && typeof nestedSource.data === "string") &&
          mediaSourceMatches(
            normalizeOptionalString(block.url) ?? normalizeOptionalString(nestedSource.url),
            source,
          )
        );
      case "image_url":
        return mediaSourceMatches(asNonArrayRecord(block.image_url).url, source);
      case "input_image":
        return (
          mediaSourceMatches(
            typeof block.image_url === "string"
              ? block.image_url
              : asNonArrayRecord(block.image_url).url,
            source,
          ) || mediaSourceMatches(nestedSource.url, source)
        );
      case "audio":
      case "video":
        return (
          assistant &&
          (mediaSourceMatches(block.url, source) ||
            (block.type === "audio" &&
              nestedSource.type === "url" &&
              mediaSourceMatches(nestedSource.url, source)))
        );
      case "attachment": {
        const attachment = asNonArrayRecord(block.attachment);
        return (
          typeof attachment.kind === "string" &&
          ["image", "audio", "video", "document"].includes(attachment.kind) &&
          typeof attachment.label === "string" &&
          mediaSourceMatches(attachment.url, source)
        );
      }
      default:
        return false;
    }
  });
}

function sessionReferencesMediaSource(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  source: string;
  storePath: string;
}): boolean {
  let found = false;
  try {
    visitSessionTranscriptMessageEvents(params, (entry) => {
      const message = asNonArrayRecord(asNonArrayRecord(entry.event).message);
      const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
      if (
        !found &&
        (["assistant", "user", "tool", "function"].includes(role) ||
          isToolResultContentType(role)) &&
        messageReferencesMediaSource(message, params.source)
      ) {
        found = true;
      }
    });
  } catch {
    return false;
  }
  return found;
}

/** Resolve a session only when the current Gateway client may still discover it. */
export function resolveControlUiSessionAccess(
  sessionKey: string,
  cfg: OpenClawConfig,
  client: GatewayClient | null,
  mediaSource?: string,
): ControlUiSessionAccess | null {
  const requestedAgent = resolveRequestedGlobalAgentId(cfg, sessionKey);
  if (!requestedAgent.ok) {
    return null;
  }
  const { target, storePath, store, entry } = loadSessionEntriesForTarget({
    key: sessionKey,
    cfg,
    ...(requestedAgent.agentId ? { agentId: requestedAgent.agentId } : {}),
  });
  if (!entry) {
    return null;
  }
  const entryFilter = createSessionListEntryFilter({ client, cfg });
  if (entryFilter && !entryFilter(target.canonicalKey, entry)) {
    return null;
  }
  if (
    mediaSource &&
    !sessionReferencesMediaSource({
      agentId: target.agentId,
      sessionId: entry.sessionId,
      sessionKey: target.canonicalKey,
      source: mediaSource,
      storePath,
    })
  ) {
    return null;
  }
  const row = buildGatewaySessionRow({
    cfg,
    storePath,
    store,
    key: target.canonicalKey,
    entry,
    includeDerivedTitles: true,
    includeLastMessage: true,
    skipTranscriptUsageFallback: true,
  });
  return {
    sessionKey: row.key,
    agentId: row.agentId ?? target.agentId,
    title: row.displayName,
    derivedTitle: row.derivedTitle,
    kind: row.kind,
    channel: row.channel,
    updatedAt: row.updatedAt,
    lastMessagePreview: row.lastMessagePreview,
    archived: row.archived,
  };
}
