import type { SessionEntry } from "../config/sessions.js";
import { normalizeLegacySessionEntryDelivery } from "../infra/state-migrations.legacy-session-store.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

export type CommandSessionEntryFixture = Partial<SessionEntry> & {
  channel?: string;
  deliveryContext?: DeliveryContext;
  lastThreadId?: string | number;
};

export function createCommandSessionEntry(
  overrides: CommandSessionEntryFixture = {},
): SessionEntry {
  return normalizeLegacySessionEntryDelivery({
    sessionId: "session-1",
    updatedAt: 1,
    ...overrides,
  } as SessionEntry);
}

export function createCommandSessionFixture(
  overrides: CommandSessionEntryFixture = {},
  sessionKey = "agent:main:main",
): { entry: SessionEntry; store: Record<string, SessionEntry> } {
  const entry = createCommandSessionEntry({
    skillsSnapshot: { prompt: "", skills: [], version: 0 },
    ...overrides,
  });
  return { entry, store: { [sessionKey]: entry } };
}

export function createChannelModelRuntimeConfig({
  channel = "discord",
  matchKey = "channel-123",
  model = "openai/channel-model",
  additionalModels = {},
}: {
  channel?: string;
  matchKey?: string;
  model?: string;
  additionalModels?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return {
    agents: {
      defaults: {
        model: "anthropic/default-model",
        models: {
          "anthropic/default-model": {},
          [model]: {},
          ...additionalModels,
        },
      },
    },
    channels: { modelByChannel: { [channel]: { [matchKey]: model } } },
  };
}

export function createConfiguredModelCompatRuntimeConfig(allowlisted: boolean) {
  return {
    agents: {
      defaults: {
        model: { primary: "gmn/gpt-5.4" },
        ...(allowlisted ? { models: { "gmn/gpt-5.4": {} } } : {}),
      },
    },
    models: {
      providers: {
        gmn: {
          models: [
            {
              id: "gpt-5.4",
              name: "GPT 5.4 via GMN",
              reasoning: true,
              compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
            },
          ],
        },
      },
    },
  };
}

type ModelCatalogEntry = {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  compat?: unknown;
};

type ModelSelectionParams = {
  cfg?: unknown;
  catalog?: ModelCatalogEntry[];
  defaultProvider: string;
  defaultModel?: string;
};

export const normalizeTestProviderId = (provider: string) => provider.trim().toLowerCase();

export function isTestModelKeyAllowed(allowedKeys: ReadonlySet<string>, key: string): boolean {
  if (allowedKeys.has(key)) {
    return true;
  }
  let separator = key.indexOf("/");
  while (separator > 0) {
    if (allowedKeys.has(`${key.slice(0, separator + 1)}*`)) {
      return true;
    }
    separator = key.indexOf("/", separator + 1);
  }
  return false;
}

export function buildTestConfiguredModelCatalog(cfg?: unknown): ModelCatalogEntry[] {
  const providers = (cfg as { models?: { providers?: Record<string, { models?: unknown[] }> } })
    ?.models?.providers;
  if (!providers) {
    return [];
  }
  return Object.entries(providers).flatMap(([provider, entry]) =>
    Array.isArray(entry?.models)
      ? entry.models
          .filter(
            (model): model is Record<string, unknown> =>
              Boolean(model) && typeof model === "object",
          )
          .map((model) => {
            const id = typeof model.id === "string" ? model.id : "";
            return {
              provider,
              id,
              name: typeof model.name === "string" ? model.name : id,
              reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
              compat: model.compat,
            };
          })
          .filter((model) => model.id)
      : [],
  );
}

export function buildTestAllowedModelSet({
  cfg,
  catalog,
  defaultProvider,
  defaultModel,
}: ModelSelectionParams) {
  const modelMap =
    (cfg as { agents?: { defaults?: { models?: Record<string, unknown> } } } | undefined)?.agents
      ?.defaults?.models ?? {};
  const allowedKeys = new Set(Object.keys(modelMap));
  if (defaultModel) {
    allowedKeys.add(`${defaultProvider}/${defaultModel}`);
  }
  const allowedCatalog = [...(catalog ?? []), ...buildTestConfiguredModelCatalog(cfg)];
  if (Object.keys(modelMap).length === 0) {
    return { allowedKeys, allowedCatalog, allowAny: true };
  }
  return {
    allowedKeys,
    allowedCatalog: allowedCatalog.filter((entry) =>
      allowedKeys.has(`${entry.provider}/${entry.id}`),
    ),
    allowAny: false,
  };
}

export function createTestModelVisibilityPolicy(params: ModelSelectionParams) {
  const allowed = buildTestAllowedModelSet(params);
  const wildcardModelKeys = new Set([...allowed.allowedKeys].filter((key) => key.endsWith("/*")));
  const allowsKey = (key: string) =>
    allowed.allowAny || isTestModelKeyAllowed(allowed.allowedKeys, key);
  return {
    ...allowed,
    exactModelRefs: [],
    providerWildcards: new Set<string>(),
    hasConfiguredEntries: !allowed.allowAny,
    hasProviderWildcards: wildcardModelKeys.size > 0,
    allowsKey,
    allows: ({ provider, model }: { provider: string; model: string }) =>
      allowsKey(`${provider}/${model}`),
    allowsByWildcard: ({ provider, model }: { provider: string; model: string }) =>
      isTestModelKeyAllowed(wildcardModelKeys, `${provider}/${model}`),
    resolveSelection: ({ provider, model }: { provider: string; model: string }) => {
      if (allowsKey(`${provider}/${model}`)) {
        return { provider, model };
      }
      const fallback = allowed.allowedCatalog[0];
      return fallback ? { provider: fallback.provider, model: fallback.id } : null;
    },
    visibleCatalog: ({ catalog }: { catalog: ModelCatalogEntry[] }) => catalog,
  };
}

export function buildTestModelAliasIndex({
  cfg,
}: {
  cfg?: { agents?: { defaults?: { models?: Record<string, { alias?: string }> } } };
}) {
  const byAlias = new Map<string, { alias: string; ref: { provider: string; model: string } }>();
  const byKey = new Map<string, string[]>();
  for (const [ref, entry] of Object.entries(cfg?.agents?.defaults?.models ?? {})) {
    const alias = entry?.alias?.trim();
    if (!alias) {
      continue;
    }
    const [provider, ...modelParts] = ref.split("/");
    if (!provider) {
      throw new Error(`expected provider in model ref ${ref}`);
    }
    const model = modelParts.join("/");
    byAlias.set(alias.toLowerCase(), { alias, ref: { provider, model } });
    byKey.set(`${provider}/${model}`, [alias]);
  }
  return { byAlias, byKey };
}

export function resolveTestModelRefFromString({
  raw,
  defaultProvider,
  aliasIndex,
}: {
  raw: string;
  defaultProvider: string;
  aliasIndex?: ReturnType<typeof buildTestModelAliasIndex>;
}) {
  const aliasMatch = aliasIndex?.byAlias.get(raw.trim().toLowerCase());
  if (aliasMatch) {
    return { ref: aliasMatch.ref, alias: aliasMatch.alias };
  }
  const slash = raw.indexOf("/");
  return {
    ref:
      slash > 0
        ? { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
        : { provider: defaultProvider, model: raw },
  };
}

function configuredPrimary(cfg?: unknown): string {
  const raw = (cfg as { agents?: { defaults?: { model?: string | { primary?: string } } } })?.agents
    ?.defaults?.model;
  return (typeof raw === "string" ? raw : raw?.primary) ?? "anthropic/claude";
}

export function resolveTestConfiguredModelRef({ cfg }: { cfg?: unknown }) {
  const [provider = "anthropic", ...modelParts] = configuredPrimary(cfg).split("/");
  return { provider, model: modelParts.join("/") || "claude" };
}

export function resolveTestDefaultModelForAgent({ cfg }: { cfg?: unknown }) {
  const { provider, model: modelWithProfile } = resolveTestConfiguredModelRef({ cfg });
  const [model = "claude", authProfileId] = modelWithProfile.split("@");
  return { provider, model, ...(authProfileId ? { authProfileId } : {}) };
}
