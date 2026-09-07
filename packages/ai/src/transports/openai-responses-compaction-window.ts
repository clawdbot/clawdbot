import type { Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponseInputItem } from "openai/resources/responses/responses.js";
import { createSseByteGuard } from "../utils/streaming-byte-guard.js";
import type { ReplayableResponseCompactionItem } from "./openai-responses-contracts.js";
import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
} from "./openai-responses-payload-policy.js";
import { sanitizeResponsesImagePayload } from "./responses-image-payload-sanitizer.js";

// This is the host's response/storage ceiling, not a provider context-token limit.
const COMPACTION_WINDOW_MAX_BYTES = 16 * 1024 * 1024;
export type OpenAIResponsesCompactionOutput = Array<
  ResponseInputItem.Message | ReplayableResponseCompactionItem
>;
export type OpenAIResponsesCompactedWindow =
  | { state: "ready"; output: string }
  | { state: "refresh-required" };

// Schema validation, not coercion: supplied non-string fields must be rejected.
function isOptionalCompactionString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isBoundedJson(value: unknown, depth = 0): boolean {
  // Optional provider metadata reaches recursive transcript redaction. Bound
  // its nesting as well as bytes before retaining an otherwise valid window.
  if (depth > 64) {
    return false;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return (
    (Array.isArray(value) || isRecord(value)) &&
    Object.values(value).every((child) => isBoundedJson(child, depth + 1))
  );
}

function isInputContent(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const breakpoint = value.prompt_cache_breakpoint;
  if (breakpoint !== undefined && (!isRecord(breakpoint) || breakpoint.mode !== "explicit")) {
    return false;
  }
  switch (value.type) {
    case "input_text":
      return typeof value.text === "string";
    case "input_image":
      return (
        typeof value.detail === "string" &&
        ["auto", "low", "high", "original"].includes(value.detail) &&
        (typeof value.image_url === "string" || typeof value.file_id === "string") &&
        (value.image_url === null || isOptionalCompactionString(value.image_url)) &&
        (value.file_id === null || isOptionalCompactionString(value.file_id))
      );
    case "input_file":
      return (
        (value.detail === undefined ||
          (typeof value.detail === "string" && ["auto", "low", "high"].includes(value.detail))) &&
        [value.file_data, value.file_id, value.file_url].some(
          (entry) => typeof entry === "string",
        ) &&
        isOptionalCompactionString(value.file_data) &&
        (value.file_id === null || isOptionalCompactionString(value.file_id)) &&
        isOptionalCompactionString(value.file_url) &&
        isOptionalCompactionString(value.filename)
      );
    default:
      return false;
  }
}

/** Validate without projecting: accepted provider fields must survive replay unchanged. */
export function isOpenAIResponsesCompactionOutput(
  value: unknown,
  model?: Model,
): value is OpenAIResponsesCompactionOutput {
  if (!Array.isArray(value) || value.length === 0 || !isBoundedJson(value)) {
    return false;
  }
  const item: unknown = value.at(-1);
  const valid =
    isRecord(item) &&
    item.type === "compaction" &&
    typeof item.encrypted_content === "string" &&
    item.encrypted_content.length > 0 &&
    isOptionalCompactionString(item.id) &&
    isOptionalCompactionString(item.created_by) &&
    value
      .slice(0, -1)
      .every(
        (message: unknown) =>
          isRecord(message) &&
          message.type === "message" &&
          typeof message.role === "string" &&
          ["user", "developer", "system"].includes(message.role) &&
          isOptionalCompactionString(message.id) &&
          (message.status === undefined ||
            (typeof message.status === "string" &&
              ["in_progress", "completed", "incomplete"].includes(message.status))) &&
          Array.isArray(message.content) &&
          message.content.every(isInputContent),
      );
  // Storage accepts some image formats that Responses egress would replace.
  // A canonical window must survive that existing policy without any rewrite.
  if (!valid) {
    return false;
  }
  const payload = sanitizeResponsesImagePayload({ input: value });
  if (model) {
    applyOpenAIResponsesPayloadPolicy(payload, resolveOpenAIResponsesPayloadPolicy(model));
  }
  return JSON.stringify(payload.input) === JSON.stringify(value);
}

/** Read the saved canonical window only when it still matches its opaque checkpoint. */
export function readOpenAIResponsesCompactionWindow(
  replay: {
    data: string;
    id?: string;
    compactedWindow?: unknown;
  },
  model?: Model,
): OpenAIResponsesCompactionOutput | undefined {
  const window = replay.compactedWindow;
  if (!isRecord(window) || window.state !== "ready" || typeof window.output !== "string") {
    return undefined;
  }
  if (
    Buffer.byteLength(window.output, "utf8") + Buffer.byteLength(replay.data, "utf8") >
    COMPACTION_WINDOW_MAX_BYTES
  ) {
    return undefined;
  }
  try {
    if (Buffer.byteLength(JSON.stringify(replay), "utf8") > COMPACTION_WINDOW_MAX_BYTES) {
      return undefined;
    }
    const output: unknown = JSON.parse(window.output);
    if (!isOpenAIResponsesCompactionOutput(output, model)) {
      return undefined;
    }
    const item = output.at(-1);
    return item?.type === "compaction" &&
      item.encrypted_content === replay.data &&
      item.id === replay.id
      ? output
      : undefined;
  } catch {
    return undefined;
  }
}

/** Bound success bytes while leaving body deadlines, retries, and parsing to the SDK. */
export function createBoundedOpenAIResponsesCompactionFetch(
  upstreamFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await upstreamFetch(input, init);
    if (!response.ok || !response.body) {
      return response;
    }
    const reader = response.body.getReader();
    const guard = createSseByteGuard(reader, {
      maxBytes: COMPACTION_WINDOW_MAX_BYTES,
      onOverflow: () => new Error("Responses compact endpoint response exceeds 16 MiB"),
    });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await guard.read();
          if (chunk.done) {
            reader.releaseLock();
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          reader.releaseLock();
          controller.error(error);
        }
      },
      cancel(reason) {
        // Cancellation may never settle; it must not hold the SDK's timeout outcome.
        void guard.cancel(reason);
        reader.releaseLock();
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
