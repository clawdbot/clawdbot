import { createHash } from "node:crypto";
import { getTaskSessionLookupByIdForStatus } from "../../tasks/task-status-access.js";
import {
  ErrorCodes,
  errorShape,
  type ArtifactSummary,
  type ArtifactsGetParams,
  validateArtifactsDownloadParams,
  validateArtifactsGetParams,
  validateArtifactsListParams,
} from "../protocol/index.js";
import { resolveSessionKeyForRun } from "../server-session-key.js";
import { loadSessionEntry, visitSessionMessagesAsync } from "../session-utils.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

type ArtifactDownloadMode = ArtifactSummary["download"]["mode"];

type ArtifactRecord = ArtifactSummary & {
  data?: string;
  url?: string;
};

type ArtifactQuery = {
  sessionKey?: string;
  runId?: string;
  taskId?: string;
};

function artifactError(type: string, message: string, details?: Record<string, unknown>) {
  return errorShape(ErrorCodes.INVALID_REQUEST, message, {
    details: {
      type,
      ...details,
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeArtifactType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "image" || normalized === "input_image" || normalized === "image_url") {
    return "image";
  }
  if (normalized === "audio" || normalized === "input_audio") {
    return "audio";
  }
  if (normalized === "file" || normalized === "input_file") {
    return "file";
  }
  return "file";
}

function mimeFromDataUrl(value: string): string | undefined {
  const match = /^data:([^;,]+)(?:;[^,]*)?,/i.exec(value.trim());
  return match?.[1]?.toLowerCase();
}

function base64FromDataUrl(value: string): string | undefined {
  const match = /^data:[^,]*;base64,(.*)$/is.exec(value.trim());
  return match?.[1]?.replace(/\s+/g, "");
}

function estimateBase64Size(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return Buffer.from(value, "base64").byteLength;
  } catch {
    return undefined;
  }
}

function mediaUrlValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return asNonEmptyString(value);
  }
  const record = asRecord(value);
  return asNonEmptyString(record?.url);
}

function isSafeDownloadUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /^data:/i.test(trimmed)) {
    return false;
  }
  if (trimmed.startsWith("/")) {
    return !trimmed.startsWith("//") && trimmed.startsWith("/api/");
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function artifactId(parts: {
  sessionKey: string;
  messageSeq: number;
  contentIndex: number;
  title: string;
  type: string;
}): string {
  const hash = createHash("sha256")
    .update(
      `${parts.sessionKey}\0${parts.messageSeq}\0${parts.contentIndex}\0${parts.type}\0${parts.title}`,
    )
    .digest("base64url")
    .slice(0, 18);
  return `artifact_${hash}`;
}

function resolveMessageSeq(message: Record<string, unknown>, fallback: number): number {
  const meta = asRecord(message.__openclaw);
  const seq = meta?.seq;
  return typeof seq === "number" && Number.isInteger(seq) && seq > 0 ? seq : fallback;
}

function resolveMessageRunId(message: Record<string, unknown>): string | undefined {
  const meta = asRecord(message.__openclaw);
  return asNonEmptyString(meta?.runId) ?? asNonEmptyString(message.runId);
}

function resolveMessageTaskId(message: Record<string, unknown>): string | undefined {
  const meta = asRecord(message.__openclaw);
  return (
    asNonEmptyString(meta?.messageTaskId) ??
    asNonEmptyString(meta?.taskId) ??
    asNonEmptyString(message.messageTaskId) ??
    asNonEmptyString(message.taskId)
  );
}

function resolveBlockDownload(block: Record<string, unknown>): {
  mode: ArtifactDownloadMode;
  data?: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
} {
  const data = asNonEmptyString(block.data);
  const content = asNonEmptyString(block.content);
  const url = asNonEmptyString(block.url) ?? asNonEmptyString(block.openUrl);
  const imageUrl = mediaUrlValue(block.image_url);
  const audioUrl = asNonEmptyString(block.audio_url);
  const source = asRecord(block.source);
  const sourceData = asNonEmptyString(source?.data);
  const sourceUrl = asNonEmptyString(source?.url);
  const dataUrl = [url, sourceUrl, imageUrl, audioUrl, data, content, sourceData].find(
    (value) => typeof value === "string" && /^data:/i.test(value),
  );
  const base64FromDetectedDataUrl = dataUrl ? base64FromDataUrl(dataUrl) : undefined;
  const directBase64 = [data, sourceData, content].find(
    (value) => typeof value === "string" && !/^data:/i.test(value),
  );
  const base64 = base64FromDetectedDataUrl ?? directBase64;
  const remoteUrl = [url, sourceUrl, imageUrl, audioUrl].find(
    (value) => typeof value === "string" && isSafeDownloadUrl(value),
  );
  const mimeType =
    asNonEmptyString(block.mimeType) ??
    asNonEmptyString(block.media_type) ??
    asNonEmptyString(source?.media_type) ??
    asNonEmptyString(source?.mimeType) ??
    (dataUrl ? mimeFromDataUrl(dataUrl) : undefined);
  const explicitSize = block.sizeBytes ?? source?.sizeBytes;
  const sizeBytes =
    typeof explicitSize === "number" && Number.isFinite(explicitSize) && explicitSize >= 0
      ? Math.floor(explicitSize)
      : estimateBase64Size(base64);
  if (base64) {
    return { mode: "bytes", data: base64, mimeType, sizeBytes };
  }
  if (remoteUrl) {
    return { mode: "url", url: remoteUrl, mimeType, sizeBytes };
  }
  return { mode: "unsupported", mimeType, sizeBytes };
}

function isArtifactBlock(block: Record<string, unknown>): boolean {
  const type = asNonEmptyString(block.type)?.toLowerCase();
  if (
    type === "image" ||
    type === "audio" ||
    type === "file" ||
    type === "input_image" ||
    type === "input_audio" ||
    type === "input_file" ||
    type === "image_url"
  ) {
    return true;
  }
  return Boolean(
    block.url || block.openUrl || block.data || block.source || block.image_url || block.audio_url,
  );
}

export function collectArtifactsFromMessages(params: {
  messages: unknown[];
  sessionKey: string;
  runId?: string;
  taskId?: string;
}): ArtifactRecord[] {
  const artifacts: ArtifactRecord[] = [];
  let messageFallbackSeq = 0;
  for (const message of params.messages) {
    messageFallbackSeq += 1;
    collectArtifactsFromMessage({ ...params, message, messageFallbackSeq, artifacts });
  }
  return artifacts;
}

function collectArtifactsFromMessage(params: {
  message: unknown;
  messageFallbackSeq: number;
  artifacts: ArtifactRecord[];
  sessionKey: string;
  runId?: string;
  taskId?: string;
}): void {
  const msg = asRecord(params.message);
  if (!msg) {
    return;
  }
  const messageSeq = resolveMessageSeq(msg, params.messageFallbackSeq);
  const messageRunId = resolveMessageRunId(msg);
  const messageTaskId = resolveMessageTaskId(msg);
  if (params.runId && messageRunId !== params.runId) {
    return;
  }
  if (params.taskId && messageTaskId !== params.taskId) {
    return;
  }
  const content = Array.isArray(msg.content) ? msg.content : [];
  for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
    const block = asRecord(content[contentIndex]);
    if (!block || !isArtifactBlock(block)) {
      continue;
    }
    const type = normalizeArtifactType(asNonEmptyString(block.type) ?? "file");
    const title =
      asNonEmptyString(block.title) ??
      asNonEmptyString(block.fileName) ??
      asNonEmptyString(block.filename) ??
      asNonEmptyString(block.alt) ??
      `${type} ${params.artifacts.length + 1}`;
    const download = resolveBlockDownload(block);
    const summary: ArtifactRecord = {
      id: artifactId({
        sessionKey: params.sessionKey,
        messageSeq,
        contentIndex,
        title,
        type,
      }),
      type,
      title,
      ...(download.mimeType ? { mimeType: download.mimeType } : {}),
      ...(download.sizeBytes !== undefined ? { sizeBytes: download.sizeBytes } : {}),
      sessionKey: params.sessionKey,
      ...(messageRunId ? { runId: messageRunId } : {}),
      ...(messageTaskId ? { taskId: messageTaskId } : {}),
      messageSeq,
      source: "session-transcript",
      download: { mode: download.mode },
      ...(download.data ? { data: download.data } : {}),
      ...(download.url ? { url: download.url } : {}),
    };
    params.artifacts.push(summary);
  }
}

