// Artifact gateway methods collect generated artifacts from session transcripts
// and expose list/get/download RPCs scoped by session, run, task, or agent.
import { createHash } from "node:crypto";
import { isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString as asNonEmptyString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ArtifactSummary,
  type ArtifactsGetParams,
  validateArtifactsDownloadParams,
  validateArtifactsGetParams,
  validateArtifactsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { readAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import {
  parseManagedOutgoingArtifactId,
  resolveManagedOutgoingMediaArtifactDownload,
  resolveManagedOutgoingMediaUrlDownload,
} from "../managed-image-attachments.js";
import {
  resolveRequestedSessionAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import { visitSessionMessagesAsync } from "../session-transcript-readers.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import {
  type ArtifactBase64Payload,
  base64FromDataUrl,
  mimeFromDataUrl,
  readArtifactBase64Payload,
} from "./artifacts-base64.js";
import {
  ArtifactSessionResolutionError,
  type ArtifactQuery,
  resolveAuthorizedArtifactSession,
} from "./artifacts-session-resolution.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

type ArtifactDownloadMode = ArtifactSummary["download"]["mode"];

type ArtifactRecord = ArtifactSummary & {
  data?: string;
  url?: string;
};

type ArtifactCollectionOptions = {
  includeDownloadData?: boolean;
  downloadArtifactId?: string;
};

function admitArtifactQuery<T extends ArtifactQuery>(
  query: T,
  cfg: OpenClawConfig | undefined,
  respond: RespondFn,
): T | undefined {
  const sessionKey = asNonEmptyString(query.sessionKey);
  if (!sessionKey || !cfg) {
    return query;
  }
  const owner = resolveRequestedSessionAgentId(cfg, sessionKey, query.agentId);
  if (!owner.ok) {
    respond(false, undefined, owner.error);
    return undefined;
  }
  return { ...query, agentId: owner.agentId };
}

function artifactError(type: string, message: string, details?: Record<string, unknown>) {
  return errorShape(ErrorCodes.INVALID_REQUEST, message, {
    details: {
      type,
      ...details,
    },
  });
}

function normalizeArtifactType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "image" || normalized === "input_image" || normalized === "image_url") {
    return "image";
  }
  if (normalized === "audio" || normalized === "input_audio") {
    return "audio";
  }
  if (normalized === "video" || normalized === "input_video") {
    return "video";
  }
  if (normalized === "file" || normalized === "input_file") {
    return "file";
  }
  if (normalized === "attachment") {
    return "file";
  }
  return "file";
}

function mediaUrlValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return asNonEmptyString(value);
  }
  const record = asOptionalRecord(value);
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
  return isHttpUrl(trimmed);
}

/** Generates a stable id from transcript position plus display metadata. */
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
  const meta = asOptionalRecord(message["__openclaw"]);
  const seq = meta?.seq;
  return typeof seq === "number" && Number.isInteger(seq) && seq > 0 ? seq : fallback;
}

function resolveMessageRunId(message: Record<string, unknown>): string | undefined {
  const meta = asOptionalRecord(message["__openclaw"]);
  return asNonEmptyString(meta?.runId) ?? asNonEmptyString(message.runId);
}

function resolveMessageTaskId(message: Record<string, unknown>): string | undefined {
  const meta = asOptionalRecord(message["__openclaw"]);
  return (
    asNonEmptyString(meta?.messageTaskId) ??
    asNonEmptyString(meta?.taskId) ??
    asNonEmptyString(message.messageTaskId) ??
    asNonEmptyString(message.taskId)
  );
}

function resolveBlockDownload(
  block: Record<string, unknown>,
  opts: { includeData: boolean },
): {
  mode: ArtifactDownloadMode;
  data?: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
} {
  const data = readStringValue(block.data)?.trim();
  const content = readStringValue(block.content)?.trim();
  const url = asNonEmptyString(block.url) ?? asNonEmptyString(block.openUrl);
  const imageUrl = mediaUrlValue(block.image_url);
  const audioUrl = asNonEmptyString(block.audio_url);
  const source = asOptionalRecord(block.source);
  const sourceData = readStringValue(source?.data)?.trim();
  const sourceUrl = asNonEmptyString(source?.url);
  const dataUrl = [url, sourceUrl, imageUrl, audioUrl, data, content, sourceData].find(
    (value) => typeof value === "string" && /^data:/i.test(value),
  );
  const base64FromDetectedDataUrl = readArtifactBase64Payload(
    dataUrl ? base64FromDataUrl(dataUrl) : undefined,
    opts,
  );
  const directBase64 = [data, sourceData, content]
    .filter((value): value is string => typeof value === "string" && !/^data:/i.test(value))
    .map((value) => readArtifactBase64Payload(value, opts))
    .find((value): value is ArtifactBase64Payload => value !== undefined);
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
      : base64?.sizeBytes;
  if (base64) {
    return { mode: "bytes", data: base64.data, mimeType, sizeBytes };
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
    type === "video" ||
    type === "file" ||
    type === "attachment" ||
    type === "input_image" ||
    type === "input_audio" ||
    type === "input_video" ||
    type === "input_file" ||
    type === "image_url"
  ) {
    return true;
  }
  return (
    typeof block.data === "string" ||
    Boolean(block.url || block.openUrl || block.source || block.image_url || block.audio_url)
  );
}

