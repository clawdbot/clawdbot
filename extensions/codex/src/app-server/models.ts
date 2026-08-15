/**
 * Lists and normalizes models exposed by the Codex app-server `model/list`
 * endpoint, including pagination and shared-client lease handling.
 */
import { normalizeOptionalString, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  CodexAppServerAuthRequirement,
  resolveCodexAppServerAuthProfileIdForAgent,
} from "./auth-bridge.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import { assertCodexModelListResponse } from "./protocol-validators.js";
import type { CodexModel, CodexReasoningEffortOption } from "./protocol.js";

/** Normalized model metadata returned by the Codex app-server model listing helper. */
type CodexAppServerModel = {
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

/** One page of Codex app-server model metadata plus optional pagination state. */
export type CodexAppServerModelListResult = {
  models: CodexAppServerModel[];
  nextCursor?: string;
  truncated?: boolean;
};

/** Options for querying Codex app-server models through a shared or isolated client. */
type CodexAppServerListModelsOptions = {
  limit?: number;
  cursor?: string;
  includeHidden?: boolean;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string;
  authRequirement?: CodexAppServerAuthRequirement;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  sharedClient?: boolean;
};

/** Lists one Codex app-server model page using the configured auth/client options. */
export async function listCodexAppServerModels(
  options: CodexAppServerListModelsOptions = {},
): Promise<CodexAppServerModelListResult> {
  return await withCodexAppServerModelClient(options, async ({ client, timeoutMs }) =>
    requestModelListPage(client, { ...options, timeoutMs }),
  );
}

/** Walks Codex app-server model pages until exhaustion or the max-page guard. */
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
  const {
    createIsolatedCodexAppServerClient,
    getLeasedSharedCodexAppServerClient,
    releaseLeasedSharedCodexAppServerClient,
  } = await import("./shared-client.js");
  const client = useSharedClient
    ? await getLeasedSharedCodexAppServerClient({
        startOptions: options.startOptions,
        timeoutMs,
        authProfileId: options.authProfileId,
        authRequirement: options.authRequirement,
        agentDir: options.agentDir,
        config: options.config,
      })
    : await createIsolatedCodexAppServerClient({
        startOptions: options.startOptions,
        timeoutMs,
        authProfileId: options.authProfileId,
        authRequirement: options.authRequirement,
        agentDir: options.agentDir,
        config: options.config,
      });
  try {
    return await run({ client, timeoutMs });
  } finally {
    if (useSharedClient) {
      releaseLeasedSharedCodexAppServerClient(client);
    } else {
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

/** Parses a raw Codex app-server model/list response into OpenClaw's normalized shape. */
export function readModelListResult(value: unknown): CodexAppServerModelListResult {
  const response = assertCodexModelListResponse(value);
  const models = response.data.map((entry) => readCodexModel(entry));
  const nextCursor = response.nextCursor ?? undefined;
  return { models, ...(nextCursor ? { nextCursor } : {}) };
}

function readCodexModel(value: CodexModel): CodexAppServerModel {
  const id = normalizeOptionalString(value.id);
  const model = normalizeOptionalString(value.model);
  if (!id || !model) {
    throw new Error(
      "Invalid Codex app-server model/list response: model id and name must be non-empty strings",
    );
  }
  return {
    id,
    model,
    ...(normalizeOptionalString(value.displayName)
      ? { displayName: normalizeOptionalString(value.displayName) }
      : {}),
    ...(normalizeOptionalString(value.description)
      ? { description: normalizeOptionalString(value.description) }
      : {}),
    hidden: value.hidden,
    isDefault: value.isDefault,
    inputModalities: value.inputModalities,
    supportedReasoningEfforts: readReasoningEfforts(value.supportedReasoningEfforts),
    ...(normalizeOptionalString(value.defaultReasoningEffort)
      ? { defaultReasoningEffort: normalizeOptionalString(value.defaultReasoningEffort) }
      : {}),
  };
}

function readReasoningEfforts(value: CodexReasoningEffortOption[]): string[] {
  const efforts = value
    .map((entry) => normalizeOptionalString(entry.reasoningEffort))
    .filter((entry): entry is string => entry !== undefined);
  return uniqueStrings(efforts);
}

function normalizeMaxPages(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 20;
}
