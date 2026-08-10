// Google plugin module implements embedding batch behavior.
import { randomUUID } from "node:crypto";
import {
  buildEmbeddingBatchGroupOptions,
  runEmbeddingBatchGroups,
  buildBatchHeaders,
  debugEmbeddingsLog,
  EmbeddingBatchUnavailableError,
  formatBatchErrorDetail,
  normalizeBatchBaseUrl,
  readEmbeddingBatchJsonl,
  sanitizeAndNormalizeEmbedding,
  withRemoteHttpResponse,
  type EmbeddingBatchExecutionParams,
  type MemoryEmbeddingBatchSubmissionLifecycle,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  assertOkOrThrowProviderError,
  createProviderOperationDeadline,
  createProviderHttpError,
  executeProviderOperationWithRetry,
  readProviderJsonObjectResponse,
  resolveProviderOperationTimeoutMs,
  type ProviderOperationDeadline,
} from "openclaw/plugin-sdk/provider-http";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import type { GeminiEmbeddingClient, GeminiTextEmbeddingRequest } from "./embedding-provider.js";
import { parseGeminiAuth } from "./gemini-auth.js";

type GeminiBatchRequest = {
  custom_id: string;
  request: GeminiTextEmbeddingRequest;
};

type GeminiBatchOperation = {
  name?: string;
  done?: boolean;
  metadata?: {
    state?: string;
    output?: {
      responsesFile?: string;
    };
  };
  response?: { responsesFile?: string };
  error?: { code?: number; message?: string };
};

type GeminiBatchState = "pending" | "succeeded" | "failed" | "cancelled" | "expired" | "unknown";

type GeminiBatchOutputLine = {
  // Alternate ids and direct embeddings are shipped compatible-endpoint shapes.
  key?: string;
  custom_id?: string;
  request_id?: string;
  embedding?: { values?: number[] };
  response?: {
    embedding?: { values?: number[] };
    error?: { message?: string };
  };
  error?: { message?: string };
};

const GEMINI_BATCH_MAX_REQUESTS = 50000;
const GEMINI_BATCH_OUTPUT_DOWNLOAD_ATTEMPTS = 2;

type GeminiBatchSplitReason = "upload-too-large";

class GeminiBatchOutputIncompleteError extends Error {}

function formatGeminiBatchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readGeminiBatchErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const candidate = error as { status?: unknown; statusCode?: unknown };
  const value = candidate.status ?? candidate.statusCode;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function isRetryableGeminiBatchOutputError(error: unknown, message: string): boolean {
  if (error instanceof GeminiBatchOutputIncompleteError) {
    return true;
  }
  const status = readGeminiBatchErrorStatus(error);
  if (status !== undefined) {
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  }
  return /malformed JSONL record|fetch failed|ECONNRESET|EPIPE|socket|stream|terminated|premature|unexpected end|timed out|timeout/i.test(
    message,
  );
}

function classifyGeminiBatchSplitError(error: unknown): GeminiBatchSplitReason | null {
  const message = formatGeminiBatchError(error);
  if (
    /gemini\.batch-file-upload/i.test(message) &&
    (/\b413\b/.test(message) ||
      /payload too large/i.test(message) ||
      /request body too large/i.test(message) ||
      /file too large/i.test(message) ||
      /maximum allowed/i.test(message))
  ) {
    return "upload-too-large";
  }
  return null;
}

function isDefinitiveGeminiBatchCreateRejection(error: unknown): boolean {
  if (error instanceof EmbeddingBatchUnavailableError) {
    return true;
  }
  const status = readGeminiBatchErrorStatus(error);
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
}

function bindGeminiBatchAuth(client: GeminiEmbeddingClient): GeminiEmbeddingClient {
  const apiKey = client.apiKeys[0];
  if (!apiKey) {
    throw new Error("gemini batch requires an API key");
  }
  // Files and batch operations are credential-scoped. Keep one selected
  // credential for upload, creation, polling, and output download.
  return {
    ...client,
    headers: {
      ...parseGeminiAuth(apiKey).headers,
      ...client.headers,
    },
  };
}

function createGeminiBatchStageSignal(params: {
  deadline: ProviderOperationDeadline;
  timeoutMs: number;
  signal?: AbortSignal;
}): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(
    resolveProviderOperationTimeoutMs({
      deadline: params.deadline,
      defaultTimeoutMs: params.timeoutMs,
    }),
  );
  return params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
}

