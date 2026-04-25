import type {
  GatewaySessionRow,
  ModelCatalogEntry,
  SessionsListResult,
  SessionsPatchResult,
} from "./types.ts";

export const OPENAI_GPT5_MODEL: ModelCatalogEntry = {
  id: "gpt-5",
  name: "GPT-5",
  provider: "openai",
};

export const OPENAI_GPT5_MINI_MODEL: ModelCatalogEntry = {
  id: "gpt-5-mini",
  name: "GPT-5 Mini",
  provider: "openai",
};

export const DEEPSEEK_CHAT_MODEL: ModelCatalogEntry = {
  id: "deepseek-chat",
  name: "DeepSeek Chat",
  provider: "deepseek",
};

export const DEFAULT_CHAT_MODEL_CATALOG = [
  OPENAI_GPT5_MODEL,
  OPENAI_GPT5_MINI_MODEL,
] satisfies ModelCatalogEntry[];

export function createModelCatalog(...entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return [...entries];
}

export function createAmbiguousModelCatalog(
  id: string,
  ...providers: string[]
): ModelCatalogEntry[] {
  return providers.map((provider) => ({
    id,
    name: id,
    provider,
  }));
}

export function createMainSessionRow(
  overrides: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return {
    key: "main",
    kind: "direct",
    updatedAt: null,
    ...overrides,
  };
}

export function createSessionsListResult(
  params: {
    model?: string | null;
    modelProvider?: string | null;
    defaultsModel?: string | null;
    defaultsProvider?: string | null;
    defaultsThinkingLevels?: SessionsListResult["defaults"]["thinkingLevels"];
    defaultsThinkingOptions?: string[];
    defaultsThinkingDefault?: string;
    omitSessionFromList?: boolean;
  } = {},
): SessionsListResult {
  const {
    model = null,
    modelProvider = model ? "openai" : null,
    defaultsModel = "gpt-5",
    defaultsProvider = defaultsModel ? "openai" : null,
    defaultsThinkingLevels,
    defaultsThinkingOptions,
    defaultsThinkingDefault,
    omitSessionFromList = false,
  } = params;

  return {
    ts: 0,
    path: "",
    count: omitSessionFromList ? 0 : 1,
    defaults: {
      modelProvider: defaultsProvider,
      model: defaultsModel,
      contextTokens: null,
      ...(defaultsThinkingLevels ? { thinkingLevels: defaultsThinkingLevels } : {}),
      ...(defaultsThinkingOptions ? { thinkingOptions: defaultsThinkingOptions } : {}),
      ...(defaultsThinkingDefault ? { thinkingDefault: defaultsThinkingDefault } : {}),
    },
    sessions: omitSessionFromList
      ? []
      : [
          createMainSessionRow({
            ...(modelProvider ? { modelProvider } : {}),
            ...(model ? { model } : {}),
          }),
        ],
  };
}

export function createResolvedModelPatch(
  model: string,
  modelProvider?: string | null,
): SessionsPatchResult {
  return {
    ok: true,
    path: "",
    key: "main",
    entry: {
      sessionId: "main",
    },
    resolved: {
      model,
      modelProvider: modelProvider ?? undefined,
    },
  };
}