function resolveQuerySessionKey(query: ArtifactQuery): string | undefined {
  if (query.sessionKey) {
    return query.sessionKey;
  }
  if (query.runId) {
    return resolveSessionKeyForRun(query.runId);
  }
  if (query.taskId) {
    const task = getTaskSessionLookupByIdForStatus(query.taskId);
    const requesterSessionKey = asNonEmptyString(task?.requesterSessionKey);
    if (requesterSessionKey) {
      return requesterSessionKey;
    }
    const runId = asNonEmptyString(task?.runId);
    return runId ? resolveSessionKeyForRun(runId) : undefined;
  }
  return undefined;
}

async function loadArtifacts(
  query: ArtifactQuery,
): Promise<{ artifacts: ArtifactRecord[]; sessionKey?: string }> {
  const sessionKey = resolveQuerySessionKey(query);
  if (!sessionKey) {
    return { artifacts: [] };
  }
  const { storePath, entry } = loadSessionEntry(sessionKey);
  const sessionId = entry?.sessionId;
  if (!sessionId || !storePath) {
    return { sessionKey, artifacts: [] };
  }
  const artifacts: ArtifactRecord[] = [];
  await visitSessionMessagesAsync(
    sessionId,
    storePath,
    entry?.sessionFile,
    (message, seq) => {
      collectArtifactsFromMessage({
        message,
        messageFallbackSeq: seq,
        artifacts,
        sessionKey,
        runId: query.runId,
        taskId: query.taskId,
      });
    },
    {
      mode: "full",
      reason: "artifact query transcript scan",
    },
  );
  return {
    sessionKey,
    artifacts,
  };
}

function requireQueryable(params: ArtifactQuery, respond: RespondFn): boolean {
  if (params.sessionKey || params.runId || params.taskId) {
    return true;
  }
  respond(
    false,
    undefined,
    artifactError(
      "artifact_query_unsupported",
      "artifacts require one of sessionKey, runId, or taskId",
    ),
  );
  return false;
}

async function findArtifact(params: ArtifactsGetParams): Promise<{
  artifact?: ArtifactRecord;
  sessionKey?: string;
}> {
  const loaded = await loadArtifacts(params);
  return {
    sessionKey: loaded.sessionKey,
    artifact: loaded.artifacts.find((artifact) => artifact.id === params.artifactId),
  };
}

function toSummary(artifact: ArtifactRecord): ArtifactSummary {
  const { data: _data, url: _url, ...summary } = artifact;
  return summary;
}

export const artifactsHandlers: GatewayRequestHandlers = {
  "artifacts.list": async ({ params, respond }) => {
    if (!assertValidParams(params, validateArtifactsListParams, "artifacts.list", respond)) {
      return;
    }
    if (!requireQueryable(params, respond)) {
      return;
    }
    const { artifacts, sessionKey } = await loadArtifacts(params);
    if (!sessionKey && (params.runId || params.taskId)) {
      respond(
        false,
        undefined,
        artifactError("artifact_scope_not_found", "no session found for artifact query"),
      );
      return;
    }
    respond(true, { artifacts: artifacts.map(toSummary) });
  },
  "artifacts.get": async ({ params, respond }) => {
    if (!assertValidParams(params, validateArtifactsGetParams, "artifacts.get", respond)) {
      return;
    }
    if (!requireQueryable(params, respond)) {
      return;
    }
    const { artifact } = await findArtifact(params);
    if (!artifact) {
      respond(
        false,
        undefined,
        artifactError("artifact_not_found", "artifact not found", {
          artifactId: params.artifactId,
        }),
      );
      return;
    }
    respond(true, { artifact: toSummary(artifact) });
  },
  "artifacts.download": async ({ params, respond }) => {
    if (
      !assertValidParams(params, validateArtifactsDownloadParams, "artifacts.download", respond)
    ) {
      return;
    }
    if (!requireQueryable(params, respond)) {
      return;
    }
    const { artifact } = await findArtifact(params);
    if (!artifact) {
      respond(
        false,
        undefined,
        artifactError("artifact_not_found", "artifact not found", {
          artifactId: params.artifactId,
        }),
      );
      return;
    }
    if (artifact.download.mode === "unsupported") {
      respond(
        false,
        undefined,
        artifactError("artifact_download_unsupported", "artifact download is unsupported", {
          artifactId: artifact.id,
        }),
      );
      return;
    }
    respond(true, {
      artifact: toSummary(artifact),
      ...(artifact.download.mode === "bytes"
        ? { encoding: "base64" as const, data: artifact.data }
        : {}),
      ...(artifact.download.mode === "url" ? { url: artifact.url } : {}),
    });
  },
};