function getGeminiVersionedRouteBase(baseUrl: string, route: "upload" | "download"): string | null {
  const trimmed = baseUrl.replace(/\/$/, "");
  const match = trimmed.match(/^(.*)\/(v\d+(?:alpha|beta)?)$/);
  return match ? `${match[1]}/${route}/${match[2]}` : null;
}

function getGeminiUploadUrl(baseUrl: string): string {
  return getGeminiVersionedRouteBase(baseUrl, "upload") ?? `${baseUrl.replace(/\/$/, "")}/upload`;
}

function getGeminiDownloadUrl(baseUrl: string, fileId: string): string {
  const file = fileId.startsWith("files/") ? fileId : `files/${fileId}`;
  const trimmed = baseUrl.replace(/\/$/, "");
  let officialGoogleOrigin = false;
  try {
    officialGoogleOrigin =
      new URL(trimmed).origin.toLowerCase() === "https://generativelanguage.googleapis.com";
  } catch {
    // Custom base URLs are preserved below.
  }
  const downloadBase = officialGoogleOrigin
    ? (getGeminiVersionedRouteBase(trimmed, "download") ?? trimmed)
    : trimmed;
  return `${downloadBase}/${file}:download?alt=media`;
}

function getGeminiBatchState(operation: GeminiBatchOperation): GeminiBatchState {
  // REST discovery uses BATCH_STATE_* while the public guide and SDK expose
  // JOB_STATE_* for the same operation metadata.
  const rawState = operation.metadata?.state?.replace(/^(?:BATCH|JOB)_STATE_/, "");
  if (rawState === "FAILED") {
    return "failed";
  }
  if (rawState === "CANCELLED" || rawState === "CANCELED") {
    return "cancelled";
  }
  if (rawState === "EXPIRED") {
    return "expired";
  }
  if (operation.error) {
    return "failed";
  }
  if (operation.done === false) {
    return "pending";
  }
  if (operation.done === true) {
    return "succeeded";
  }
  if (rawState === "SUCCEEDED") {
    return "succeeded";
  }
  if (rawState === "PENDING" || rawState === "RUNNING") {
    return "pending";
  }
  return "unknown";
}

function getGeminiBatchOutputFileId(operation: GeminiBatchOperation): string | undefined {
  // Google currently documents response.responsesFile while the official SDK
  // consumes metadata.output.responsesFile. Accept both raw Operation shapes.
  const responseFile = operation.response?.responsesFile;
  const metadataFile = operation.metadata?.output?.responsesFile;
  if (responseFile && metadataFile && responseFile !== metadataFile) {
    throw new Error("gemini batch operation returned conflicting output files");
  }
  return responseFile ?? metadataFile;
}

