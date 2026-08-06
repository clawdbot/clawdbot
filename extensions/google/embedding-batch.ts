// Google plugin module implements embedding batch behavior.
import crypto from "node:crypto";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import {
  buildEmbeddingBatchGroupOptions,
  runEmbeddingBatchGroups,
  buildBatchHeaders,
  debugEmbeddingsLog,
  normalizeBatchBaseUrl,
  sanitizeAndNormalizeEmbedding,
  withRemoteHttpResponse,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createProviderHttpError,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import type { GeminiEmbeddingClient, GeminiTextEmbeddingRequest } from "./embedding-provider.js";

type EmbeddingBatchExecutionParams = {
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  concurrency: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
};

type GeminiBatchRequest = {
  custom_id: string;
  request: GeminiTextEmbeddingRequest;
};

type GeminiBatchStatus = {
  name?: string;
  state?: string;
  outputConfig?: { file?: string; fileId?: string };
  metadata?: {
    output?: {
      responsesFile?: string;
    };
  };
  error?: { message?: string };
};

type GeminiBatchOutputLine = {
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
function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function getGeminiUploadUrl(baseUrl: string): string {
  if (baseUrl.includes("/v1beta")) {
    return baseUrl.replace(/\/v1beta\/?$/, "/upload/v1beta");
  }
  return `${baseUrl.replace(/\/$/, "")}/upload`;
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
}): Promise<GeminiBatchStatus> {
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
      if (!fileRes.ok) {
        const text = await fileRes.text();
        throw new Error(`gemini batch file upload failed: ${fileRes.status} ${text}`);
      }
      return readProviderJsonResponse<{ name?: string; file?: { name?: string } }>(
        fileRes,
        "gemini.batch-file-upload",
      );
    },
  });
  const fileId = filePayload.name ?? filePayload.file?.name;
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
      if (batchRes.ok) {
        return readProviderJsonResponse<GeminiBatchStatus>(batchRes, "gemini.batch-create");
      }
      const text = await batchRes.text();
      if (batchRes.status === 404) {
        throw new Error(
          "gemini batch create failed: 404 (asyncBatchEmbedContent not available for this model/baseUrl). Disable remote.batch.enabled or switch providers.",
        );
      }
      throw new Error(`gemini batch create failed: ${batchRes.status} ${text}`);
    },
  });
}

async function fetchGeminiBatchStatus(params: {
  gemini: GeminiEmbeddingClient;
  batchName: string;
}): Promise<GeminiBatchStatus> {
  const baseUrl = normalizeBatchBaseUrl(params.gemini);
  const name = params.batchName.startsWith("batches/")
    ? params.batchName
    : `batches/${params.batchName}`;
  const statusUrl = `${baseUrl}/${name}`;
  debugEmbeddingsLog("memory embeddings: gemini batch status", { statusUrl });
  return await withRemoteHttpResponse({
    url: statusUrl,
    ssrfPolicy: params.gemini.ssrfPolicy,
    init: {
      headers: buildBatchHeaders(params.gemini, { json: true }),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        throw await createProviderHttpError(res, "gemini batch status failed");
      }
      return readProviderJsonResponse<GeminiBatchStatus>(res, "gemini.batch-status");
    },
  });
}

/**
 * Streams the JSONL batch output body line by line, parsing each embedding
 * directly into the result maps. Avoids holding the full raw text and all
 * parsed objects in memory simultaneously — batch outputs can reach hundreds
 * of MB for large embedding jobs.
 *
 * Mirrors the pattern in extensions/voyage/embedding-batch.ts.
 */
async function readGeminiBatchOutputContent(
  contentRes: Response,
  remaining: Set<string>,
  errors: string[],
  byCustomId: Map<string, number[]>,
): Promise<void> {
  if (!contentRes.body) {
    return;
  }
  const inputStream = Readable.fromWeb(
    contentRes.body as unknown as import("stream/web").ReadableStream,
  );
  const reader = createInterface({ input: inputStream, terminal: false });
  try {
    for await (const rawLine of reader) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        continue;
      }
      const line = JSON.parse(trimmed) as GeminiBatchOutputLine;
      const customId = line.key ?? line.custom_id ?? line.request_id;
      if (!customId) {
        continue;
      }
      remaining.delete(customId);
      if (line.error?.message) {
        errors.push(`${customId}: ${line.error.message}`);
        continue;
      }
      if (line.response?.error?.message) {
        errors.push(`${customId}: ${line.response.error.message}`);
        continue;
      }
      const embedding = sanitizeAndNormalizeEmbedding(
        line.embedding?.values ?? line.response?.embedding?.values ?? [],
      );
      if (embedding.length === 0) {
        errors.push(`${customId}: empty embedding`);
        continue;
      }
      byCustomId.set(customId, embedding);
    }
  } finally {
    reader.close();
    inputStream.destroy();
  }
}

