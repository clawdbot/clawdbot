// Agent command test mocks replace logging and runtime-heavy modules shared by agent command suites.
import { vi } from "vitest";
import { getAgentHarnessPluginMocks } from "./agent-command-state.test-mocks.js";

// Harness/plugin selection has focused owner coverage in runtime-plugin.test.ts.
// Command suites only need to prove their handoff without loading plugin manifests.
const agentHarnessPluginMocks = getAgentHarnessPluginMocks();

vi.mock("../agents/harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: agentHarnessPluginMocks.ensureSelectedAgentHarnessPlugin,
}));

vi.mock("../logging/subsystem.js", () => {
  const createMockLogger = () => ({
    subsystem: "test",
    isEnabled: vi.fn(() => true),
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  });
  return {
    createSubsystemLogger: vi.fn(() => createMockLogger()),
  };
});

vi.mock("../cli/deps.js", () => ({
  createDefaultDeps: vi.fn(() => ({})),
}));

const acpManagerMock = vi.hoisted(() => ({
  current: {
    resolveSession: vi.fn(() => null),
  } as unknown,
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  testing: {
    resetAcpSessionManagerForTests: vi.fn(() => {
      acpManagerMock.current = {
        resolveSession: vi.fn(() => null),
      };
    }),
    setAcpSessionManagerForTests: vi.fn((manager: unknown) => {
      acpManagerMock.current = manager;
    }),
  },
  getAcpSessionManager: vi.fn(() => acpManagerMock.current),
}));

vi.mock("../agents/embedded-agent.js", () => ({
  abortEmbeddedAgentRun: vi.fn().mockReturnValue(false),
  runEmbeddedAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadManifestModelCatalog: vi.fn(() => []),
  loadModelCatalog: vi.fn(),
}));