function collectArtifactsFromMessage(params: {
  message: unknown;
  messageFallbackSeq: number;
  artifacts: ArtifactRecord[];
  sessionKey: string;
  runId?: string;
  taskId?: string;
  includeDownloadData?: boolean;
  downloadArtifactId?: string;
}): void {
  const msg = asOptionalRecord(params.message);
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
  const content = readAssistantDisplayContent(msg);
  for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
    const block = asOptionalRecord(content[contentIndex]);
    if (!block || !isArtifactBlock(block)) {
      continue;
    }
    const type = normalizeArtifactType(asNonEmptyString(block.type) ?? "file");
    const attachment = asOptionalRecord(block.attachment);
    const title =
      asNonEmptyString(block.title) ??
      asNonEmptyString(block.fileName) ??
      asNonEmptyString(block.filename) ??
      asNonEmptyString(block.alt) ??
      asNonEmptyString(attachment?.label) ??
      `${type} ${params.artifacts.length + 1}`;
    const declaredArtifactId =
      asNonEmptyString(block.artifactId) ?? asNonEmptyString(attachment?.artifactId);
    const id =
      declaredArtifactId && parseManagedOutgoingArtifactId(declaredArtifactId)
        ? declaredArtifactId
        : artifactId({
            sessionKey: params.sessionKey,
            messageSeq,
            contentIndex,
            title,
            type,
          });
    const includeData = params.downloadArtifactId
      ? params.downloadArtifactId === id
      : params.includeDownloadData !== false;
    const download = resolveBlockDownload(attachment ?? block, { includeData });
    const summary: ArtifactRecord = {
      id,
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
      ...(download.data !== undefined ? { data: download.data } : {}),
      ...(download.url ? { url: download.url } : {}),
    };
    params.artifacts.push(summary);
  }
}

