import fs from "node:fs/promises";
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import type { TSchema } from "typebox";
import { detectMime } from "../../media/mime.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import { sanitizeToolResultImages } from "../tool-images.js";

export type AgentToolWithMeta<TParameters extends TSchema, TResult> = AgentTool<
  TParameters,
  TResult
> & {
  ownerOnly?: boolean;
  displaySummary?: string;
};

type ErasedAgentToolExecute = {
  execute(
    this: void,
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
  ): Promise<AgentToolResult<unknown>>;
};

export type AnyAgentTool = Omit<AgentTool<TSchema, unknown>, "execute"> &
  ErasedAgentToolExecute & {
    ownerOnly?: boolean;
    displaySummary?: string;
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

export const OWNER_ONLY_TOOL_ERROR = "Tool restricted to owner senders.";

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
  options: { required?: boolean; label?: string; integer?: boolean; strict?: boolean } = {},
): number | undefined {
  const { required = false, label = key, integer = false, strict = false } = options;
  const raw = readParamRaw(params, key);
  let value: number | undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    value = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed) {
      const parsed = strict ? Number(trimmed) : Number.parseFloat(trimmed);
      if (Number.isFinite(parsed)) {
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
  return integer ? Math.trunc(value) : value;
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
    const values = raw
      .filter((entry) => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
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

export function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    details,
  };
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

export function jsonResult(payload: unknown): AgentToolResult<unknown> {
  return textResult(JSON.stringify(payload, null, 2), payload);
}

export function wrapOwnerOnlyToolExecution(
  tool: AnyAgentTool,
  senderIsOwner: boolean,
): AnyAgentTool {
  if (tool.ownerOnly !== true || senderIsOwner || !tool.execute) {
    return tool;
  }
  return {
    ...tool,
    execute: async () => {
      throw new Error(OWNER_ONLY_TOOL_ERROR);
    },
  };
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
  const buf = await fs.readFile(params.path);
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