vi.mock("../agents/model-selection.js", () => {
  type ConfigWithModels = {
    agents?: {
      defaults?: {
        model?: string | { primary?: string; fallbacks?: string[] };
        models?: Record<string, { params?: { thinking?: string } } | undefined>;
        thinkingDefault?: string;
      };
    };
  };
  type ModelRef = { provider: string; model: string };
  type CatalogEntry = { id?: string; model?: string; name?: string; reasoning?: boolean };

  const parseModelRefImpl = (raw: string, defaultProvider = "openai"): ModelRef | null => {
    const value = raw.trim();
    if (!value) {
      return null;
    }
    const slash = value.indexOf("/");
    if (slash >= 0) {
      return {
        provider: value.slice(0, slash).trim(),
        model: value.slice(slash + 1).trim(),
      };
    }
    return { provider: defaultProvider, model: value };
  };
  const parseModelRef = vi.fn(parseModelRefImpl);
  const normalizeProviderId = (provider: string) => provider.trim().toLowerCase();
  const normalizeModelRef = (provider: string, model: string): ModelRef => ({
    provider: normalizeProviderId(provider),
    model: model.trim(),
  });
  const modelKey = (provider: string, model: string) =>
    `${normalizeProviderId(provider)}/${model.trim().toLowerCase()}`;
  const isModelKeyAllowedBySet = (allowedKeys: ReadonlySet<string>, key: string) => {
    if (allowedKeys.has(key)) {
      return true;
    }
    const slash = key.indexOf("/");
    return slash > 0 && allowedKeys.has(`${key.slice(0, slash)}/*`);
  };
  const resolvePrimary = (cfg?: ConfigWithModels): string | undefined => {
    const primary = cfg?.agents?.defaults?.model;
    if (typeof primary === "string") {
      return primary;
    }
    return primary?.primary;
  };
  const resolveDefaultRef = (cfg?: ConfigWithModels): ModelRef => {
    const parsed = parseModelRefImpl(resolvePrimary(cfg) ?? "openai/gpt-5.5", "openai");
    return parsed ?? { provider: "openai", model: "gpt-5.5" };
  };
  const resolveModelConfig = (cfg: ConfigWithModels | undefined, ref: ModelRef) => {
    const models = cfg?.agents?.defaults?.models ?? {};
    return models[`${ref.provider}/${ref.model}`] ?? models[modelKey(ref.provider, ref.model)];
  };

  return {
    buildAllowedModelSet: vi.fn(({ cfg }: { cfg?: ConfigWithModels; catalog?: CatalogEntry[] }) => {
      const refs = new Set<string>();
      const modelConfig = cfg?.agents?.defaults?.models ?? {};
      for (const raw of Object.keys(modelConfig)) {
        const parsed = parseModelRefImpl(raw, "openai");
        if (parsed) {
          refs.add(modelKey(parsed.provider, parsed.model));
        }
      }
      const primary = resolveDefaultRef(cfg);
      refs.add(modelKey(primary.provider, primary.model));
      const fallbackRefs =
        typeof cfg?.agents?.defaults?.model === "object"
          ? (cfg.agents.defaults.model.fallbacks ?? [])
          : [];
      for (const fallback of fallbackRefs) {
        const parsed = parseModelRefImpl(fallback, primary.provider);
        if (parsed) {
          refs.add(modelKey(parsed.provider, parsed.model));
        }
      }
      return {
        allowedKeys: refs,
        allowedCatalog: [],
        allowAny: Object.keys(modelConfig).length === 0,
      };
    }),
    createModelVisibilityPolicy: vi.fn(
      ({ cfg, catalog = [] }: { cfg?: ConfigWithModels; catalog?: CatalogEntry[] }) => {
        const refs = new Set<string>();
        const modelConfig = cfg?.agents?.defaults?.models ?? {};
        for (const raw of Object.keys(modelConfig)) {
          const parsed = parseModelRefImpl(raw, "openai");
          if (parsed) {
            refs.add(modelKey(parsed.provider, parsed.model));
          }
        }
        const primary = resolveDefaultRef(cfg);
        refs.add(modelKey(primary.provider, primary.model));
        const allowAny = Object.keys(modelConfig).length === 0;
        const allowsKey = (key: string) => allowAny || isModelKeyAllowedBySet(refs, key);
        return {
          allowAny,
          allowedKeys: refs,
          allowedCatalog: catalog,
          exactModelRefs: Object.keys(modelConfig).filter((key) => !key.endsWith("/*")),
          providerWildcards: new Set(
            Object.keys(modelConfig)
              .filter((key) => key.endsWith("/*"))
              .map((key) => key.slice(0, -2).trim().toLowerCase()),
          ),
          hasConfiguredEntries: Object.keys(modelConfig).length > 0,
          hasProviderWildcards: Object.keys(modelConfig).some((key) => key.endsWith("/*")),
          allowsKey,
          allows: ({ provider, model }: ModelRef) => allowsKey(modelKey(provider, model)),
          resolveSelection: ({ provider, model }: ModelRef) => {
            const key = modelKey(provider, model);
            if (allowsKey(key)) {
              return { provider, model };
            }
            const fallback = catalog[0];
            return fallback?.id ? { provider: "openai", model: fallback.id } : null;
          },
          visibleCatalog: ({ catalog: visibleCatalog }: { catalog: CatalogEntry[] }) =>
            visibleCatalog,
        };
      },
    ),
    buildConfiguredModelCatalog: vi.fn(() => []),
    buildModelAliasIndex: vi.fn(() => new Map()),
    isModelKeyAllowedBySet,
    isCliProvider: vi.fn(() => false),
    modelKey,
    normalizeModelRef,
    normalizeProviderId,
    normalizeProviderIdForAuth: normalizeProviderId,
    parseModelRef,
    resolveConfiguredModelRef: vi.fn(
      ({ cfg }: { cfg?: ConfigWithModels; defaultProvider?: string; defaultModel?: string }) =>
        resolveDefaultRef(cfg),
    ),
    resolveDefaultModelForAgent: vi.fn(({ cfg }: { cfg?: ConfigWithModels }) =>
      resolveDefaultRef(cfg),
    ),
    resolveModelRefFromString: vi.fn(
      ({ raw, defaultProvider }: { raw: string; defaultProvider?: string }) => {
        const ref = parseModelRef(raw, defaultProvider ?? "openai");
        return ref ? { ref, source: "parsed" } : null;
      },
    ),
    resolveThinkingDefault: vi.fn(
      ({
        cfg,
        provider,
        model,
        catalog,
      }: {
        cfg?: ConfigWithModels;
        provider: string;
        model: string;
        catalog?: CatalogEntry[];
      }) => {
        const ref = normalizeModelRef(provider, model);
        const modelThinking = resolveModelConfig(cfg, ref)?.params?.thinking;
        if (modelThinking) {
          return modelThinking;
        }
        const defaultThinking = cfg?.agents?.defaults?.thinkingDefault;
        if (defaultThinking) {
          return defaultThinking;
        }
        const entry = catalog?.find((item) => item.id === model || item.model === model);
        if (entry?.reasoning && entry.name?.includes("4.6")) {
          return "adaptive";
        }
        return entry?.reasoning ? "low" : "off";
      },
    ),
  };
});

vi.mock("../agents/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

vi.mock("../agents/workspace.js", () => ({
  DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/openclaw-workspace",
  DEFAULT_AGENTS_FILENAME: "AGENTS.md",
  DEFAULT_IDENTITY_FILENAME: "IDENTITY.md",
  resolveDefaultAgentWorkspaceDir: () => "/tmp/openclaw-workspace",
  ensureAgentWorkspace: vi.fn(async ({ dir }: { dir: string }) => ({ dir })),
}));

vi.mock("../skills/loading/workspace.js", () => ({
  buildWorkspaceSkillSnapshot: vi.fn(() => undefined),
  loadWorkspaceSkillEntries: vi.fn(() => []),
}));

vi.mock("../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: vi.fn(() => undefined),
}));

vi.mock("../skills/discovery/agent-filter.js", () => ({
  resolveEffectiveAgentSkillFilter: vi.fn(() => undefined),
}));

vi.mock("../skills/runtime/session-snapshot.js", () => ({
  resolveReusableWorkspaceSkillSnapshot: vi.fn(
    (params?: { existingSnapshot?: unknown; skillFilter?: string[] }) => ({
      snapshot: params?.existingSnapshot ?? {
        prompt: "",
        skills: [],
        resolvedSkills: [],
        ...(params?.skillFilter === undefined ? {} : { skillFilter: params.skillFilter }),
        version: 0,
      },
      shouldRefresh: !params?.existingSnapshot,
      snapshotVersion: 0,
    }),
  ),
}));

vi.mock("../agents/exec-defaults.js", () => ({
  resolveNodeExecEligibility: vi.fn(() => ({ canExec: false })),
}));