async function fetchGeminiBatchOutput(params: {
  gemini: GeminiEmbeddingClient;
  fileId: string;
  remaining: Set<string>;
  errors: string[];
  byCustomId: Map<string, number[]>;
}): Promise<void> {
  const baseUrl = normalizeBatchBaseUrl(params.gemini);
  const file = params.fileId.startsWith("files/") ? params.fileId : `files/${params.fileId}`;
  const downloadUrl = `${baseUrl}/${file}:download`;
  debugEmbeddingsLog("memory embeddings: gemini batch download", { downloadUrl });
  await withRemoteHttpResponse({
    url: downloadUrl,
    ssrfPolicy: params.gemini.ssrfPolicy,
    init: {
      headers: buildBatchHeaders(params.gemini, { json: true }),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        throw await createProviderHttpError(res, "gemini batch file content failed");
      }
      await readGeminiBatchOutputContent(res, params.remaining, params.errors, params.byCustomId);
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
  initial?: GeminiBatchStatus;
}): Promise<{ outputFileId: string }> {
  const start = Date.now();
  let current: GeminiBatchStatus | undefined = params.initial;
  while (true) {
    const status =
      current ??
      (await fetchGeminiBatchStatus({
        gemini: params.gemini,
        batchName: params.batchName,
      }));
    const state = status.state ?? "UNKNOWN";
    if (["SUCCEEDED", "COMPLETED", "DONE"].includes(state)) {
      const outputFileId =
        status.outputConfig?.file ??
        status.outputConfig?.fileId ??
        status.metadata?.output?.responsesFile;
      if (!outputFileId) {
        throw new Error(`gemini batch ${params.batchName} completed without output file`);
      }
      return { outputFileId };
    }
    if (["FAILED", "CANCELLED", "CANCELED", "EXPIRED"].includes(state)) {
      const message = status.error?.message ?? "unknown error";
      throw new Error(`gemini batch ${params.batchName} ${state}: ${message}`);
    }
    if (!params.wait) {
      throw new Error(`gemini batch ${params.batchName} still ${state}; wait disabled`);
    }
    if (Date.now() - start > params.timeoutMs) {
      throw new Error(`gemini batch ${params.batchName} timed out after ${params.timeoutMs}ms`);
    }
    params.debug?.(`gemini batch ${params.batchName} ${state}; waiting ${params.pollIntervalMs}ms`);
    await new Promise((resolve) => {
      setTimeout(resolve, params.pollIntervalMs);
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
  return await runEmbeddingBatchGroups({
    ...buildEmbeddingBatchGroupOptions(params, {
      maxRequests: GEMINI_BATCH_MAX_REQUESTS,
      debugLabel: "memory embeddings: gemini batch submit",
    }),
    runGroup: async ({ group, groupIndex, groups, byCustomId, pollIntervalMs, timeoutMs }) => {
      const batchInfo = await submitGeminiBatch({
        gemini: params.gemini,
        requests: group,
        agentId: params.agentId,
      });
      const batchName = batchInfo.name ?? "";
      if (!batchName) {
        throw new Error("gemini batch create failed: missing batch name");
      }

      params.debug?.("memory embeddings: gemini batch created", {
        batchName,
        state: batchInfo.state,
        group: groupIndex + 1,
        groups,
        requests: group.length,
      });

      if (
        !params.wait &&
        batchInfo.state &&
        !["SUCCEEDED", "COMPLETED", "DONE"].includes(batchInfo.state)
      ) {
        throw new Error(
          `gemini batch ${batchName} submitted; enable remote.batch.wait to await completion`,
        );
      }

      const completed =
        batchInfo.state && ["SUCCEEDED", "COMPLETED", "DONE"].includes(batchInfo.state)
          ? {
              outputFileId:
                batchInfo.outputConfig?.file ??
                batchInfo.outputConfig?.fileId ??
                batchInfo.metadata?.output?.responsesFile ??
                "",
            }
          : await waitForGeminiBatch({
              gemini: params.gemini,
              batchName,
              wait: params.wait,
              pollIntervalMs,
              timeoutMs,
              debug: params.debug,
              initial: batchInfo,
            });
      if (!completed.outputFileId) {
        throw new Error(`gemini batch ${batchName} completed without output file`);
      }

      const errors: string[] = [];
      const remaining = new Set(group.map((request) => request.custom_id));
      await fetchGeminiBatchOutput({
        gemini: params.gemini,
        fileId: completed.outputFileId,
        remaining,
        errors,
        byCustomId,
      });

      if (errors.length > 0) {
        throw new Error(`gemini batch ${batchName} failed: ${errors.join("; ")}`);
      }
      if (remaining.size > 0) {
        throw new Error(`gemini batch ${batchName} missing ${remaining.size} embedding responses`);
      }
    },
  });
}
