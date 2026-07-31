import { formatErrorMessage, toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { buildOllamaBaseUrlSsrFPolicy, resolveOllamaApiBase } from "./provider-models.js";
import { normalizeOllamaModelName } from "./setup-model-selection.js";
import { checkNdjsonRecordCap } from "./stream-ndjson-cap.js";

const OLLAMA_PULL_RESPONSE_TIMEOUT_MS = 30_000;
const OLLAMA_PULL_STREAM_IDLE_TIMEOUT_MS = 300_000;

type OllamaPullChunk = {
  status?: string;
  total?: number;
  completed?: number;
  error?: string;
};

type OllamaPullResult = { ok: true } | { ok: false; message: string };

function formatOllamaPullStatus(status: string): { text: string; hidePercent: boolean } {
  const trimmed = status.trim();
  const partStatusMatch = trimmed.match(/^([a-z-]+)\s+(?:sha256:)?[a-f0-9]{8,}$/i);
  if (partStatusMatch) {
    return { text: `${partStatusMatch[1]} part`, hidePercent: false };
  }
  const hidePercent = /^verifying\b.*\bdigest\b/i.test(trimmed);
  return { text: hidePercent ? "verifying digest" : trimmed, hidePercent };
}

async function readOllamaPullChunkWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      reject(
        new Error(
          `Ollama pull stalled: no data received for ${Math.round(OLLAMA_PULL_STREAM_IDLE_TIMEOUT_MS / 1000)}s`,
        ),
      );
    }, OLLAMA_PULL_STREAM_IDLE_TIMEOUT_MS);

    void reader
      .read()
      .then(resolve, (error: unknown) => reject(toErrorObject(error, "Non-Error rejection")))
      .finally(() => clearTimeout(timeoutId));
  });
}

async function pullOllamaModelCore(params: {
  baseUrl: string;
  modelName: string;
  onStatus?: (status: string, percent: number | null) => void;
  signal?: AbortSignal;
}): Promise<OllamaPullResult> {
  const baseUrl = resolveOllamaApiBase(params.baseUrl);
  const modelName = normalizeOllamaModelName(params.modelName) ?? params.modelName.trim();
  const responseController = new AbortController();
  const responseTimeout = setTimeout(
    responseController.abort.bind(responseController),
    OLLAMA_PULL_RESPONSE_TIMEOUT_MS,
  );
  try {
    params.signal?.throwIfAborted();
    const { response, release } = await fetchWithSsrFGuard({
      url: `${baseUrl}/api/pull`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: modelName }),
      },
      signal: params.signal
        ? AbortSignal.any([responseController.signal, params.signal])
        : responseController.signal,
      policy: buildOllamaBaseUrlSsrFPolicy(baseUrl),
      auditContext: "ollama-setup.pull",
    });
    clearTimeout(responseTimeout);
    try {
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, message: `Failed to download ${modelName} (HTTP ${response.status})` };
      }
      if (!response.body) {
        return { ok: false, message: `Failed to download ${modelName} (no response body)` };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let pendingRecordBytes = 0;
      const layers = new Map<string, { total: number; completed: number }>();

      const parseLine = (line: string): OllamaPullResult => {
        const trimmed = line.trim();
        if (!trimmed) {
          return { ok: true };
        }
        try {
          const chunk = JSON.parse(trimmed) as OllamaPullChunk;
          if (chunk.error) {
            return { ok: false, message: `Download failed: ${chunk.error}` };
          }
          if (!chunk.status) {
            return { ok: true };
          }
          if (chunk.total && chunk.completed !== undefined) {
            layers.set(chunk.status, { total: chunk.total, completed: chunk.completed });
            const totals = [...layers.values()].reduce(
              (sum, layer) => ({
                total: sum.total + layer.total,
                completed: sum.completed + layer.completed,
              }),
              { total: 0, completed: 0 },
            );
            params.onStatus?.(
              chunk.status,
              totals.total > 0 ? Math.round((totals.completed / totals.total) * 100) : null,
            );
          } else {
            params.onStatus?.(chunk.status, null);
          }
        } catch {
          // Ignore malformed streaming lines from Ollama.
        }
        return { ok: true };
      };

      try {
        for (;;) {
          const { done, value } = await readOllamaPullChunkWithIdleTimeout(reader);
          if (done) {
            return parseLine(buffer);
          }
          pendingRecordBytes = checkNdjsonRecordCap(value, pendingRecordBytes);
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const parsed = parseLine(line);
            if (!parsed.ok) {
              return parsed;
            }
          }
        }
      } finally {
        // Overflow and parsed-error returns can leave unread response bytes.
        // Cancel before unlocking so setup never abandons a live pull body.
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } finally {
      await release();
    }
  } catch (err) {
    const reason = formatErrorMessage(err);
    return { ok: false, message: `Failed to download ${modelName}: ${reason}` };
  } finally {
    clearTimeout(responseTimeout);
  }
}

export async function pullOllamaModel(
  baseUrl: string,
  modelName: string,
  prompter: WizardPrompter,
  signal?: AbortSignal,
): Promise<boolean> {
  const spinner = prompter.progress(`Downloading ${modelName}...`);
  const result = await pullOllamaModelCore({
    baseUrl,
    modelName,
    ...(signal ? { signal } : {}),
    onStatus: (status, percent) => {
      const displayStatus = formatOllamaPullStatus(status);
      const progress = displayStatus.hidePercent ? "" : ` - ${percent ?? 0}%`;
      spinner.update(`Downloading ${modelName} - ${displayStatus.text}${progress}`);
    },
  });
  spinner.stop(result.ok ? `Downloaded ${modelName}` : result.message);
  return result.ok;
}

export async function pullOllamaModelNonInteractive(
  baseUrl: string,
  modelName: string,
  runtime: RuntimeEnv,
): Promise<boolean> {
  runtime.log(`Downloading ${modelName}...`);
  const result = await pullOllamaModelCore({ baseUrl, modelName });
  if (result.ok) {
    runtime.log(`Downloaded ${modelName}`);
  } else {
    runtime.error(result.message);
  }
  return result.ok;
}
