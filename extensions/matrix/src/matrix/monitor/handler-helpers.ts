import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { CoreConfig } from "../../types.js";
import {
  formatMatrixMediaTooLargeText,
  formatMatrixMediaUnavailableText,
  formatMatrixMessageText,
} from "../media-text.js";
import { formatPollAsText, isPollStartType, parsePollStartContent } from "../poll-types.js";
import { resolveMatrixStoredSessionMeta } from "../session-store-metadata.js";
import { isMatrixAudioContent } from "./preflight-audio.js";
import type { RoomMessageEventContent, MatrixRawEvent } from "./types.js";
import { RelationType } from "./types.js";

const MATRIX_TOOL_PROGRESS_MAX_CHARS = 300;
const MAX_TRACKED_SHARED_DM_CONTEXT_NOTICES = 512;
type MatrixAllowBotsMode = "off" | "mentions" | "all";

export function shouldDropMatrixPreStartupEvent(params: {
  dropPreStartupMessages: boolean;
  eventTs?: number;
  eventAge?: number;
  startupMs: number;
  startupGraceMs: number;
}): boolean {
  return (
    params.dropPreStartupMessages &&
    (typeof params.eventTs === "number"
      ? params.eventTs < params.startupMs - params.startupGraceMs
      : typeof params.eventAge === "number" && params.eventAge > params.startupGraceMs)
  );
}

export function resolveMatrixMentionPrecheckText(params: {
  eventType: string;
  content: RoomMessageEventContent;
  locationText?: string | null;
}): string {
  if (params.locationText?.trim()) {
    return params.locationText.trim();
  }
  if (typeof params.content.body === "string" && params.content.body.trim()) {
    return params.content.body.trim();
  }
  if (isPollStartType(params.eventType)) {
    const parsed = parsePollStartContent(params.content as never);
    if (parsed) {
      return formatPollAsText(parsed);
    }
  }
  return "";
}

export function hasBundledMatrixReplacementRelation(event: MatrixRawEvent) {
  const relations = event.unsigned?.["m.relations"];
  if (!relations || typeof relations !== "object") {
    return false;
  }
  return relations[RelationType.Replace] !== undefined;
}

export function resolveMatrixInboundBodyText(params: {
  rawBody: string;
  filename?: string;
  mediaPlaceholder?: string;
  msgtype?: string;
  hadMediaUrl: boolean;
  mediaDownloadFailed: boolean;
  mediaSizeLimitExceeded?: boolean;
}): string {
  if (params.mediaPlaceholder) {
    return params.rawBody || params.mediaPlaceholder;
  }
  if (!params.mediaDownloadFailed || !params.hadMediaUrl) {
    return params.rawBody;
  }
  if (params.mediaSizeLimitExceeded) {
    return formatMatrixMediaTooLargeText({
      body: params.rawBody,
      filename: params.filename,
      msgtype: params.msgtype,
    });
  }
  return formatMatrixMediaUnavailableText({
    body: params.rawBody,
    filename: params.filename,
    msgtype: params.msgtype,
  });
}

export function markTrackedRoomIfFirst(set: Set<string>, roomId: string): boolean {
  if (set.has(roomId)) {
    return false;
  }
  set.add(roomId);
  if (set.size > MAX_TRACKED_SHARED_DM_CONTEXT_NOTICES) {
    const oldest = set.keys().next().value;
    if (typeof oldest === "string") {
      set.delete(oldest);
    }
  }
  return true;
}

