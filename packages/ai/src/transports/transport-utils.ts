import { createHash } from "node:crypto";
import type { Model } from "@openclaw/llm-core";
import {
  asFiniteNumberInRange,
  parseStrictFiniteNumber,
  parseStrictNonNegativeInteger,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { getAiTransportHost } from "../host.js";
import { parseRetryAfterHttpDateMs } from "../internal/retry-after.js";

export const MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE =
  "OpenClaw transport error: malformed_streaming_fragment";
export const CHARS_PER_TOKEN_ESTIMATE = 4;
const NON_LATIN_RE =
  /[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\uFF01-\uFF60\uFFE0-\uFFE6\u{20000}-\u{2FA1F}]/gu;
const CJK_SURROGATE_HIGH_RE = /[\uD840-\uD87E][\uDC00-\uDFFF]/g;

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256HexPrefix(value: string | Uint8Array, length: number): string {
  return sha256Hex(value).slice(0, length);
}

export function redactIdentifier(value: string | undefined, opts?: { len?: number }): string {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return "-";
  }
  const length = Number.isFinite(opts?.len) ? Math.max(1, Math.floor(opts?.len ?? 12)) : 12;
  return `sha256:${sha256HexPrefix(trimmed, length)}`;
}

export function redactSensitiveText(text: string, _options?: unknown): string {
  return getAiTransportHost().redactToolPayloadText(text);
}

export function resolveSecretSentinel(value: string): string {
  return getAiTransportHost().resolveSecretSentinel(value);
}

export function resolveModelHeaderSentinels<TModel extends Model>(model: TModel): TModel {
  if (!model.headers) {
    return model;
  }
  let headers: Record<string, string> | undefined;
  for (const [name, value] of Object.entries(model.headers)) {
    const resolved = resolveSecretSentinel(value);
    if (resolved !== value) {
      headers ??= { ...model.headers };
      headers[name] = resolved;
    }
  }
  return headers ? ({ ...model, headers } as TModel) : model;
}

export function createAbortError(message: string, options?: ErrorOptions): Error {
  const error = new Error(message, options);
  error.name = "AbortError";
  return error;
}

export function estimateStringChars(text: string): number {
  if (!text) {
    return 0;
  }
  const nonLatinCount = (text.match(NON_LATIN_RE) ?? []).length;
  const codePointLength =
    nonLatinCount === 0
      ? text.length
      : text.length - (text.match(CJK_SURROGATE_HIGH_RE) ?? []).length;
  return codePointLength + nonLatinCount * (CHARS_PER_TOKEN_ESTIMATE - 1);
}

export function supportsModelTools(model: { compat?: unknown }): boolean {
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as { supportsTools?: boolean })
      : undefined;
  return compat?.supportsTools !== false;
}

export function isCodeModeModelVisibleToolName(name: string): boolean {
  return name === "exec" || name === "wait" || name === "computer" || name === "image";
}

function isGoogleGemini3Model(modelId: string, family: "flash" | "pro"): boolean {
  const normalized = modelId.trim().toLowerCase();
  const suffix = family === "pro" ? "pro" : "flash";
  return new RegExp(
    `(?:^|/)gemini-(?:3(?:\\.\\d+)?-${suffix}|${suffix}${family === "flash" ? "(?:-lite)?" : ""}-latest)(?:-|$)`,
  ).test(normalized);
}

export function isGoogleGemini3ProModel(modelId: string): boolean {
  return isGoogleGemini3Model(modelId, "pro");
}

export function isGoogleGemini3FlashModel(modelId: string): boolean {
  return isGoogleGemini3Model(modelId, "flash");
}

export function parseRetryAfterSeconds(headers: Headers): number | undefined {
  const retryAfterMs = headers.get("retry-after-ms");
  if (retryAfterMs) {
    const trimmed = retryAfterMs.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const milliseconds = asFiniteNumberInRange(parseStrictFiniteNumber(trimmed), {
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      });
      return milliseconds === undefined ? Number.POSITIVE_INFINITY : milliseconds / 1000;
    }
  }

  const retryAfter = headers.get("retry-after")?.trim();
  if (!retryAfter) {
    return undefined;
  }
  if (/^\d+$/.test(retryAfter)) {
    return parseStrictNonNegativeInteger(retryAfter) ?? Number.POSITIVE_INFINITY;
  }
  const retryAt = parseRetryAfterHttpDateMs(retryAfter);
  return retryAt === undefined ? undefined : Math.max(0, (retryAt - Date.now()) / 1000);
}

async function readChunkWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  onIdleTimeout?: (params: { chunkTimeoutMs: number }) => Error,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(onIdleTimeout?.({ chunkTimeoutMs: timeoutMs }) ?? new Error("Read timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function readResponseTextSnippet(
  response: Response,
  options?: {
    maxBytes?: number;
    maxChars?: number;
    chunkTimeoutMs?: number;
    onIdleTimeout?: (params: { chunkTimeoutMs: number }) => Error;
  },
): Promise<string | undefined> {
  const maxBytes = options?.maxBytes ?? 8 * 1024;
  const maxChars = options?.maxChars ?? 200;
  const reader = response.body?.getReader();
  if (!reader) {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (bytes < maxBytes) {
      const result = options?.chunkTimeoutMs
        ? await readChunkWithIdleTimeout(reader, options.chunkTimeoutMs, options.onIdleTimeout)
        : await reader.read();
      if (result.done) {
        break;
      }
      if (!result.value?.length) {
        continue;
      }
      const remaining = maxBytes - bytes;
      chunks.push(result.value.subarray(0, remaining));
      bytes += Math.min(result.value.length, remaining);
      if (result.value.length >= remaining) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const collapsed = new TextDecoder().decode(merged).replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return undefined;
  }
  if (collapsed.length > maxChars) {
    return `${truncateUtf16Safe(collapsed, maxChars)}…`;
  }
  return truncated ? `${collapsed}…` : collapsed;
}
