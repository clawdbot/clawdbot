import type { CodexAppServerStartOptions } from "./config.js";
import { type JsonObject, type JsonValue } from "./protocol.js";
import {
  createIsolatedCodexAppServerClient,
  getSharedCodexAppServerClient,
} from "./shared-client.js";

export type CodexAppServerModel = {
  id: string;
  model: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  inputModalities: string[];
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
};

export type CodexAppServerModelListResult = {
  models: CodexAppServerModel[];
  nextCursor?: string;
};

export type CodexAppServerListModelsOptions = {
  limit?: number;
  cursor?: string;
  includeHidden?: boolean;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string;
  sharedClient?: boolean;
};

export async function listCodexAppServerModels(
  options: CodexAppServerListModelsOptions = {},
): Promise<CodexAppServerModelListResult> {
  const timeoutMs = options.timeoutMs ?? 2500;
  const useSharedClient = options.sharedClient !== false;
  const client = useSharedClient
    ? await getSharedCodexAppServerClient({
        startOptions: options.startOptions,
        timeoutMs,
        authProfileId: options.authProfileId,
      })
    : await createIsolatedCodexAppServerClient({
        startOptions: options.startOptions,
        timeoutMs,
        authProfileId: options.authProfileId,
      });
  try {
    const response = await client.request<JsonObject>(
      "model/list",
      {
        limit: options.limit ?? null,
        cursor: options.cursor ?? null,
        includeHidden: options.includeHidden ?? null,
      },
      { timeoutMs },
    );
    return readModelListResult(response);
  } finally {
    if (!useSharedClient) {
      client.close();
    }
  }
}

function readModelListResult(value: JsonValue | undefined): CodexAppServerModelListResult {
  if (!isJsonObjectValue(value) || !Array.isArray(value.data)) {
    return { models: [] };
  }
  const models = value.data
    .map((entry) => readCodexModel(entry))
    .filter((entry): entry is CodexAppServerModel => entry !== undefined);
  const nextCursor = typeof value.nextCursor === "string" ? value.nextCursor : undefined;
  return { models, ...(nextCursor ? { nextCursor } : {}) };
}

function readCodexModel(value: unknown): CodexAppServerModel | undefined {
  if (!isJsonObjectValue(value)) {
    return undefined;
  }
  const id = readNonEmptyString(value.id);
  const model = readNonEmptyString(value.model) ?? id;
  if (!id || !model) {
    return undefined;
  }
  return {
    id,
    model,
    ...(readNonEmptyString(value.displayName)
      ? { displayName: readNonEmptyString(value.displayName) }
      : {}),
    ...(readNonEmptyString(value.description)
      ? { description: readNonEmptyString(value.description) }
      : {}),
    ...(typeof value.hidden === "boolean" ? { hidden: value.hidden } : {}),
    ...(typeof value.isDefault === "boolean" ? { isDefault: value.isDefault } : {}),
    inputModalities: readStringArray(value.inputModalities),
    supportedReasoningEfforts: readReasoningEfforts(value.supportedReasoningEfforts),
    ...(readNonEmptyString(value.defaultReasoningEffort)
      ? { defaultReasoningEffort: readNonEmptyString(value.defaultReasoningEffort) }
      : {}),
  };
}

function readReasoningEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const efforts = value
    .map((entry) => {
      if (!isJsonObjectValue(entry)) {
        return undefined;
      }
      return readNonEmptyString(entry.reasoningEffort);
    })
    .filter((entry): entry is string => entry !== undefined);
  return [...new Set(efforts)];
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .map((entry) => readNonEmptyString(entry))
        .filter((entry): entry is string => entry !== undefined),
    ),
  ];
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isJsonObjectValue(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
