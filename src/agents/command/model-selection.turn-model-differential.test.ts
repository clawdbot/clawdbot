import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  TURN_MODEL_DEFAULT_REF,
  TURN_MODEL_DIFFERENTIAL_FIXTURES,
  TURN_MODEL_OVERRIDE_REF,
  turnModelRefLabel,
  turnModelVerdict,
  type TurnModelDifferentialFixture,
} from "../../test-utils/turn-model-selection-differential.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import { normalizeModelRef } from "../model-ref-shared.js";
import * as providerModelNormalizationRuntime from "../provider-model-normalization.runtime.js";
import type { AgentCommandOpts, AgentRunContext } from "./types.js";

vi.mock("../agent-scope.js", async (importOriginal) => {
  const { resolveAgentModelFallbacksOverride } =
    await importOriginal<typeof import("../agent-scope.js")>();
  return {
    clearAutoFallbackPrimaryProbeSelection: vi.fn(),
    hasLegacyAutoFallbackWithoutOrigin: () => false,
    hasSessionAutoModelFallbackProvenance: () => false,
    resolveAutoFallbackPrimaryProbe: () => undefined,
    resolveAgentConfig: () => undefined,
    resolveAgentEffectiveModelPrimary: () => undefined,
    resolveAgentModelFallbacksOverride,
  };
});
vi.mock("../../auto-reply/thinking.js", () => ({
  formatThinkingLevels: () => "",
  isThinkingLevelSupported: () => true,
  normalizeThinkLevel: (value: string | undefined) => value,
}));
vi.mock("../../channels/model-overrides.js", () => ({
  resolveChannelModelOverride: (params: {
    cfg: OpenClawConfig;
    channel?: string | null;
    groupId?: string | null;
    groupChatType?: string | null;
    groupChannel?: string | null;
    groupSubject?: string | null;
    directUserIds?: (string | null | undefined)[];
  }) => {
    const channel = params.channel?.trim().toLowerCase();
    const entries = channel ? params.cfg.channels?.modelByChannel?.[channel] : undefined;
    if (!channel || !entries) {
      return null;
    }
    const candidates =
      params.groupChatType === "direct"
        ? [params.groupId, ...(params.directUserIds ?? [])]
        : [params.groupId, params.groupChannel, params.groupSubject];
    const matchKey = candidates.find((candidate) => candidate && entries[candidate] !== undefined);
    const wildcard = entries["*"];
    const model = matchKey ? entries[matchKey] : wildcard;
    return model
      ? { channel, model, matchKey: matchKey ?? "*", matchSource: matchKey ? "exact" : "wildcard" }
      : null;
  },
}));
vi.mock("../../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (value: string) => value !== "internal",
}));

