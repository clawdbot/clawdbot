/**
 * Tests session utility interactions with plugin runtime state.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../config/sessions.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";

const normalizeProviderModelIdWithPluginMock = vi.fn();
const loadPluginManifestRegistryCoreMock = vi.hoisted(() =>
  vi.fn(() => ({ plugins: [], diagnostics: [] })),
);
const getCurrentPluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: unknown) =>
    normalizeProviderModelIdWithPluginMock(params),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: getCurrentPluginMetadataSnapshotMock,
}));

vi.mock("../plugins/manifest-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/manifest-registry.js")>()),
  loadPluginManifestRegistryCore: loadPluginManifestRegistryCoreMock,
}));

let sessionUtils: typeof import("./session-utils.js");

describe("gateway session list plugin runtime normalization", () => {
  beforeAll(async () => {
    vi.resetModules();
    const { createPluginMetadataSnapshotFixture } =
      await import("../plugins/plugin-metadata.test-support.js");
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(createPluginMetadataSnapshotFixture());
    sessionUtils = await import("./session-utils.js");
  });

  beforeEach(() => {
    normalizeProviderModelIdWithPluginMock.mockReset();
    loadPluginManifestRegistryCoreMock.mockClear();
  });

  it("skips provider runtime normalization for lightweight list rows", async () => {
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

    const listed = await sessionUtils.listSessionsFromStoreAsync({
      cfg,
      targetsBySessionKey: new Map(
        Object.keys(store).map((key) => [
          key,
          { agentId: "main", storeTarget: { agentId: "main", storePath: "" } },
        ]),
      ),
      storePath: "",
      store,
      opts: {},
    });

    expect(listed.sessions.map((session) => session.model)).toEqual([
      "custom-legacy-model",
      "custom-legacy-model",
      "custom-legacy-model",
    ]);
    expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
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

    const row = sessionUtils.buildGatewaySessionRow({
      cfg,
      agentId: "main",
      storePath: "",
      store: {},
      key: "main",
    });

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
      configRuntime.resetConfigRuntimeState();
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
      configRuntime.resetConfigRuntimeState();
    });
  });
});
