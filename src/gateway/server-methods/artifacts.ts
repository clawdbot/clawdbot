import { createHash } from "node:crypto";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
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
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
} from "../session-store-key.js";
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
  agentId?: string;
};

type ResolvedArtifactSession = {
  sessionKey: string;
  agentId?: string;
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

function resolveRequesterSessionAgentId(
  sessionKey: string | undefined,
  cfg?: OpenClawConfig,
): string | undefined {
  const key = asNonEmptyString(sessionKey);
  if (!key) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(key);
  if (!parsed && key.toLowerCase().startsWith("agent:")) {
    return undefined;
  }
  if (cfg) {
    const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey: key });
    return resolveSessionStoreAgentId(cfg, canonicalKey);
  }
  if (parsed) {
    return parsed.agentId;
  }
  return resolveAgentIdFromSessionKey(key);
}

function resolveScopedArtifactSessionKey(
  sessionKey: string | undefined,
  agentId: string | undefined,
  cfg?: OpenClawConfig,
): string | undefined {
  const key = asNonEmptyString(sessionKey);
  if (!key) {
    return undefined;
  }
  const scopedAgentId = asNonEmptyString(agentId);
  if (!scopedAgentId) {
    return key;
  }
  const parsed = parseAgentSessionKey(key);
  if (!parsed && key.toLowerCase().startsWith("agent:")) {
    return undefined;
  }
  if (cfg) {
    const scopedKey = resolveStoredSessionKeyForAgentStore({
      cfg,
      agentId: scopedAgentId,
      sessionKey: key,
    });
    if (
      scopedKey !== "global" &&
      scopedKey !== "unknown" &&
      resolveSessionStoreAgentId(cfg, scopedKey) !== normalizeAgentId(scopedAgentId)
    ) {
      return undefined;
    }
    return scopedKey;
  }
  if (parsed && parsed.agentId !== normalizeAgentId(scopedAgentId)) {
    return undefined;
  }
  return toAgentStoreSessionKey({ agentId: scopedAgentId, requestKey: key });
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

function resolveQuerySession(
  query: ArtifactQuery,
  cfg?: OpenClawConfig,
): ResolvedArtifactSession | undefined {
  if (query.sessionKey) {
    const sessionKey = resolveScopedArtifactSessionKey(query.sessionKey, query.agentId, cfg);
    if (!sessionKey) {
      return undefined;
    }
    return { sessionKey, ...(query.agentId ? { agentId: query.agentId } : {}) };
  }
  if (query.runId) {
    const agentId = query.agentId ?? resolveDefaultAgentId(cfg ?? {});
    const sessionKey = resolveSessionKeyForRun(query.runId, { agentId });
    const scopedSessionKey = resolveScopedArtifactSessionKey(sessionKey, agentId, cfg);
    return scopedSessionKey ? { sessionKey: scopedSessionKey, agentId } : undefined;
  }
  if (query.taskId) {
    const task = getTaskSessionLookupByIdForStatus(query.taskId);
    const requesterSessionKey = asNonEmptyString(task?.requesterSessionKey);
    const taskAgentId =
      asNonEmptyString(task?.agentId) ?? resolveRequesterSessionAgentId(requesterSessionKey, cfg);
    if (
      query.agentId &&
      taskAgentId &&
      normalizeAgentId(query.agentId) !== normalizeAgentId(taskAgentId)
    ) {
      return undefined;
    }
    const agentId = query.agentId ?? taskAgentId ?? resolveDefaultAgentId(cfg ?? {});
    if (requesterSessionKey) {
      const scopedSessionKey = resolveScopedArtifactSessionKey(requesterSessionKey, agentId, cfg);
      return scopedSessionKey ? { sessionKey: scopedSessionKey, agentId } : undefined;
    }
    const runId = asNonEmptyString(task?.runId);
    const sessionKey = runId ? resolveSessionKeyForRun(runId, { agentId }) : undefined;
    const scopedSessionKey = resolveScopedArtifactSessionKey(sessionKey, agentId, cfg);
    return scopedSessionKey ? { sessionKey: scopedSessionKey, agentId } : undefined;
  }
  return undefined;
}

async function loadArtifacts(
  query: ArtifactQuery,
  cfg?: OpenClawConfig,
): Promise<{ artifacts: ArtifactRecord[]; sessionKey?: string }> {
  const resolved = resolveQuerySession(query, cfg);
  if (!resolved) {
    return { artifacts: [] };
  }
  const { sessionKey } = resolved;
  const scopedGlobalAgentId =
    cfg?.session?.scope === "global" && sessionKey === "global" ? resolved.agentId : undefined;
  const { storePath, entry } = scopedGlobalAgentId
    ? loadSessionEntry(sessionKey, { agentId: scopedGlobalAgentId })
    : loadSessionEntry(sessionKey);
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

async function findArtifact(
  params: ArtifactsGetParams,
  cfg?: OpenClawConfig,
): Promise<{
  artifact?: ArtifactRecord;
  sessionKey?: string;
}> {
  const loaded = await loadArtifacts(params, cfg);
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
  "artifacts.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateArtifactsListParams, "artifacts.list", respond)) {
      return;
    }
    if (!requireQueryable(params, respond)) {
      return;
    }
    const { artifacts, sessionKey } = await loadArtifacts(params, context.getRuntimeConfig?.());
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
  "artifacts.get": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateArtifactsGetParams, "artifacts.get", respond)) {
      return;
    }
    if (!requireQueryable(params, respond)) {
      return;
    }
    const { artifact } = await findArtifact(params, context.getRuntimeConfig?.());
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
  "artifacts.download": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateArtifactsDownloadParams, "artifacts.download", respond)
    ) {
      return;
    }
    if (!requireQueryable(params, respond)) {
      return;
    }
    const { artifact } = await findArtifact(params, context.getRuntimeConfig?.());
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