vi.mock("../auth-profiles/order.js", () => ({
  isStoredCredentialCompatibleWithAuthProvider: () => true,
}));
vi.mock("../auth-profiles/session-override.js", () => ({
  clearSessionAuthProfileOverride: vi.fn(async () => undefined),
}));
vi.mock("../auth-profiles/store.js", () => ({
  ensureAuthProfileStore: () => ({ profiles: {} }),
}));
vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));
vi.mock("../harness/selection.js", () => ({
  resolveAvailableAgentHarnessPolicy: () => ({ runtime: "openclaw" }),
}));
vi.mock("../model-catalog.js", () => ({ loadManifestModelCatalog: () => [] }));
vi.mock("../provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));
vi.mock("../model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model-selection.js")>()),
  modelKey: (provider: string, model: string) => `${provider}/${model}`,
  resolveDefaultModelForAgent: ({ cfg }: { cfg: OpenClawConfig }) => {
    const configured = cfg.agents?.defaults?.model;
    const raw =
      typeof configured === "string"
        ? configured
        : (configured?.primary ?? turnModelRefLabel(TURN_MODEL_DEFAULT_REF));
    const slash = raw.indexOf("/");
    return slash > 0
      ? { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
      : { provider: TURN_MODEL_DEFAULT_REF.provider, model: raw };
  },
  resolveModelAliasFromPair: () => null,
  resolveThinkingDefault: () => "off",
}));
vi.mock("../model-thinking-default.js", () => ({
  resolveConfiguredThinkingDefault: () => undefined,
}));
vi.mock("../openai-routing.js", () => ({
  listOpenAIAuthProfileProvidersForAgentRuntime: ({ provider }: { provider: string }) => [provider],
}));
vi.mock("../provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: (provider: string) => provider,
}));
vi.mock("../session-runtime-compat.js", () => ({
  resolveSessionRuntimeOverrideForProvider: () => undefined,
}));
vi.mock("../thinking-runtime.js", () => ({
  hasResolvedThinkingCatalogEntry: () => false,
  normalizeThinkingCatalogProviders: (catalog: unknown) => catalog,
  resolveEffectiveAgentRuntime: () => undefined,
}));
vi.mock("../../plugins/runtime.js", () => ({ requireActivePluginRegistry: () => ({}) }));
vi.mock("../../sessions/agent-harness-session-key.js", () => ({
  isValidAgentHarnessSessionStoreEntry: () => false,
}));
vi.mock("../../sessions/model-overrides.js", () => ({
  applyModelOverrideToSessionEntry: () => ({ updated: false }),
  isModelSelectionLocked: (entry?: SessionEntry) => entry?.modelSelectionLocked === true,
  ModelSelectionLockedError: class ModelSelectionLockedError extends Error {},
  repairProviderWrappedModelOverride: () => ({ updated: false }),
}));
vi.mock("./attempt-execution.shared.js", () => ({
  persistAgentSession: async ({ entry }: { entry?: SessionEntry }) => entry,
}));
vi.mock("./prepare.js", () => ({
  normalizeExplicitOverrideInput: (value: string) => value.trim() || undefined,
}));
vi.mock("./runtime-loaders.js", () => ({
  loadTranscriptResolveRuntime: async () => ({
    resolveSessionTranscriptFile: async (params: { sessionEntry?: SessionEntry }) => ({
      sessionEntry: params.sessionEntry,
      sessionFile: "/tmp/turn-model-session.jsonl",
    }),
  }),
}));

const { resolveEmbeddedModelSelection } = await import("./model-selection.js");

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let suiteTempRoot = "";

beforeAll(() => {
  suiteTempRoot = tempDirs.make("turn-model-command-");
});

function createConfig(fixture: TurnModelDifferentialFixture): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary: turnModelRefLabel(TURN_MODEL_DEFAULT_REF) } } },
    channels: fixture.modelByChannel ? { modelByChannel: fixture.modelByChannel } : undefined,
  } as OpenClawConfig;
}

async function observeCommandSelection(fixture: TurnModelDifferentialFixture) {
  const fixtureIndex = TURN_MODEL_DIFFERENTIAL_FIXTURES.indexOf(fixture);
  const sessionKey = "agent:main:telegram:group:selection";
  const sessionStore: Record<string, SessionEntry> = { [sessionKey]: fixture.child };
  if (fixture.parent) {
    sessionStore[fixture.parent.key] = fixture.parent.entry;
  }
  const opts: AgentCommandOpts = {
    message: "hello",
    to: "target",
    channel: fixture.ctx.Provider,
    messageChannel: fixture.ctx.Provider,
    groupId: fixture.child.groupId,
    groupChannel: fixture.child.groupChannel,
    ...(fixture.heartbeat
      ? {
          provider: TURN_MODEL_OVERRIDE_REF.provider,
          model: TURN_MODEL_OVERRIDE_REF.model,
          allowModelOverride: true,
        }
      : {}),
  };
  const runContext: AgentRunContext = {
    messageChannel: fixture.ctx.Provider,
    groupId: fixture.child.groupId,
    groupChannel: fixture.child.groupChannel,
    currentChannelId: "target",
  };
  const selection = await resolveEmbeddedModelSelection({
    cfg: createConfig(fixture),
    opts,
    sessionEntry: fixture.child,
    sessionStore,
    sessionKey,
    sessionId: fixture.child.sessionId,
    storePath: path.join(suiteTempRoot, `sessions-${fixtureIndex}.json`),
    sessionAgentId: "main",
    workspaceDir: suiteTempRoot,
    pluginsEnabled: false,
    modelManifestContext: { manifestPlugins: [] },
    configuredThinkingCatalog: [],
    isSubagentLane: false,
    suppressVisibleSessionEffects: true,
    runContext,
  });
  return turnModelVerdict(
    { provider: selection.provider, model: selection.model },
    fixture.locked ? "locked" : fixture.heartbeat ? "explicit" : undefined,
  );
}

