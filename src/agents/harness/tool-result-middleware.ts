/**
 * Runs native harness tool-result middleware around tool execution results.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { boundedJsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareContext,
  AgentToolResultMiddlewareEvent,
  OpenClawAgentToolResult,
} from "../../plugins/agent-tool-result-middleware-types.js";
import { createLazyPromiseLoader } from "../../shared/lazy-promise.js";
import { truncateUtf16Safe } from "../../utils.js";
import {
  hasMessagingDeliveryReceipt,
  isDeliveredMessagingToolResult,
} from "../embedded-agent-message-tool-source-reply.js";
import { isMessagingToolSendAction } from "../embedded-agent-messaging.js";
import { isToolResultError } from "../tool-result-error.js";

const log = createSubsystemLogger("agents/harness");
const MAX_MIDDLEWARE_CONTENT_BLOCKS = 200;
const MAX_MIDDLEWARE_TEXT_CHARS = 100_000;
const MAX_MIDDLEWARE_IMAGE_DATA_CHARS = 5_000_000;
const MAX_MIDDLEWARE_CONTENT_DEPTH = 20;
const MAX_MIDDLEWARE_DETAILS_BYTES = 100_000;
const MAX_MIDDLEWARE_DETAILS_DEPTH = 20;
const MAX_MIDDLEWARE_DETAILS_KEYS = 1_000;
const NESTED_TOOL_RESULT_BLOCK_TYPES = new Set(["toolresult", "tool_result"]);

type MiddlewareContentBlock = OpenClawAgentToolResult["content"][number];
type MiddlewareContentCoerceState = { depth: number; seen: Set<object> };
type MiddlewareToolResultCoerceOptions = {
  sanitizeContent?: boolean;
  sanitizeDetails?: boolean;
};

function isValidMiddlewareContentBlock(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (value.type === "text") {
    return typeof value.text === "string" && value.text.length <= MAX_MIDDLEWARE_TEXT_CHARS;
  }
  if (value.type === "image") {
    return (
      typeof value.mimeType === "string" &&
      value.mimeType.trim().length > 0 &&
      typeof value.data === "string" &&
      value.data.length <= MAX_MIDDLEWARE_IMAGE_DATA_CHARS
    );
  }
  return false;
}

function hasValidMiddlewareDetailsShape(
  value: unknown,
  state: { keys: number; seen: WeakSet<object> } = {
    keys: 0,
    seen: new WeakSet<object>(),
  },
  depth = 0,
): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (depth > MAX_MIDDLEWARE_DETAILS_DEPTH) {
    return false;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (typeof value !== "object") {
    return false;
  }
  if (state.seen.has(value)) {
    return false;
  }
  state.seen.add(value);
  if (Array.isArray(value)) {
    state.keys += value.length;
    if (state.keys > MAX_MIDDLEWARE_DETAILS_KEYS) {
      return false;
    }
    for (const entry of value) {
      if (!hasValidMiddlewareDetailsShape(entry, state, depth + 1)) {
        return false;
      }
    }
    return true;
  }
  for (const entry of Object.values(value)) {
    state.keys += 1;
    if (state.keys > MAX_MIDDLEWARE_DETAILS_KEYS) {
      return false;
    }
    if (!hasValidMiddlewareDetailsShape(entry, state, depth + 1)) {
      return false;
    }
  }
  return true;
}

function isValidMiddlewareDetails(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!hasValidMiddlewareDetailsShape(value)) {
    return false;
  }
  const size = boundedJsonUtf8Bytes(value, MAX_MIDDLEWARE_DETAILS_BYTES);
  return size.complete && size.bytes <= MAX_MIDDLEWARE_DETAILS_BYTES;
}

function isValidMiddlewareToolResult(value: unknown): value is OpenClawAgentToolResult {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return false;
  }
  if (value.content.length > MAX_MIDDLEWARE_CONTENT_BLOCKS) {
    return false;
  }
  return (
    value.content.every(isValidMiddlewareContentBlock) && isValidMiddlewareDetails(value.details)
  );
}

function createMiddlewareContentCoerceState(): MiddlewareContentCoerceState {
  return { depth: 0, seen: new Set<object>() };
}

function descendMiddlewareContentCoerceState(
  value: unknown,
  state: MiddlewareContentCoerceState,
): MiddlewareContentCoerceState | undefined {
  if (state.depth >= MAX_MIDDLEWARE_CONTENT_DEPTH) {
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    if (state.seen.has(value)) {
      return undefined;
    }
    const seen = new Set(state.seen);
    seen.add(value);
    return { depth: state.depth + 1, seen };
  }
  return { depth: state.depth + 1, seen: state.seen };
}

function stringifyMiddlewareTextPayload(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") {
        return val.toString();
      }
      if (typeof val === "function" || typeof val === "symbol" || val === undefined) {
        return undefined;
      }
      if (val !== null && typeof val === "object") {
        if (seen.has(val)) {
          return undefined;
        }
        seen.add(val);
      }
      return val;
    });
  } catch {
    return undefined;
  }
}

function coerceMiddlewareText(
  value: unknown,
  state: MiddlewareContentCoerceState = createMiddlewareContentCoerceState(),
  options: MiddlewareToolResultCoerceOptions = {},
): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const nextState = descendMiddlewareContentCoerceState(value, state);
  if (!nextState) {
    return undefined;
  }
  for (const key of ["text", "output", "result", "message"]) {
    const text = coerceMiddlewareText(value[key], nextState, options);
    if (text !== undefined) {
      return text;
    }
  }
  const content = value.content;
  if (Array.isArray(content)) {
    const chunks = coerceMiddlewareContentArray(content, nextState, options)
      .filter(
        (block): block is Extract<MiddlewareContentBlock, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .filter((text) => text.length > 0);
    return chunks.length > 0 ? chunks.join("\n") : undefined;
  }
  return stringifyMiddlewareTextPayload(value);
}

function appendMiddlewareContentBlock(
  blocks: MiddlewareContentBlock[],
  block: MiddlewareContentBlock,
): void {
  if (blocks.length >= MAX_MIDDLEWARE_CONTENT_BLOCKS) {
    return;
  }
  if (block.type !== "text") {
    blocks.push(block);
    return;
  }
  if (!block.text) {
    return;
  }
  const previous = blocks.at(-1);
  if (previous?.type !== "text") {
    blocks.push({
      type: "text",
      text: truncateUtf16Safe(block.text, MAX_MIDDLEWARE_TEXT_CHARS),
    });
    return;
  }
  const remainingChars = MAX_MIDDLEWARE_TEXT_CHARS - previous.text.length - 1;
  if (remainingChars <= 0) {
    return;
  }
  previous.text = `${previous.text}\n${truncateUtf16Safe(block.text, remainingChars)}`;
}

function coerceMiddlewareContentArray(
  content: unknown[],
  state: MiddlewareContentCoerceState,
  options: MiddlewareToolResultCoerceOptions = {},
): MiddlewareContentBlock[] {
  const blocks: MiddlewareContentBlock[] = [];
  let inspectedBlocks = 0;
  for (const entry of content) {
    inspectedBlocks += 1;
    if (
      inspectedBlocks > MAX_MIDDLEWARE_CONTENT_BLOCKS ||
      blocks.length >= MAX_MIDDLEWARE_CONTENT_BLOCKS
    ) {
      break;
    }
    const coercedBlocks = coerceMiddlewareContentBlocks(entry, state, options);
    if (coercedBlocks.length > 0) {
      for (const block of coercedBlocks) {
        appendMiddlewareContentBlock(blocks, block);
        if (blocks.length >= MAX_MIDDLEWARE_CONTENT_BLOCKS) {
          break;
        }
      }
      continue;
    }
    const text = coerceMiddlewareText(entry, state, options);
    if (text) {
      appendMiddlewareContentBlock(blocks, {
        type: "text",
        text: truncateUtf16Safe(text, MAX_MIDDLEWARE_TEXT_CHARS),
      });
    }
  }
  return blocks;
}

function coerceMiddlewareContentBlocks(
  value: unknown,
  state: MiddlewareContentCoerceState = createMiddlewareContentCoerceState(),
  options: MiddlewareToolResultCoerceOptions = {},
): MiddlewareContentBlock[] {
  if (isValidMiddlewareContentBlock(value)) {
    return [value as MiddlewareContentBlock];
  }
  // Tool emitters can produce legitimate transcript text larger than the
  // middleware cap. Normalize that only before the first handler; handlers
  // remain fail-closed if they return an oversized replacement.
  if (
    options.sanitizeContent === true &&
    isRecord(value) &&
    value.type === "text" &&
    typeof value.text === "string"
  ) {
    return [{ type: "text", text: truncateUtf16Safe(value.text, MAX_MIDDLEWARE_TEXT_CHARS) }];
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    return [];
  }
  const normalizedType = value.type.toLowerCase();
  if (!NESTED_TOOL_RESULT_BLOCK_TYPES.has(normalizedType)) {
    return [];
  }
  const content = value.content;
  if (Array.isArray(content) && content.length > 0) {
    const nextState = descendMiddlewareContentCoerceState(value, state);
    return nextState ? coerceMiddlewareContentArray(content, nextState, options) : [];
  }
  const text =
    coerceMiddlewareText(content, state, options) ?? coerceMiddlewareText(value, state, options);
  if (!text) {
    return [];
  }
  return [
    {
      type: "text",
      text: truncateUtf16Safe(text, MAX_MIDDLEWARE_TEXT_CHARS),
    },
  ];
}

function coerceMiddlewareToolResult(
  value: unknown,
  options: MiddlewareToolResultCoerceOptions = {},
): OpenClawAgentToolResult | undefined {
  if (isValidMiddlewareToolResult(value)) {
    return value;
  }
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return undefined;
  }
  const content: OpenClawAgentToolResult["content"] = [];
  const state = createMiddlewareContentCoerceState();
  let inspectedBlocks = 0;
  for (const block of value.content) {
    inspectedBlocks += 1;
    if (inspectedBlocks > MAX_MIDDLEWARE_CONTENT_BLOCKS) {
      break;
    }
    for (const coerced of coerceMiddlewareContentBlocks(block, state, options)) {
      content.push(coerced);
      if (content.length >= MAX_MIDDLEWARE_CONTENT_BLOCKS) {
        break;
      }
    }
    if (content.length >= MAX_MIDDLEWARE_CONTENT_BLOCKS) {
      break;
    }
  }
  if (content.length === 0) {
    return undefined;
  }
  const details = isValidMiddlewareDetails(value.details)
    ? value.details
    : options.sanitizeDetails === true
      ? sanitizeMiddlewareDetailsValue(value.details)
      : undefined;
  if (details === undefined && !isValidMiddlewareDetails(value.details)) {
    return undefined;
  }
  const result = {
    ...value,
    content,
    details,
  };
  return isValidMiddlewareToolResult(result) ? result : undefined;
}

/**
 * Coerce an arbitrary value into a JSON-safe shape that satisfies
 * `isValidMiddlewareDetails`. Round-trips through `JSON.stringify` with a
 * WeakSet replacer that drops functions, symbols, and `undefined`; coerces
 * bigints to their decimal string form; breaks cycles at the offending
 * reference; and collapses payloads larger than the validator byte cap to a
 * `{ truncated, originalSizeBytes }` marker. Returns `null` for inputs that
 * cannot be represented at all (top-level function/symbol/undefined).
 */
function sanitizeMiddlewareDetailsValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") {
        return val.toString();
      }
      if (val !== null && typeof val === "object") {
        if (seen.has(val)) {
          return undefined;
        }
        seen.add(val);
      }
      return val;
    });
    if (serialized === undefined) {
      return null;
    }
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    if (serializedBytes > MAX_MIDDLEWARE_DETAILS_BYTES) {
      return { truncated: true, originalSizeBytes: serializedBytes };
    }
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

/**
 * Coerce an incoming tool result into a shape the validator will accept,
 * before any middleware runs. Tool emitters legitimately produce raw
 * dependency payloads on `details` (channel SDK objects with methods, exec
 * traces with cycles back to the runner, large attachment metadata). The
 * harness owes a registered middleware a JSON-safe view of that payload;
 * subsequent middleware-side mutations are still validated strictly.
 */
function sanitizeToolResultForMiddleware(result: OpenClawAgentToolResult): OpenClawAgentToolResult {
  const coerced = coerceMiddlewareToolResult(result, {
    sanitizeContent: true,
    sanitizeDetails: true,
  });
  if (coerced) {
    return coerced;
  }
  if (result.details === undefined || result.details === null) {
    return result;
  }
  if (isValidMiddlewareDetails(result.details)) {
    return result;
  }
  return { ...result, details: sanitizeMiddlewareDetailsValue(result.details) };
}

