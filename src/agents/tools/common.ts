/**
 * Shared built-in tool contracts and helpers.
 *
 * Defines erased tool types, parameter readers, JSON results, progress blocks, and media sanitization.
 */
import { detectMime } from "@openclaw/media-core/mime";
import {
  asPositiveSafeInteger,
  asSafeIntegerInRange,
  parseStrictFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { TSchema } from "typebox";
import { readLocalFileSafely } from "../../infra/fs-safe.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import type {
  AgentTool,
  AgentToolProgress,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "../runtime/index.js";
import { sanitizeToolResultImages } from "../tool-images.js";
import { textResult } from "./tool-results.js";

export { jsonResult, textResult } from "./tool-results.js";

export type AgentToolWithMeta<TParameters extends TSchema, TResult> = AgentTool<
  TParameters,
  TResult
> & {
  displaySummary?: string;
  /** Keep this tool model-visible; hidden catalog bridges cannot preserve its result contract. */
  catalogMode?: "direct-only";
  /** Gateway client capabilities required before this tool can be assembled. */
  requiredClientCaps?: string[];
  prepareBeforeToolCallParams?: (
    params: unknown,
    ctx: { toolCallId?: string; hookContext?: unknown; signal?: AbortSignal },
  ) => unknown;
  finalizeBeforeToolCallParams?: (params: unknown, preparedParams: unknown) => unknown;
};

type ErasedAgentToolExecute = {
  execute(
    this: void,
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<AgentToolResult<unknown>>;
};

export type AnyAgentTool = Omit<AgentTool, "execute"> &
  ErasedAgentToolExecute & {
    displaySummary?: string;
    /** Keep this tool model-visible; hidden catalog bridges cannot preserve its result contract. */
    catalogMode?: "direct-only";
    /** Gateway client capabilities required before this tool can be assembled. */
    requiredClientCaps?: string[];
    prepareBeforeToolCallParams?: AgentToolWithMeta<
      TSchema,
      unknown
    >["prepareBeforeToolCallParams"];
    finalizeBeforeToolCallParams?: AgentToolWithMeta<
      TSchema,
      unknown
    >["finalizeBeforeToolCallParams"];
  };

export function asToolParamsRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

export type StringParamOptions = {
  required?: boolean;
  trim?: boolean;
  label?: string;
  allowEmpty?: boolean;
};

export type ActionGate<T extends Record<string, boolean | undefined>> = (
  key: keyof T,
  defaultValue?: boolean,
) => boolean;

export class ToolInputError extends Error {
  readonly status: number = 400;

  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export class ToolAuthorizationError extends ToolInputError {
  override readonly status = 403;

  constructor(message: string) {
    super(message);
    this.name = "ToolAuthorizationError";
  }
}

export function createActionGate<T extends Record<string, boolean | undefined>>(
  actions: T | undefined,
): ActionGate<T> {
  return (key, defaultValue = true) => {
    const value = actions?.[key];
    if (value === undefined) {
      return defaultValue;
    }
    return value !== false;
  };
}

function readParamRaw(params: Record<string, unknown>, key: string): unknown {
  return readSnakeCaseParamRaw(params, key);
}

// Models may emit blank defaults for optional numeric fields. Treat them as
// absent while still rejecting nonblank invalid input.
function isBlankParamValue(raw: unknown): boolean {
  return typeof raw === "string" && raw.trim() === "";
}

export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: StringParamOptions & { required: true },
): string;
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: StringParamOptions,
): string | undefined;
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: StringParamOptions = {},
) {
  const { required = false, trim = true, label = key, allowEmpty = false } = options;
  const raw = readParamRaw(params, key);
  if (typeof raw !== "string") {
    if (required) {
      throw new ToolInputError(`${label} required`);
    }
    return undefined;
  }
  const value = trim ? raw.trim() : raw;
  if (!value && !allowEmpty) {
    if (required) {
      throw new ToolInputError(`${label} required`);
    }
    return undefined;
  }
  return value;
}

/**
 * Normalize tool model override input.
 * - empty/whitespace => undefined
 * - "default" (case-insensitive) => undefined (sentinel: reset/fallback)
 * - otherwise returns trimmed explicit model string
 */
export function normalizeToolModelOverride(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") {
    return undefined;
  }
  return trimmed;
}

export function readStringOrNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; label?: string } = {},
): string | undefined {
  const { required = false, label = key } = options;
  const raw = readParamRaw(params, key);
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  if (typeof raw === "string") {
    const value = raw.trim();
    if (value) {
      return value;
    }
  }
  if (required) {
    throw new ToolInputError(`${label} required`);
  }
  return undefined;
}