describe("turn model selection command-path differential", () => {
  it.each(TURN_MODEL_DIFFERENTIAL_FIXTURES)("pins observed $name behavior", async (fixture) => {
    await expect(observeCommandSelection(fixture)).resolves.toEqual(fixture.expected.command);
  });

  it.each([
    ...(["raw", "resolved", "legacy"] as const).map((provenance) => ({
      name: `${provenance} provenance`,
      provenance,
      storedModel: provenance === "raw" ? "legacy-pin" : "captured-pin",
      configuredModel: undefined,
      expectedModel: "captured-pin",
      rawHookCalls: provenance === "raw" ? 1 : 0,
    })),
    {
      name: "an exact configured pin",
      provenance: "raw",
      storedModel: "captured-pin",
      configuredModel: "captured-pin",
      expectedModel: "captured-pin",
      rawHookCalls: 0,
    },
    {
      name: "a literal nested configured pin",
      provenance: "raw",
      storedModel: "fixture/captured-pin",
      configuredModel: "fixture/captured-pin",
      expectedModel: "fixture/captured-pin",
      rawHookCalls: 0,
    },
    {
      name: "a legacy provider-wrapped raw pin",
      provenance: "raw",
      storedModel: "fixture/legacy-pin",
      configuredModel: undefined,
      expectedModel: "captured-pin",
      rawHookCalls: 1,
    },
  ])(
    "preserves the prepared stored model through command selection for $name",
    async ({ provenance, storedModel, configuredModel, expectedModel, rawHookCalls }) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: "fixture/default" } },
      };
      if (configuredModel) {
        cfg.models = {
          providers: {
            fixture: {
              baseUrl: "https://fixture.test/v1",
              models: [
                {
                  id: configuredModel,
                  name: "Configured command model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 4096,
                  maxTokens: 1024,
                },
              ],
            },
          },
        };
      }
      const normalize = vi
        .spyOn(providerModelNormalizationRuntime, "normalizeProviderModelIdWithRuntime")
        .mockImplementation(({ provider, context }) => {
          if (provider !== "fixture") {
            return undefined;
          }
          return context.modelId === "legacy-pin"
            ? "captured-pin"
            : context.modelId === "captured-pin"
              ? "replayed-pin"
              : undefined;
        });
      onTestFinished(() => normalize.mockRestore());
      const sessionKey = "agent:main:command:stored-selection";
      const sessionEntry: SessionEntry = {
        sessionId: "stored-selection",
        updatedAt: 1,
        providerOverride: "fixture",
        modelOverride: storedModel,
        ...(provenance === "resolved"
          ? { modelOverrideRouteResolution: "resolved" }
          : provenance === "legacy"
            ? {
                modelOverrideSource: "auto",
                modelOverrideFallbackOriginProvider: "fixture",
                modelOverrideFallbackOriginModel: "default",
              }
            : {}),
      };
      const selection = await resolveEmbeddedModelSelection({
        cfg,
        opts: { message: "keep the stored model" },
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        sessionKey,
        sessionId: sessionEntry.sessionId,
        storePath: path.join(suiteTempRoot, "stored-selection.sqlite"),
        sessionAgentId: "main",
        workspaceDir: suiteTempRoot,
        pluginsEnabled: true,
        modelManifestContext: { config: cfg, manifestPlugins: [] },
        configuredThinkingCatalog: [],
        requestedThinkLevel: "off",
        isSubagentLane: false,
        suppressVisibleSessionEffects: false,
        runContext: {},
      });

      expect(selection).toMatchObject({ provider: "fixture", model: expectedModel });
      const normalizedInputs = normalize.mock.calls.map(([{ context }]) => context.modelId);
      expect(normalizedInputs).not.toContain("captured-pin");
      expect(normalizedInputs.filter((modelId) => modelId === "legacy-pin")).toHaveLength(
        rawHookCalls,
      );
    },
  );

  it.each([
    { name: "changed workspace alias", authored: "legacy", selected: "other", rejected: true },
    { name: "matching workspace alias", authored: "legacy", selected: "current", rejected: false },
    {
      name: "nested provider prefix",
      authored: "fixture/fixture/current",
      selected: "fixture/current",
      rejected: false,
    },
  ])("keeps the authorized initial model for $name", async (scenario) => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "fixture/default" } } },
      ...(scenario.name === "nested provider prefix"
        ? {
            models: {
              providers: {
                fixture: {
                  baseUrl: "https://fixture.example/v1",
                  api: "openai-completions" as const,
                  models: [
                    {
                      id: "fixture/current",
                      name: "Literal provider-prefixed model",
                      reasoning: false,
                      input: ["text" as const],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 4096,
                      maxTokens: 1024,
                    },
                  ],
                },
              },
            },
          }
        : {}),
    };
    const snapshot = (selected: string) =>
      createPluginMetadataSnapshot({
        config: cfg,
        workspaceDir: suiteTempRoot,
        manifestRegistry: {
          diagnostics: [],
          plugins: [
            {
              id: "fixture-model-policy",
              origin: "workspace",
              rootDir: suiteTempRoot,
              source: path.join(suiteTempRoot, "index.js"),
              manifestPath: path.join(suiteTempRoot, "openclaw.plugin.json"),
              channels: [],
              providers: ["fixture"],
              cliBackends: [],
              skills: [],
              hooks: [],
              modelIdNormalization: { providers: { fixture: { aliases: { legacy: selected } } } },
            },
          ],
        },
      });
    const authorizedMetadata = snapshot("current");
    const expectedInitialModel = normalizeModelRef("fixture", scenario.authored, {
      manifestPlugins: authorizedMetadata.plugins,
      allowPluginNormalization: false,
    });
    const selectedMetadata = snapshot(scenario.selected);
    const selectionParams = {
      cfg,
      opts: {
        message: "keep the authorized target",
        provider: "fixture",
        model: scenario.authored,
        allowModelOverride: true,
      },
      expectedInitialModel,
      requestedThinkLevel: "off" as const,
      sessionId: "initial-model-constraint",
      storePath: path.join(suiteTempRoot, "initial-model.sqlite"),
      sessionAgentId: "main",
      workspaceDir: suiteTempRoot,
      pluginsEnabled: true,
      manifestMetadataSnapshot: selectedMetadata,
      modelManifestContext: {
        config: cfg,
        workspaceDir: suiteTempRoot,
        pluginMetadataSnapshot: selectedMetadata,
        manifestPlugins: selectedMetadata.plugins,
      },
      configuredThinkingCatalog: [],
      isSubagentLane: true,
      suppressVisibleSessionEffects: true,
      runContext: {},
    };
    vi.mocked(ensureSelectedAgentHarnessPlugin).mockClear();
    const selection = resolveEmbeddedModelSelection(selectionParams);

    if (scenario.rejected) {
      await expect(selection).rejects.toThrow(/initial model/i);
      expect(ensureSelectedAgentHarnessPlugin).not.toHaveBeenCalled();
    } else {
      await expect(selection).resolves.toMatchObject(expectedInitialModel);
    }
  });
});
