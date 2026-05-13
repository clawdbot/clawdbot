import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareContext,
  AgentToolResultMiddlewareEvent,
  OpenClawAgentToolResult,
} from "../../plugins/agent-tool-result-middleware-types.js";
import { createLazyPromiseLoader } from "../../shared/lazy-promise.js";
import { truncateUtf16Safe } from "../../utils.js";

const log = createSubsystemLogger("agents/harness");
const MAX_MIDDLEWARE_CONTENT_BLOCKS = 200;
const MAX_MIDDLEWARE_TEXT_CHARS = 100_000;
const MAX_MIDDLEWARE_IMAGE_DATA_CHARS = 5_000_000;
const MAX_MIDDLEWARE_DETAILS_BYTES = 100_000;
const MAX_MIDDLEWARE_DETAILS_DEPTH = 20;
const MAX_MIDDLEWARE_DETAILS_KEYS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

function isValidMiddlewareDetails(
  value: unknown,
  state: { keys: number; bytes: number; seen: WeakSet<object> } = {
    keys: 0,
    bytes: 0,
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
  if (typeof value === "string") {
    state.bytes += value.length;
    return state.bytes <= MAX_MIDDLEWARE_DETAILS_BYTES;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    state.bytes += String(value).length;
    return state.bytes <= MAX_MIDDLEWARE_DETAILS_BYTES;
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
      if (!isValidMiddlewareDetails(entry, state, depth + 1)) {
        return false;
      }
    }
    return true;
  }
  for (const [key, entry] of Object.entries(value)) {
    state.keys += 1;
    state.bytes += key.length;
    if (state.keys > MAX_MIDDLEWARE_DETAILS_KEYS || state.bytes > MAX_MIDDLEWARE_DETAILS_BYTES) {
      return false;
    }
    if (!isValidMiddlewareDetails(entry, state, depth + 1)) {
      return false;
    }
  }
  return true;
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
    if (serialized.length > MAX_MIDDLEWARE_DETAILS_BYTES) {
      return { truncated: true, originalSizeBytes: serialized.length };
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

export function createAgentToolResultMiddlewareRunner(
  ctx: AgentToolResultMiddlewareContext,
  handlers?: AgentToolResultMiddleware[],
) {
  const middlewareContext = { ...ctx, harness: ctx.harness ?? ctx.runtime };
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
      let current = sanitizeToolResultForMiddleware(event.result);
      for (const handler of handlersForRun) {
        try {
          const next = await handler({ ...event, result: current }, middlewareContext);
          // Middleware may mutate event.result in place for legacy Pi parity.
          // Validate the current object after every handler so in-place writes
          // cannot bypass the same shape and size bounds as returned results.
          const candidate = next?.result ?? current;
          if (isValidMiddlewareToolResult(candidate)) {
            current = candidate;
          } else {
            log.warn(
              `[${ctx.runtime}] discarded invalid tool result middleware output for ${truncateUtf16Safe(
                event.toolName,
                120,
              )}`,
            );
            return buildMiddlewareFailureResult();
          }
        } catch {
          log.warn(
            `[${ctx.runtime}] tool result middleware failed for ${truncateUtf16Safe(
              event.toolName,
              120,
            )}`,
          );
          return buildMiddlewareFailureResult();
        }
      }
      return current;
    },
  };
}