export function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: {
    required?: boolean;
    label?: string;
    integer?: boolean;
    strict?: boolean;
    positiveInteger?: boolean;
    nonNegativeInteger?: boolean;
  } = {},
): number | undefined {
  const {
    required = false,
    label = key,
    integer = false,
    strict = false,
    positiveInteger = false,
    nonNegativeInteger = false,
  } = options;
  const raw = readParamRaw(params, key);
  let value: number | undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    value = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed) {
      const parsed = strict ? parseStrictFiniteNumber(trimmed) : Number.parseFloat(trimmed);
      if (parsed !== undefined && Number.isFinite(parsed)) {
        value = parsed;
      }
    }
  }
  if (value === undefined) {
    if (required) {
      throw new ToolInputError(`${label} required`);
    }
    return undefined;
  }
  if (positiveInteger) {
    return asPositiveSafeInteger(value);
  }
  if (nonNegativeInteger) {
    return asSafeIntegerInRange(value, { min: 0 });
  }
  return integer ? Math.trunc(value) : value;
}

export function readPositiveIntegerParam(
  params: Record<string, unknown>,
  key: string,
  options: {
    message?: string;
    max?: number;
  } = {},
): number | undefined {
  const value = readNumberParam(params, key, {
    positiveInteger: true,
    strict: true,
  });
  if (value === undefined) {
    const raw = readParamRaw(params, key);
    if (raw != null && !isBlankParamValue(raw)) {
      throw new ToolInputError(options.message ?? `${key} must be a positive integer`);
    }
  }
  if (value !== undefined && options.max !== undefined && value > options.max) {
    throw new ToolInputError(options.message ?? `${key} must be a positive integer`);
  }
  return value;
}

export function readNonNegativeIntegerParam(
  params: Record<string, unknown>,
  key: string,
  options: {
    message?: string;
    max?: number;
  } = {},
): number | undefined {
  const value = readNumberParam(params, key, {
    nonNegativeInteger: true,
    strict: true,
  });
  if (value === undefined) {
    const raw = readParamRaw(params, key);
    if (raw != null && !isBlankParamValue(raw)) {
      throw new ToolInputError(options.message ?? `${key} must be a non-negative integer`);
    }
  }
  if (value !== undefined && options.max !== undefined && value > options.max) {
    throw new ToolInputError(options.message ?? `${key} must be a non-negative integer`);
  }
  return value;
}

export function readFiniteNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: {
    message?: string;
    min?: number;
    max?: number;
    minExclusive?: boolean;
    maxExclusive?: boolean;
  } = {},
): number | undefined {
  const value = readNumberParam(params, key, {
    strict: true,
  });
  if (value === undefined) {
    const raw = readParamRaw(params, key);
    if (raw != null && !isBlankParamValue(raw)) {
      throw new ToolInputError(options.message ?? `${key} must be a finite number`);
    }
    return undefined;
  }
  if (options.min !== undefined) {
    const below = options.minExclusive ? value <= options.min : value < options.min;
    if (below) {
      throw new ToolInputError(options.message ?? `${key} must be a finite number`);
    }
  }
  if (options.max !== undefined) {
    const above = options.maxExclusive ? value >= options.max : value > options.max;
    if (above) {
      throw new ToolInputError(options.message ?? `${key} must be a finite number`);
    }
  }
  return value;
}

export function readStringArrayParam(
  params: Record<string, unknown>,
  key: string,
  options: StringParamOptions & { required: true },
): string[];
export function readStringArrayParam(
  params: Record<string, unknown>,
  key: string,
  options?: StringParamOptions,
): string[] | undefined;
export function readStringArrayParam(
  params: Record<string, unknown>,
  key: string,
  options: StringParamOptions = {},
) {
  const { required = false, label = key } = options;
  const raw = readParamRaw(params, key);
  if (Array.isArray(raw)) {
    const values = normalizeStringEntries(raw.filter((entry) => typeof entry === "string"));
    if (values.length === 0) {
      if (required) {
        throw new ToolInputError(`${label} required`);
      }
      return undefined;
    }
    return values;
  }
  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) {
      if (required) {
        throw new ToolInputError(`${label} required`);
      }
      return undefined;
    }
    return [value];
  }
  if (required) {
    throw new ToolInputError(`${label} required`);
  }
  return undefined;
}

export type ReactionParams = {
  emoji: string;
  remove: boolean;
  isEmpty: boolean;
};

export function readReactionParams(
  params: Record<string, unknown>,
  options: {
    emojiKey?: string;
    removeKey?: string;
    removeErrorMessage: string;
  },
): ReactionParams {
  const emojiKey = options.emojiKey ?? "emoji";
  const removeKey = options.removeKey ?? "remove";
  const remove = typeof params[removeKey] === "boolean" ? params[removeKey] : false;
  const emoji = readStringParam(params, emojiKey, {
    required: true,
    allowEmpty: true,
  });
  if (remove && !emoji) {
    throw new ToolInputError(options.removeErrorMessage);
  }
  return { emoji, remove, isEmpty: !emoji };
}