function buildMiddlewareFailureResult(): OpenClawAgentToolResult {
  return {
    content: [
      {
        type: "text",
        text: "Tool output unavailable due to post-processing error.",
      },
    ],
    details: {
      status: "error",
      middlewareError: true,
    },
  };
}

function buildDeliveredMessagingFailureFallback(
  event: AgentToolResultMiddlewareEvent,
  result: OpenClawAgentToolResult,
): OpenClawAgentToolResult | undefined {
  if (
    event.isError === true ||
    isToolResultError(result) ||
    !isMessagingToolSendAction(event.toolName, event.args) ||
    !isDeliveredMessagingToolResult({
      toolName: event.toolName,
      args: event.args,
      result,
    }) ||
    !hasMessagingDeliveryReceipt(result)
  ) {
    return undefined;
  }
  return {
    content: [{ type: "text", text: "Message delivered, but result post-processing failed." }],
    details: {
      ok: true,
      deliveryStatus: "sent",
      middlewareWarning: "post-processing failed",
    },
  };
}

function reconcileDeliveredMessagingFailure(
  result: OpenClawAgentToolResult,
  fallback: OpenClawAgentToolResult | undefined,
): OpenClawAgentToolResult {
  return fallback && isRecord(result.details) && result.details.middlewareError === true
    ? fallback
    : result;
}

