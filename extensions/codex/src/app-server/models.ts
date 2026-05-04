import type { resolveCodexAppServerAuthProfileIdForAgent } from "./auth-bridge.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import type { v2 } from "./protocol-generated/typescript/index.js";
import { readCodexModelListResponse } from "./protocol-validators.js";

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
  truncated?: boolean;
};

export type CodexAppServerListModelsOptions = {
  limit?: number;
  cursor?: string;
  includeHidden?: boolean;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  sharedClient?: boolean;
};

export async function listCodexAppServerModels(
  options: CodexAppServerListModelsOptions = {},
): Promise<CodexAppServerModelListResult> {
  return await withCodexAppServerModelClient(options, async ({ client, timeoutMs }) =>
    requestModelListPage(client, { ...options, timeoutMs }),
  );
}

export async function listAllCodexAppServerModels(
  options: CodexAppServerListModelsOptions & { maxPages?: number } = {},
): Promise<CodexAppServerModelListResult> {
  const maxPages = normalizeMaxPages(options.maxPages);
  return await withCodexAppServerModelClient(options, async ({ client, timeoutMs }) => {
    const models: CodexAppServerModel[] = [];
    let cursor = options.cursor;
    let nextCursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await requestModelListPage(client, {
        ...options,
        timeoutMs,
        cursor,
      });
      models.push(...result.models);
      nextCursor = result.nextCursor;
      if (!nextCursor) {
        return { models };
      }
      cursor = nextCursor;
    }
    return { models, nextCursor, truncated: true };
  });
}

async function withCodexAppServerModelClient<T>(
  options: CodexAppServerListModelsOptions,
  run: (params: { client: CodexAppServerClient; timeoutMs: number }) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 2500;
  const useSharedClient = options.sharedClient !== false;
  const { createIsolatedCodexAppServerClient, getSharedCodexAppServerClient } =
    await import("./shared-client.js");
  const client = useSharedClient
    ? await getSharedCodexAppServerClient({
        startOptions: options.startOptions,
        timeoutMs,
        authProfileId: options.authProfileId,
        agentDir: options.agentDir,
        config: options.config,
      })
    : await createIsolatedCodexAppServerClient({
        startOptions: options.startOptions,
        timeoutMs,
        authProfileId: options.authProfileId,
        agentDir: options.agentDir,
        config: options.config,
      });
  try {
    return await run({ client, timeoutMs });
  } finally {
    if (!useSharedClient) {
      client.close();
    }
  }
}

async function requestModelListPage(
  client: CodexAppServerClient,
  options: CodexAppServerListModelsOptions & { timeoutMs: number },
): Promise<CodexAppServerModelListResult> {
  const response = await client.request(
    "model/list",
    {
      limit: options.limit ?? null,
      cursor: options.cursor ?? null,
      includeHidden: options.includeHidden ?? null,
    },
    { timeoutMs: options.timeoutMs },
  );
  return readModelListResult(response);
}

export function readModelListResult(value: unknown): CodexAppServerModelListResult {
  const response = readCodexModelListResponse(value);
  if (!response) {
    return { models: [] };
  }
  const models = response.data
    .map((entry) => readCodexModel(entry))
    .filter((entry): entry is CodexAppServerModel => entry !== undefined);
  const nextCursor = response.nextCursor ?? undefined;
  return { models, ...(nextCursor ? { nextCursor } : {}) };
}

function readCodexModel(value: v2.Model): CodexAppServerModel | undefined {
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
    hidden: value.hidden,
    isDefault: value.isDefault,
    inputModalities: value.inputModalities,
    supportedReasoningEfforts: readReasoningEfforts(value.supportedReasoningEfforts),
    ...(readNonEmptyString(value.defaultReasoningEffort)
      ? { defaultReasoningEffort: readNonEmptyString(value.defaultReasoningEffort) }
      : {}),
  };
}

function readReasoningEfforts(value: v2.ReasoningEffortOption[]): string[] {
  const efforts = value
    .map((entry) => readNonEmptyString(entry.reasoningEffort))
    .filter((entry): entry is string => entry !== undefined);
  return [...new Set(efforts)];
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeMaxPages(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 20;
}