export function stringifyToolPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  try {
    const encoded = JSON.stringify(payload, null, 2);
    if (typeof encoded === "string") {
      return encoded;
    }
  } catch {
    // Fall through to String(payload) for non-serializable values.
  }
  return String(payload);
}

export function failedTextResult<TDetails extends { status: "failed" }>(
  text: string,
  details: TDetails,
): AgentToolResult<TDetails> {
  return textResult(text, details);
}

export function payloadTextResult<TDetails>(payload: TDetails): AgentToolResult<TDetails> {
  return textResult(stringifyToolPayload(payload), payload);
}

export type PublicToolProgress = Pick<AgentToolProgress, "text" | "id">;

export function toolProgressResult(progress: PublicToolProgress): AgentToolResult<undefined> {
  return {
    content: [],
    details: undefined,
    progress: {
      text: progress.text,
      visibility: "channel",
      privacy: "public",
      ...(progress.id ? { id: progress.id } : {}),
    },
  };
}

// Tool progress is a UI side channel. The model-facing tool result remains in
// `content`; progress text must already be safe to show in channel previews.
export function emitToolProgress(
  onUpdate: AgentToolUpdateCallback | undefined,
  progress: PublicToolProgress,
): void {
  const text = progress.text.trim();
  if (!onUpdate || !text) {
    return;
  }
  try {
    onUpdate(toolProgressResult({ ...progress, text }));
  } catch {
    // Progress is best-effort UI state; tool execution must not depend on subscribers.
  }
}

// Long-running tools can arm delayed progress and cancel it on completion or
// abort. This avoids stale "still working" lines after a fast or canceled call.
export function scheduleToolProgress(
  onUpdate: AgentToolUpdateCallback | undefined,
  progress: PublicToolProgress,
  delayMs: number,
  options: { signal?: AbortSignal } = {},
): () => void {
  if (!onUpdate || options.signal?.aborted) {
    return () => {};
  }
  let cleared = false;
  const clear = () => {
    if (cleared) {
      return;
    }
    cleared = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", clear);
  };
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    clear();
    emitToolProgress(onUpdate, progress);
  }, delayMs);
  options.signal?.addEventListener("abort", clear, { once: true });
  return clear;
}

export async function imageResult(params: {
  label: string;
  path: string;
  base64: string;
  mimeType: string;
  extraText?: string;
  details?: Record<string, unknown>;
  imageSanitization?: ImageSanitizationLimits;
}): Promise<AgentToolResult<unknown>> {
  const content: AgentToolResult<unknown>["content"] = [
    ...(params.extraText ? [{ type: "text" as const, text: params.extraText }] : []),
    {
      type: "image",
      data: params.base64,
      mimeType: params.mimeType,
    },
  ];
  const detailsMedia =
    params.details?.media &&
    typeof params.details.media === "object" &&
    !Array.isArray(params.details.media)
      ? (params.details.media as Record<string, unknown>)
      : undefined;
  const result: AgentToolResult<unknown> = {
    content,
    details: {
      path: params.path,
      ...params.details,
      media: {
        ...detailsMedia,
        mediaUrl: params.path,
      },
    },
  };
  return await sanitizeToolResultImages(result, params.label, params.imageSanitization);
}

export async function imageResultFromFile(params: {
  label: string;
  path: string;
  extraText?: string;
  details?: Record<string, unknown>;
  imageSanitization?: ImageSanitizationLimits;
}): Promise<AgentToolResult<unknown>> {
  const buf = (await readLocalFileSafely({ filePath: params.path })).buffer;
  const mimeType = (await detectMime({ buffer: buf.slice(0, 256) })) ?? "image/png";
  return await imageResult({
    label: params.label,
    path: params.path,
    base64: buf.toString("base64"),
    mimeType,
    extraText: params.extraText,
    details: params.details,
    imageSanitization: params.imageSanitization,
  });
}

export type AvailableTag = {
  id?: string;
  name: string;
  moderated?: boolean;
  emoji_id?: string | null;
  emoji_name?: string | null;
};

/**
 * Validate and parse an `availableTags` parameter from untrusted input.
 * Returns `undefined` when the value is missing or not an array.
 * Entries that lack a string `name` are silently dropped.
 */
export function parseAvailableTags(raw: unknown): AvailableTag[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const result = raw
    .filter(
      (t): t is Record<string, unknown> =>
        typeof t === "object" && t !== null && typeof t.name === "string",
    )
    .map((t) =>
      Object.assign(
        {},
        t.id !== undefined && typeof t.id === `string` ? { id: t.id } : {},
        { name: t.name as string },
        typeof t.moderated === `boolean` ? { moderated: t.moderated } : {},
        t.emoji_id === null || typeof t.emoji_id === `string` ? { emoji_id: t.emoji_id } : {},
        t.emoji_name === null || typeof t.emoji_name === `string`
          ? { emoji_name: t.emoji_name }
          : {},
      ),
    );
  // Return undefined instead of empty array to avoid accidentally clearing all tags
  return result.length ? result : undefined;
}