/** Loads artifacts from the transcript selected by sessionKey, runId, or taskId. */
async function loadArtifacts(
  query: ArtifactQuery,
  cfg?: OpenClawConfig,
  opts: ArtifactCollectionOptions = {},
  client: GatewayClient | null = null,
): Promise<{ artifacts: ArtifactRecord[]; sessionKey?: string }> {
  const resolved = resolveAuthorizedArtifactSession(query, cfg, client);
  if (!resolved) {
    return { artifacts: [] };
  }
  const { sessionKey } = resolved;
  const unscopedAgentId = parseAgentSessionKey(sessionKey) ? undefined : resolved.agentId;
  const { storePath, entry } = unscopedAgentId
    ? loadGatewaySessionEntryReadOnly(sessionKey, { agentId: unscopedAgentId })
    : loadGatewaySessionEntryReadOnly(sessionKey);
  const sessionId = entry?.sessionId;
  if (!sessionId || !storePath) {
    return { sessionKey, artifacts: [] };
  }
  const artifacts: ArtifactRecord[] = [];
  await visitSessionMessagesAsync(
    {
      agentId: resolved.agentId ?? resolveAgentIdFromSessionKey(sessionKey),
      sessionEntry: entry,
      sessionId,
      sessionKey,
      storePath,
    },
    (message, seq) => {
      collectArtifactsFromMessage({
        message,
        messageFallbackSeq: seq,
        artifacts,
        sessionKey,
        runId: query.runId,
        taskId: query.taskId,
        includeDownloadData: opts.includeDownloadData,
        downloadArtifactId: opts.downloadArtifactId,
      });
    },
    {
      mode: "full",
      reason: "artifact query transcript scan",
      cache: "skip",
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

function respondArtifactNotFound(respond: RespondFn, requestedArtifactId: string): void {
  respond(
    false,
    undefined,
    artifactError("artifact_not_found", "artifact not found", {
      artifactId: requestedArtifactId,
    }),
  );
}

async function runArtifactSessionOperation<T>(
  respond: RespondFn,
  operation: () => Promise<T> | T,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof ArtifactSessionResolutionError) {
      respond(false, undefined, error.shape);
      return { ok: false };
    }
    if (error instanceof AgentSelectionRequiredError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
      return { ok: false };
    }
    throw error;
  }
}

async function findArtifact(
  params: ArtifactsGetParams,
  cfg?: OpenClawConfig,
  opts: ArtifactCollectionOptions = {},
  client: GatewayClient | null = null,
): Promise<{
  artifact?: ArtifactRecord;
  sessionKey?: string;
}> {
  const loaded = await loadArtifacts(params, cfg, opts, client);
  return {
    sessionKey: loaded.sessionKey,
    artifact: loaded.artifacts.find((artifact) => artifact.id === params.artifactId),
  };
}

function toSummary(artifact: ArtifactRecord): ArtifactSummary {
  const { data: _dataValue, url: _url, ...summary } = artifact;
  return summary;
}

/** Gateway handlers for listing, summarizing, and downloading transcript artifacts. */
export const artifactsHandlers: GatewayRequestHandlers = {
  "artifacts.list": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateArtifactsListParams, "artifacts.list", respond)) {
      return;
    }
    if (!requireQueryable(params, respond)) {
      return;
    }
    const cfg = context.getRuntimeConfig?.();
    const admittedQuery = admitArtifactQuery(params, cfg, respond);
    if (!admittedQuery) {
      return;
    }
    const loaded = await runArtifactSessionOperation(respond, () =>
      loadArtifacts(admittedQuery, cfg, { includeDownloadData: false }, client),
    );
    if (!loaded.ok) {
      return;
    }
    const { artifacts, sessionKey } = loaded.value;
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
  "artifacts.get": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateArtifactsGetParams, "artifacts.get", respond)) {
      return;
    }
    if (!requireQueryable(params, respond)) {
      return;
    }
    const cfg = context.getRuntimeConfig?.();
    const admittedQuery = admitArtifactQuery(params, cfg, respond);
    if (!admittedQuery) {
      return;
    }
    const found = await runArtifactSessionOperation(respond, () =>
      findArtifact(admittedQuery, cfg, { includeDownloadData: false }, client),
    );
    if (!found.ok) {
      return;
    }
    const { artifact } = found.value;
    if (!artifact) {
      respondArtifactNotFound(respond, params.artifactId);
      return;
    }
    respond(true, { artifact: toSummary(artifact) });
  },
  "artifacts.download": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(params, validateArtifactsDownloadParams, "artifacts.download", respond)
    ) {
      return;
    }
    if (!requireQueryable(params, respond)) {
      return;
    }
    const cfg = context.getRuntimeConfig?.();
    const admittedQuery = admitArtifactQuery(params, cfg, respond);
    if (!admittedQuery) {
      return;
    }
    if (
      admittedQuery.sessionKey &&
      !admittedQuery.runId &&
      !admittedQuery.taskId &&
      parseManagedOutgoingArtifactId(params.artifactId)
    ) {
      const resolvedResult = await runArtifactSessionOperation(respond, () =>
        resolveAuthorizedArtifactSession(admittedQuery, cfg, client),
      );
      if (!resolvedResult.ok) {
        return;
      }
      const resolved = resolvedResult.value;
      const defaultAgentId = resolved
        ? tryResolveSessionCompatibilityOwnerAgentId(cfg ?? {}, resolved.sessionKey)
        : undefined;
      const managed = resolved
        ? await resolveManagedOutgoingMediaArtifactDownload({
            sessionKey: resolved.sessionKey,
            ...(resolved.agentId ? { agentId: resolved.agentId } : {}),
            ...(defaultAgentId ? { defaultAgentId } : {}),
            artifactId: params.artifactId,
          })
        : null;
      if (managed) {
        respond(true, {
          artifact: {
            id: managed.artifactId,
            type: managed.type,
            title: managed.title,
            ...(managed.mimeType ? { mimeType: managed.mimeType } : {}),
            ...(managed.sizeBytes !== undefined ? { sizeBytes: managed.sizeBytes } : {}),
            sessionKey: managed.sessionKey,
            source: "session-transcript",
            download: { mode: "url" as const },
          },
          url: managed.url,
          expiresAt: managed.expiresAt,
        });
        return;
      }
      respondArtifactNotFound(respond, params.artifactId);
      return;
    }
    const found = await runArtifactSessionOperation(respond, () =>
      findArtifact(admittedQuery, cfg, { downloadArtifactId: params.artifactId }, client),
    );
    if (!found.ok) {
      return;
    }
    const { artifact } = found.value;
    if (!artifact) {
      respondArtifactNotFound(respond, params.artifactId);
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
    const managedUrl =
      artifact.download.mode === "url" && artifact.url && artifact.sessionKey
        ? await resolveManagedOutgoingMediaUrlDownload({
            sessionKey: artifact.sessionKey,
            url: artifact.url,
          })
        : null;
    respond(true, {
      artifact: toSummary(artifact),
      ...(artifact.download.mode === "bytes"
        ? { encoding: "base64" as const, data: artifact.data }
        : {}),
      ...(artifact.download.mode === "url"
        ? {
            url: managedUrl?.url ?? artifact.url,
            ...(managedUrl ? { expiresAt: managedUrl.expiresAt } : {}),
          }
        : {}),
    });
  },
};