function buildGeminiUploadBody(params: { jsonl: string; displayName: string }): {
  body: Blob;
  contentType: string;
} {
  const boundary = `openclaw-${randomUUID()}`;
  const jsonPart = JSON.stringify({
    file: {
      displayName: params.displayName,
      mimeType: "application/jsonl",
    },
  });
  const delimiter = `--${boundary}\r\n`;
  const closeDelimiter = `--${boundary}--\r\n`;
  const parts = [
    `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${jsonPart}\r\n`,
    `${delimiter}Content-Type: application/jsonl; charset=UTF-8\r\n\r\n${params.jsonl}\r\n`,
    closeDelimiter,
  ];
  const body = new Blob([parts.join("")], { type: "multipart/related" });
  return {
    body,
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

async function submitGeminiBatch(params: {
  gemini: GeminiEmbeddingClient;
  requests: GeminiBatchRequest[];
  deadline: ProviderOperationDeadline;
  timeoutMs: number;
  signal?: AbortSignal;
  submissionLifecycle?: MemoryEmbeddingBatchSubmissionLifecycle;
}): Promise<GeminiBatchOperation> {
  const baseUrl = normalizeBatchBaseUrl(params.gemini);
  const jsonl = params.requests
    .map((request) =>
      JSON.stringify({
        key: request.custom_id,
        request: request.request,
      }),
    )
    .join("\n");
  // Google exposes no create idempotency key. Use a content-independent id for
  // durable operator correlation; upload/create remain one-shot.
  const submissionId = `openclaw-memory-${randomUUID()}`;
  const displayName = submissionId;
  const uploadPayload = buildGeminiUploadBody({ jsonl, displayName });

  const uploadUrl = `${getGeminiUploadUrl(baseUrl)}/files?uploadType=multipart`;
  debugEmbeddingsLog("memory embeddings: gemini batch upload", {
    uploadUrl,
    baseUrl,
    requests: params.requests.length,
  });
  const uploadSignal = createGeminiBatchStageSignal(params);
  const filePayload = await executeProviderOperationWithRetry({
    provider: "gemini",
    stage: "create",
    signal: uploadSignal,
    operation: async () =>
      await withRemoteHttpResponse({
        url: uploadUrl,
        ssrfPolicy: params.gemini.ssrfPolicy,
        signal: uploadSignal,
        init: {
          method: "POST",
          headers: {
            ...buildBatchHeaders(params.gemini, { json: false }),
            "Content-Type": uploadPayload.contentType,
          },
          body: uploadPayload.body,
        },
        onResponse: async (fileRes) => {
          await assertOkOrThrowProviderError(fileRes, "gemini.batch-file-upload");
          return (await readProviderJsonObjectResponse(fileRes, "gemini.batch-file-upload")) as {
            file?: { name?: string };
          };
        },
      }),
  });
  const fileId = filePayload.file?.name;
  if (!fileId) {
    throw new Error("gemini batch file upload failed: missing file id");
  }

  const batchBody = {
    batch: {
      displayName,
      inputConfig: {
        file_name: fileId,
      },
    },
  };

  const batchEndpoint = `${baseUrl}/${params.gemini.modelPath}:asyncBatchEmbedContent`;
  debugEmbeddingsLog("memory embeddings: gemini batch create", {
    batchEndpoint,
    fileId,
  });
  await params.submissionLifecycle?.started({ submissionId });
  const createSignal = createGeminiBatchStageSignal(params);
  let createOperationStarted = false;
  try {
    const operation = await executeProviderOperationWithRetry({
      provider: "gemini",
      stage: "create",
      signal: createSignal,
      operation: async () => {
        createOperationStarted = true;
        return await withRemoteHttpResponse({
          url: batchEndpoint,
          ssrfPolicy: params.gemini.ssrfPolicy,
          signal: createSignal,
          init: {
            method: "POST",
            headers: buildBatchHeaders(params.gemini, { json: true }),
            body: JSON.stringify(batchBody),
          },
          onResponse: async (batchRes) => {
            if (batchRes.status === 404) {
              const cause = await createProviderHttpError(batchRes, "gemini.batch-create");
              throw new EmbeddingBatchUnavailableError(
                "gemini asyncBatchEmbedContent not available for this request",
                { cause },
              );
            }
            await assertOkOrThrowProviderError(batchRes, "gemini.batch-create");
            return (await readProviderJsonObjectResponse(
              batchRes,
              "gemini.batch-create",
            )) as GeminiBatchOperation;
          },
        });
      },
    });
    const batchName = operation.name;
    if (!batchName) {
      throw new Error("gemini batch create failed: missing batch name");
    }
    await params.submissionLifecycle?.accepted({ submissionId, batchName });
    return operation;
  } catch (error) {
    if (!createOperationStarted || isDefinitiveGeminiBatchCreateRejection(error)) {
      await params.submissionLifecycle?.rejected({ submissionId });
    }
    throw error;
  }
}

async function fetchGeminiBatchStatus(params: {
  gemini: GeminiEmbeddingClient;
  batchName: string;
  signal?: AbortSignal;
}): Promise<GeminiBatchOperation> {
  const baseUrl = normalizeBatchBaseUrl(params.gemini);
  const name = params.batchName.startsWith("batches/")
    ? params.batchName
    : `batches/${params.batchName}`;
  const statusUrl = `${baseUrl}/${name}`;
  debugEmbeddingsLog("memory embeddings: gemini batch status", { statusUrl });
  return await withRemoteHttpResponse({
    url: statusUrl,
    ssrfPolicy: params.gemini.ssrfPolicy,
    signal: params.signal,
    init: {
      headers: buildBatchHeaders(params.gemini, { json: true }),
    },
    onResponse: async (res) => {
      await assertOkOrThrowProviderError(res, "gemini.batch-status");
      return (await readProviderJsonObjectResponse(
        res,
        "gemini.batch-status",
      )) as GeminiBatchOperation;
    },
  });
}

function applyGeminiBatchOutputLine(params: {
  line: GeminiBatchOutputLine;
  remaining: Set<string>;
  errors: string[];
  byCustomId: Map<string, number[]>;
}): void {
  const customId = params.line.key ?? params.line.custom_id ?? params.line.request_id;
  // Only the first response for a submitted id may mutate results.
  if (!customId || !params.remaining.delete(customId)) {
    return;
  }
  const error = params.line.error?.message || params.line.response?.error?.message;
  if (error) {
    params.errors.push(`${customId}: ${error}`);
    return;
  }
  const embedding = sanitizeAndNormalizeEmbedding(
    params.line.embedding?.values ?? params.line.response?.embedding?.values ?? [],
  );
  if (embedding.length === 0) {
    params.errors.push(`${customId}: empty embedding`);
    return;
  }
  params.byCustomId.set(customId, embedding);
}

async function fetchGeminiBatchOutput(params: {
  gemini: GeminiEmbeddingClient;
  fileId: string;
  expectedRecords: number;
  remaining: Set<string>;
  errors: string[];
  byCustomId: Map<string, number[]>;
  signal?: AbortSignal;
}): Promise<void> {
  const baseUrl = normalizeBatchBaseUrl(params.gemini);
  const downloadUrl = getGeminiDownloadUrl(baseUrl, params.fileId);
  debugEmbeddingsLog("memory embeddings: gemini batch download", { downloadUrl });
  await withRemoteHttpResponse({
    url: downloadUrl,
    ssrfPolicy: params.gemini.ssrfPolicy,
    signal: params.signal,
    init: {
      headers: buildBatchHeaders(params.gemini, { json: true }),
    },
    onResponse: async (res) => {
      await assertOkOrThrowProviderError(res, "gemini.batch-file-content");
      await readEmbeddingBatchJsonl<GeminiBatchOutputLine>(res, {
        label: "gemini.batch-file-content",
        maxRecords: params.expectedRecords,
        onRecord: (line) => {
          applyGeminiBatchOutputLine({
            line,
            remaining: params.remaining,
            errors: params.errors,
            byCustomId: params.byCustomId,
          });
          return params.errors.length === 0 && params.remaining.size > 0;
        },
      });
    },
  });
}

async function downloadGeminiBatchOutputWithRetry(params: {
  gemini: GeminiEmbeddingClient;
  batchName: string;
  fileId: string;
  requests: GeminiBatchRequest[];
  deadline: ProviderOperationDeadline;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{
  byCustomId: Map<string, number[]>;
  errors: string[];
  remaining: Set<string>;
}> {
  const downloadSignal = createGeminiBatchStageSignal(params);
  return await executeProviderOperationWithRetry({
    provider: "gemini",
    stage: "download",
    signal: downloadSignal,
    retry: {
      attempts: GEMINI_BATCH_OUTPUT_DOWNLOAD_ATTEMPTS,
      signal: downloadSignal,
      shouldRetry: ({ error, message }) => isRetryableGeminiBatchOutputError(error, message),
    },
    operation: async () => {
      // Each retry parses into attempt-local state. Nothing becomes visible to
      // the caller until one complete immutable-file read validates, so a
      // partial first response cannot overwrite or duplicate committed rows.
      const byCustomId = new Map<string, number[]>();
      const errors: string[] = [];
      const remaining = new Set(params.requests.map((request) => request.custom_id));
      await fetchGeminiBatchOutput({
        gemini: params.gemini,
        fileId: params.fileId,
        expectedRecords: params.requests.length,
        remaining,
        errors,
        byCustomId,
        signal: downloadSignal,
      });
      if (errors.length === 0 && remaining.size > 0) {
        throw new GeminiBatchOutputIncompleteError(
          `gemini batch ${params.batchName} output incomplete: missing ${remaining.size} responses`,
        );
      }
      return { byCustomId, errors, remaining };
    },
  });
}

async function waitForGeminiBatch(params: {
  gemini: GeminiEmbeddingClient;
  batchName: string;
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  deadline: ProviderOperationDeadline;
  signal?: AbortSignal;
  debug?: (message: string, data?: Record<string, unknown>) => void;
  initial?: GeminiBatchOperation;
}): Promise<{ outputFileId: string }> {
  let current: GeminiBatchOperation | undefined = params.initial;
  while (true) {
    let operation: GeminiBatchOperation;
    if (current) {
      operation = current;
    } else {
      const pollSignal = createGeminiBatchStageSignal(params);
      operation = await executeProviderOperationWithRetry({
        provider: "gemini",
        stage: "poll",
        signal: pollSignal,
        operation: async () =>
          await fetchGeminiBatchStatus({
            gemini: params.gemini,
            batchName: params.batchName,
            signal: pollSignal,
          }),
      });
    }
    const state = getGeminiBatchState(operation);
    if (state === "succeeded") {
      const outputFileId = getGeminiBatchOutputFileId(operation);
      if (!outputFileId) {
        throw new Error(`gemini batch ${params.batchName} completed without output file`);
      }
      return { outputFileId };
    }
    if (state === "failed" || state === "cancelled" || state === "expired") {
      const rawMessage =
        operation.error?.message ??
        (operation.error?.code === undefined ? "unknown error" : `code ${operation.error.code}`);
      throw new Error(
        `gemini batch ${params.batchName} ${state}: ${formatBatchErrorDetail(rawMessage) ?? "unknown error"}`,
      );
    }
    if (!params.wait) {
      throw new Error(
        `gemini batch ${params.batchName} submitted; enable remote.batch.wait to await completion`,
      );
    }
    params.debug?.(
      `gemini batch ${params.batchName} ${state}; waiting up to ${params.pollIntervalMs}ms`,
    );
    const waitMs = resolveProviderOperationTimeoutMs({
      deadline: params.deadline,
      defaultTimeoutMs: params.pollIntervalMs,
    });
    await sleepWithAbort(waitMs, params.signal);
    current = undefined;
  }
}

export async function runGeminiEmbeddingBatches(
  params: {
    gemini: GeminiEmbeddingClient;
    agentId: string;
    requests: GeminiBatchRequest[];
    submissionLifecycle?: MemoryEmbeddingBatchSubmissionLifecycle;
  } & EmbeddingBatchExecutionParams,
): Promise<Map<string, number[]>> {
  if (!params.wait) {
    throw new Error(
      "gemini native embedding batches require remote.batch.wait=true to avoid orphaned jobs",
    );
  }
  const gemini = bindGeminiBatchAuth(params.gemini);
  return await runEmbeddingBatchGroups({
    ...buildEmbeddingBatchGroupOptions(params, {
      maxRequests: GEMINI_BATCH_MAX_REQUESTS,
      debugLabel: "memory embeddings: gemini batch submit",
    }),
    shouldSplitGroupOnError: (error) => classifyGeminiBatchSplitError(error) !== null,
    onSplitGroup: ({ error, group, parts, depth }) => {
      params.debug?.("memory embeddings: gemini batch rejected; splitting group", {
        requests: group.length,
        parts: parts.map((part) => part.length),
        depth,
        reason: classifyGeminiBatchSplitError(error) ?? "unknown",
        error: formatBatchErrorDetail(formatGeminiBatchError(error)) ?? "unknown error",
      });
    },
    runGroup: async ({
      group,
      groupIndex,
      groups,
      byCustomId,
      pollIntervalMs,
      timeoutMs,
      signal,
    }) => {
      const deadline = createProviderOperationDeadline({
        label: "gemini embedding batch",
        timeoutMs,
      });
      const batchInfo = await submitGeminiBatch({
        gemini,
        requests: group,
        deadline,
        timeoutMs,
        ...(signal ? { signal } : {}),
        ...(params.submissionLifecycle ? { submissionLifecycle: params.submissionLifecycle } : {}),
      });
      const batchName = batchInfo.name!;

      params.debug?.("memory embeddings: gemini batch created", {
        batchName,
        state: getGeminiBatchState(batchInfo),
        group: groupIndex + 1,
        groups,
        requests: group.length,
      });

      const completed = await waitForGeminiBatch({
        gemini,
        batchName,
        wait: params.wait,
        pollIntervalMs,
        timeoutMs,
        deadline,
        ...(signal ? { signal } : {}),
        debug: params.debug,
        initial: batchInfo,
      });

      const output = await downloadGeminiBatchOutputWithRetry({
        gemini,
        batchName,
        fileId: completed.outputFileId,
        requests: group,
        deadline,
        timeoutMs,
        ...(signal ? { signal } : {}),
      });

      if (output.errors.length > 0) {
        throw new Error(
          `gemini batch ${batchName} failed: ${formatBatchErrorDetail(output.errors[0]) ?? "unknown error"}`,
        );
      }
      if (output.remaining.size > 0) {
        throw new Error(
          `gemini batch ${batchName} missing ${output.remaining.size} embedding responses`,
        );
      }
      for (const [customId, embedding] of output.byCustomId) {
        if (!byCustomId.has(customId)) {
          byCustomId.set(customId, embedding);
        }
      }
    },
  });
}
