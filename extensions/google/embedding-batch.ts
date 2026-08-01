// Google plugin module implements embedding batch behavior.
import crypto from "node:crypto";
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
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  assertOkOrThrowProviderError,
  createProviderOperationDeadline,
  createProviderHttpError,
  readProviderJsonObjectResponse,
  resolveProviderOperationTimeoutMs,
  waitProviderOperationPollInterval,
} from "openclaw/plugin-sdk/provider-http";
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

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
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
  const boundary = `openclaw-${hashText(params.displayName)}`;
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
  agentId: string;
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
  const displayName = `memory-embeddings-${hashText(String(Date.now()))}`;
  const uploadPayload = buildGeminiUploadBody({ jsonl, displayName });

  const uploadUrl = `${getGeminiUploadUrl(baseUrl)}/files?uploadType=multipart`;
  debugEmbeddingsLog("memory embeddings: gemini batch upload", {
    uploadUrl,
    baseUrl,
    requests: params.requests.length,
  });
  const filePayload = await withRemoteHttpResponse({
    url: uploadUrl,
    ssrfPolicy: params.gemini.ssrfPolicy,
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
  });
  const fileId = filePayload.file?.name;
  if (!fileId) {
    throw new Error("gemini batch file upload failed: missing file id");
  }

  const batchBody = {
    batch: {
      displayName: `memory-embeddings-${params.agentId}`,
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
  return await withRemoteHttpResponse({
    url: batchEndpoint,
    ssrfPolicy: params.gemini.ssrfPolicy,
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
  remaining: Set<string>;
  errors: string[];
  byCustomId: Map<string, number[]>;
}): Promise<void> {
  const baseUrl = normalizeBatchBaseUrl(params.gemini);
  const downloadUrl = getGeminiDownloadUrl(baseUrl, params.fileId);
  debugEmbeddingsLog("memory embeddings: gemini batch download", { downloadUrl });
  await withRemoteHttpResponse({
    url: downloadUrl,
    ssrfPolicy: params.gemini.ssrfPolicy,
    init: {
      headers: buildBatchHeaders(params.gemini, { json: true }),
    },
    onResponse: async (res) => {
      await assertOkOrThrowProviderError(res, "gemini.batch-file-content");
      await readEmbeddingBatchJsonl<GeminiBatchOutputLine>(res, {
        label: "gemini.batch-file-content",
        maxRecords: params.remaining.size,
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

async function waitForGeminiBatch(params: {
  gemini: GeminiEmbeddingClient;
  batchName: string;
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
  initial?: GeminiBatchOperation;
}): Promise<{ outputFileId: string }> {
  const deadline = createProviderOperationDeadline({
    label: `gemini batch ${params.batchName}`,
    timeoutMs: params.timeoutMs,
  });
  let current: GeminiBatchOperation | undefined = params.initial;
  while (true) {
    const operation = current
      ? current
      : await fetchGeminiBatchStatus({
          gemini: params.gemini,
          batchName: params.batchName,
          signal: AbortSignal.timeout(
            resolveProviderOperationTimeoutMs({
              deadline,
              defaultTimeoutMs: params.timeoutMs,
            }),
          ),
        });
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
    await waitProviderOperationPollInterval({
      deadline,
      pollIntervalMs: params.pollIntervalMs,
    });
    current = undefined;
  }
}

export async function runGeminiEmbeddingBatches(
  params: {
    gemini: GeminiEmbeddingClient;
    agentId: string;
    requests: GeminiBatchRequest[];
  } & EmbeddingBatchExecutionParams,
): Promise<Map<string, number[]>> {
  const gemini = bindGeminiBatchAuth(params.gemini);
  return await runEmbeddingBatchGroups({
    ...buildEmbeddingBatchGroupOptions(params, {
      maxRequests: GEMINI_BATCH_MAX_REQUESTS,
      debugLabel: "memory embeddings: gemini batch submit",
    }),
    runGroup: async ({ group, groupIndex, groups, byCustomId, pollIntervalMs, timeoutMs }) => {
      const batchInfo = await submitGeminiBatch({
        gemini,
        requests: group,
        agentId: params.agentId,
      });
      const batchName = batchInfo.name ?? "";
      if (!batchName) {
        throw new Error("gemini batch create failed: missing batch name");
      }

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
        debug: params.debug,
        initial: batchInfo,
      });

      const errors: string[] = [];
      const remaining = new Set(group.map((request) => request.custom_id));
      await fetchGeminiBatchOutput({
        gemini,
        fileId: completed.outputFileId,
        remaining,
        errors,
        byCustomId,
      });

      if (errors.length > 0) {
        throw new Error(
          `gemini batch ${batchName} failed: ${formatBatchErrorDetail(errors[0]) ?? "unknown error"}`,
        );
      }
      if (remaining.size > 0) {
        throw new Error(`gemini batch ${batchName} missing ${remaining.size} embedding responses`);
      }
    },
  });
}