export function createAgentToolResultMiddlewareRunner(
  ctx: AgentToolResultMiddlewareContext,
  handlers?: AgentToolResultMiddleware[],
) {
  let resolvedHandlers = handlers;
  const resolvedHandlersLoader = createLazyPromiseLoader(async () => {
    const { loadAgentToolResultMiddlewaresForRuntime } =
      await import("../../plugins/agent-tool-result-middleware-loader.js");
    return loadAgentToolResultMiddlewaresForRuntime({
      runtime: ctx.runtime,
    });
  });
  const resolveHandlers = async (): Promise<AgentToolResultMiddleware[]> => {
    if (resolvedHandlers) {
      return resolvedHandlers;
    }
    resolvedHandlers = await resolvedHandlersLoader.load();
    return resolvedHandlers;
  };
  return {
    async applyToolResultMiddleware(
      event: AgentToolResultMiddlewareEvent,
    ): Promise<OpenClawAgentToolResult> {
      const handlersForRun = await resolveHandlers();
      // Fast path: with no middleware registered the result is delivered
      // unchanged; skip validation entirely so tool emitters that produce
      // dependency payloads on `details` (SDK objects with methods, cycles)
      // are not penalized for behavior the validator was added to police.
      if (handlersForRun.length === 0) {
        return event.result;
      }
      // Snapshot the confirmed side effect before legacy middleware can mutate
      // or sanitization can collapse the receipt; never expose the raw result.
      const deliveredMessagingFallback = buildDeliveredMessagingFailureFallback(
        event,
        event.result,
      );
      let current = sanitizeToolResultForMiddleware(event.result);
      for (const handler of handlersForRun) {
        try {
          const next = await handler({ ...event, result: current }, ctx);
          // Middleware may mutate event.result in place for legacy runtime parity.
          // Validate the current object after every handler so in-place writes
          // cannot bypass the same shape and size bounds as returned results.
          const candidate = next?.result ?? current;
          const coercedCandidate = coerceMiddlewareToolResult(candidate);
          if (coercedCandidate) {
            current = coercedCandidate;
          } else {
            log.warn(
              `[${ctx.runtime}] discarded invalid tool result middleware output for ${truncateUtf16Safe(
                event.toolName,
                120,
              )}`,
            );
            return reconcileDeliveredMessagingFailure(
              buildMiddlewareFailureResult(),
              deliveredMessagingFallback,
            );
          }
        } catch {
          log.warn(
            `[${ctx.runtime}] tool result middleware failed for ${truncateUtf16Safe(
              event.toolName,
              120,
            )}`,
          );
          return reconcileDeliveredMessagingFailure(
            buildMiddlewareFailureResult(),
            deliveredMessagingFallback,
          );
        }
      }
      return reconcileDeliveredMessagingFailure(current, deliveredMessagingFallback);
    },
  };
}