export function resolveMatrixSharedDmContextNotice(params: {
  storePath: string;
  sessionKey: string;
  roomId: string;
  accountId: string;
  dmSessionScope?: "per-user" | "per-room";
  sentRooms: Set<string>;
  logVerboseMessage: (message: string) => void;
}): string | null {
  if ((params.dmSessionScope ?? "per-user") === "per-room") {
    return null;
  }
  if (params.sentRooms.has(params.roomId)) {
    return null;
  }

  try {
    const currentSession = resolveMatrixStoredSessionMeta(
      getSessionEntry({
        storePath: params.storePath,
        sessionKey: params.sessionKey,
      }),
    );
    if (!currentSession) {
      return null;
    }
    if (currentSession.channel && currentSession.channel !== "matrix") {
      return null;
    }
    if (currentSession.accountId && currentSession.accountId !== params.accountId) {
      return null;
    }
    if (!currentSession.directUserId) {
      return null;
    }
    if (!currentSession.roomId || currentSession.roomId === params.roomId) {
      return null;
    }

    return [
      "This Matrix DM is sharing a session with another Matrix DM room.",
      "Use /focus here for a one-off isolated thread session when thread bindings are enabled, or set",
      "channels.matrix.dm.sessionScope to per-room to isolate each Matrix DM room.",
    ].join(" ");
  } catch (err) {
    params.logVerboseMessage(
      `matrix: failed checking shared DM session notice room=${params.roomId} (${String(err)})`,
    );
    return null;
  }
}

export function resolveMatrixPendingHistoryText(params: {
  mentionPrecheckText: string;
  content: RoomMessageEventContent;
  mediaUrl?: string;
}): string {
  if (!params.mediaUrl) {
    return params.mentionPrecheckText;
  }
  const body = typeof params.content.body === "string" ? params.content.body : undefined;
  const filename =
    typeof params.content.filename === "string" ? params.content.filename : undefined;
  const msgtype = typeof params.content.msgtype === "string" ? params.content.msgtype : undefined;
  return formatMatrixMessageText({ body, filename, msgtype }) ?? params.mentionPrecheckText;
}

export function resolveMatrixInboundMediaContent(content: RoomMessageEventContent) {
  const file = content.file && typeof content.file === "object" ? content.file : undefined;
  const info =
    content.info && typeof content.info === "object"
      ? (content.info as { mimetype?: string; size?: number })
      : undefined;
  const body = normalizeOptionalString(content.body);

  return {
    url: normalizeOptionalString(content.url) ?? normalizeOptionalString(file?.url),
    file,
    body: body ?? "",
    contentType: info?.mimetype,
    sizeBytes: typeof info?.size === "number" ? info.size : undefined,
    originalFilename: normalizeOptionalString(content.filename) ?? body,
  };
}

export function isMatrixAudioMediaEnabled(cfg: CoreConfig): boolean {
  const tools = cfg.tools as
    | {
        media?: {
          audio?: {
            enabled?: boolean;
          };
        };
      }
    | undefined;
  return tools?.media?.audio?.enabled !== false;
}

export function shouldDeferMatrixAudioPreflightForRoomIngress(params: {
  content: RoomMessageEventContent;
  cfg: CoreConfig;
}): boolean {
  if (!isMatrixAudioMediaEnabled(params.cfg)) {
    return false;
  }
  const mediaContent = resolveMatrixInboundMediaContent(params.content);
  return (
    mediaContent.url?.startsWith("mxc://") === true &&
    isMatrixAudioContent({
      msgtype: typeof params.content.msgtype === "string" ? params.content.msgtype : undefined,
      mimetype: mediaContent.contentType,
    })
  );
}

export function resolveMatrixAllowBotsMode(value?: boolean | "mentions"): MatrixAllowBotsMode {
  if (value === true) {
    return "all";
  }
  if (value === "mentions") {
    return "mentions";
  }
  return "off";
}

export function formatMatrixToolProgressMarkdownCode(text: string): string {
  const clipped =
    text.length <= MATRIX_TOOL_PROGRESS_MAX_CHARS
      ? text
      : `${truncateUtf16Safe(text, MATRIX_TOOL_PROGRESS_MAX_CHARS - 1).trimEnd()}...`;
  const safe = clipped.replaceAll("`", "'");
  return `\`${safe}\``;
}
