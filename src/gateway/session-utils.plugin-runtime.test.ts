/**
 * Tests session utility interactions with plugin runtime state.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../config/sessions.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";

const normalizeProviderModelIdWithPluginMock = vi.fn();
const loadPluginManifestRegistryCoreMock = vi.hoisted(() =>
  vi.fn(() => ({ plugins: [], diagnostics: [] })),
);

vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: unknown) =>
    normalizeProviderModelIdWithPluginMock(params),
}));

vi.mock("../plugins/manifest-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/manifest-registry.js")>()),
  loadPluginManifestRegistryCore: loadPluginManifestRegistryCoreMock,
}));

let sessionUtils: typeof import("./session-utils.js");
let buildSessionListRowMetadataContext: typeof import("./session-utils-projection.js").buildSessionListRowMetadataContext;

function withPreparedPluginMetadata<T>(config: OpenClawConfig, run: () => T): T {
  // Retained empty facts must win over an ambient collection owner without rediscovery.
  return withPluginMetadataSnapshotScope(
    createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    }),
    run,
    { config, trustConfigIdentity: true },
  );
}

describe("gateway session list plugin runtime normalization", () => {
  beforeAll(async () => {
    vi.resetModules();
    sessionUtils = await import("./session-utils.js");
    ({ buildSessionListRowMetadataContext } = await import("./session-utils-projection.js"));
  });

  beforeEach(() => {
    normalizeProviderModelIdWithPluginMock.mockReset();
    loadPluginManifestRegistryCoreMock.mockClear();
  });

  it.each([
    { scope: "configured", agentId: undefined, model: "configured-model" },
    { scope: "agent", agentId: "work", model: "agent-model" },
  ])("projects $scope session defaults without runtime normalization", ({ agentId, model }) => {
    normalizeProviderModelIdWithPluginMock.mockReturnValue("runtime-only-model");
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: {
          model: { primary: "configured-alias" },
          models: {
            "custom-provider/configured-model": { alias: "configured-alias" },
            "custom-provider/agent-model": { alias: "agent-alias" },
          },
        },
        entries: {
          main: {},
          work: { model: { primary: "agent-alias" } },
        },
      },
    };

    const defaults = withPreparedPluginMetadata(cfg, () =>
      sessionUtils.getSessionDefaults(cfg, undefined, agentId ? { agentId } : undefined),
    );

    expect(defaults).toMatchObject({ modelProvider: "custom-provider", model });
    expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
  });

  it("skips provider runtime normalization for async list rows", async () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "custom-provider/custom-legacy-model" } },
      },
    } as OpenClawConfig;
    const store = Object.fromEntries(
      Array.from({ length: 3 }, (_value, index) => [
        `session-${index}`,
        { sessionId: `session-${index}`, updatedAt: 1_000 - index } satisfies SessionEntry,
      ]),
    );

    const listed = await withPreparedPluginMetadata(cfg, () =>
      sessionUtils.listSessionsFromStoreAsync({
        cfg,
        storePath: "",
        store,
        opts: {},
      }),
    );

    expect(listed.sessions.map((session) => session.model)).toEqual([
      "custom-legacy-model",
      "custom-legacy-model",
      "custom-legacy-model",
    ]);
    expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
  });

  it("keeps literal configured ids separate in the async row cache", async () => {
    const models = ["custom-provider/shared", "shared"];
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "custom-provider/shared" } },
      models: {
        providers: {
          "custom-provider": {
            baseUrl: "https://custom-provider.test/v1",
            models: models.map((id) => ({
              id,
              name: id,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 4096,
              maxTokens: 1024,
            })),
          },
        },
      },
    };
    const store = Object.fromEntries(
      models.map((modelOverride, index) => [
        `agent:main:literal-${index}`,
        {
          sessionId: `literal-${index}`,
          updatedAt: 2 - index,
          providerOverride: "custom-provider",
          modelOverride,
        } satisfies SessionEntry,
      ]),
    );

    const listed = await withPreparedPluginMetadata(cfg, () =>
      sessionUtils.listSessionsFromStoreAsync({ cfg, storePath: "", store, opts: {} }),
    );

    expect(listed.sessions.map((session) => session.model)).toEqual(models);
    expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
  });

  it("keeps raw, resolved, and lightweight selections separate in a shared row cache", () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(
      ({ provider, context }: { provider?: string; context?: { modelId?: string } }) =>
        provider === "custom-provider" && context?.modelId === "legacy"
          ? "runtime-model"
          : undefined,
    );
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "custom-provider/default-model" } },
    };
    const raw: SessionEntry = {
      sessionId: "raw",
      updatedAt: 3,
      providerOverride: "custom-provider",
      modelOverride: "legacy",
    };
    const resolved: SessionEntry = {
      ...raw,
      sessionId: "resolved",
      modelOverrideRouteResolution: "resolved",
    };
    const legacyResolved: SessionEntry = {
      ...raw,
      sessionId: "legacy-resolved",
      modelOverrideFallbackOriginProvider: "origin-provider",
      modelOverrideFallbackOriginModel: "origin-model",
    };
    const store = { raw, resolved, legacyResolved };
    const rowContext = buildSessionListRowMetadataContext({ now: 10 });
    for (const entry of Object.values(store)) {
      rowContext.acpSessionMetaByEntry.set(entry, undefined);
    }

    const models = withPreparedPluginMetadata(cfg, () =>
      [
        { entry: raw, lightweightListRow: false },
        { entry: resolved, lightweightListRow: false },
        { entry: legacyResolved, lightweightListRow: false },
        { entry: raw, lightweightListRow: true },
        { entry: raw, lightweightListRow: false },
      ].map(
        ({ entry, lightweightListRow }) =>
          sessionUtils.buildGatewaySessionRow({
            cfg,
            storePath: "",
            store,
            key: `agent:main:${entry.sessionId}`,
            entry,
            rowContext,
            lightweightListRow,
            skipTranscriptUsageFallback: true,
          }).model,
      ),
    );

    expect(models).toEqual(["runtime-model", "legacy", "legacy", "legacy", "runtime-model"]);
  });

  it("keeps provider runtime normalization for detail rows", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(
      ({ provider, context }: { provider?: string; context?: { modelId?: string } }) => {
        if (provider === "custom-provider" && context?.modelId === "custom-legacy-model") {
          return "custom-modern-model";
        }
        return undefined;
      },
    );

    const cfg = {
      agents: {
        defaults: { model: { primary: "custom-provider/custom-legacy-model" } },
      },
    } as OpenClawConfig;

    const row = withPreparedPluginMetadata(cfg, () =>
      sessionUtils.buildGatewaySessionRow({
        cfg,
        storePath: "",
        store: {},
        key: "main",
      }),
    );

    expect(row.model).toBe("custom-modern-model");
    expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalled();
  });

  it("keeps lifecycle event rows lightweight without changing explicit detail rows", async () => {
    await withStateDirEnv("openclaw-lifecycle-row-plugin-runtime-", async () => {
      normalizeProviderModelIdWithPluginMock.mockImplementation(
        ({ provider, context }: { provider?: string; context?: { modelId?: string } }) =>
          provider === "custom-provider" && context?.modelId === "custom-legacy-model"
            ? "custom-modern-model"
            : undefined,
      );
      const cfg = {
        agents: {
          defaults: { model: { primary: "custom-provider/custom-legacy-model" } },
        },
      } as OpenClawConfig;
      const configRuntime = await import("../config/config.js");
      await withPreparedPluginMetadata(cfg, async () => {
        configRuntime.resetConfigRuntimeState();
        try {
          configRuntime.setRuntimeConfigSnapshot(cfg, cfg);
          const sessionKey = "agent:main:lifecycle-plugin-runtime";
          const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
          await replaceSessionEntry({ sessionKey, storePath }, {
            sessionId: "lifecycle-plugin-runtime",
            updatedAt: 1,
          } satisfies SessionEntry);

          const lifecycle = sessionUtils.loadGatewaySessionLifecycleSnapshot(sessionKey);

          expect(lifecycle.row?.model).toBe("custom-legacy-model");
          expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
          expect(loadPluginManifestRegistryCoreMock).not.toHaveBeenCalled();

          expect(sessionUtils.loadGatewaySessionRow(sessionKey)?.model).toBe("custom-modern-model");
          expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalled();
        } finally {
          configRuntime.resetConfigRuntimeState();
        }
      });
    });
  });
});
