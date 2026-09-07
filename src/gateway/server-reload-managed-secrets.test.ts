import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelProviderRouteOverrideResolver } from "../config/model-provider-config.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
} from "../config/runtime-snapshot.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  activateSecretsRuntimeSnapshot,
  activateSecretsRuntimeSnapshotWithSource,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import type { GatewayConfigReloadTransactionOwnership } from "./config-reload.js";
import type { ManagedGatewayConfigReloaderParams } from "./server-reload-contracts.js";
import { createManagedReloadSecretHandlers } from "./server-reload-managed-secrets.js";
import { createRuntimeSecretsActivator } from "./server-startup-config.js";

vi.mock("../agents/context.js", () => ({ refreshContextWindowCache: vi.fn() }));

afterEach(() => {
  clearSecretsRuntimeSnapshot();
  vi.restoreAllMocks();
});

function configPair(runtime: "openclaw" | "codex") {
  const source = {
    agents: { defaults: { models: { "openai/gpt-5.6-luna": { agentRuntime: { id: runtime } } } } },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          models: [
            {
              id: "gpt-5.6-luna",
              name: "Luna",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  } satisfies OpenClawConfig;
  const config: OpenClawConfig = structuredClone(source);
  // The loader may seed catalog compatibility; this is not authored request policy.
  config.models!.providers!.openai!.models[0]!.compat = { supportsStore: false };
  return { source, config };
}

const prepare = (config: OpenClawConfig) =>
  prepareSecretsRuntimeSnapshot({
    config,
    includeAuthStoreRefs: false,
    env: {},
  });

function expectAuthoredSource(source: OpenClawConfig) {
  const config = getRuntimeConfigSnapshot();
  expect(config).not.toBeNull();
  expect(getRuntimeConfigSourceSnapshot()).toEqual(source);
  expect(
    createModelProviderRouteOverrideResolver({
      provider: "openai",
      authoredConfig: projectConfigOntoRuntimeSourceSnapshot(config!),
    })("gpt-5.6-luna"),
  ).toBe("none");
}

async function createReload(canonicalActivator: boolean, commit: () => Promise<void>) {
  const initial = configPair("openclaw");
  activateSecretsRuntimeSnapshotWithSource(await prepare(initial.config), initial.source);
  expectAuthoredSource(initial.source);
  const activator = createRuntimeSecretsActivator({
    logSecrets: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emitStateEvent: vi.fn(),
    prepareRuntimeSecretsSnapshot: ({ config }) => prepare(config),
    activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshot,
  });
  const activateRuntimeSecrets: ManagedGatewayConfigReloaderParams["activateRuntimeSecrets"] =
    canonicalActivator ? activator : (config, options) => activator(config, options);
  // Only secret publication is exercised here; the service tail is injected at its existing seam.
  const params = {
    activateRuntimeSecrets,
    resolveSharedGatewaySessionGenerationForConfig: () => undefined,
    sharedGatewaySessionGenerationState: { current: undefined, required: null },
    clients: [],
    commitRuntimePolicy: vi.fn(),
    reconcileRuntimePolicy: vi.fn(),
  };
  const { onHotReload } = createManagedReloadSecretHandlers({
    params,
    prepareRuntimeCandidate: (config) => config,
    tryPrepareRuntimeSecrets: async (config) => ({
      snapshot: await prepare(config),
      expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
    }),
    applyHotReload: async (_plan, _config, publication) => {
      let committed = false;
      await publication!.publish(
        async () => {
          await commit();
          committed = true;
        },
        () => committed,
      );
      return "applied";
    },
  });
  const ownership: GatewayConfigReloadTransactionOwnership = {
    isCurrent: () => true,
    markRuntimeCommitted: vi.fn(),
    commitRuntimeEnv: vi.fn(),
    publishRuntimeEnv: vi.fn(),
    rollbackRuntimeEnv: vi.fn(),
    reapplyRuntimeOverlays: (config) => config,
  };
  const next = configPair("codex");
  const plan = buildGatewayReloadPlan(
    ["agents.defaults.models.openai/gpt-5.6-luna.agentRuntime.id"],
    { candidateConfig: next.config },
  );
  return { initial, next, run: () => onHotReload(plan, next.config, ownership, next.source) };
}

describe.each([true, false])(
  "managed reload authored source (canonical activator: %s)",
  (canonical) => {
    it("preserves generated model metadata across a successful hot reload", async () => {
      const { next, run } = await createReload(canonical, async () => {});
      await expect(run()).resolves.toBe("applied");
      expect(
        getRuntimeConfigSnapshot()?.agents?.defaults?.models?.["openai/gpt-5.6-luna"]?.agentRuntime
          ?.id,
      ).toBe("codex");
      expectAuthoredSource(next.source);
    });

    it("restores the predecessor's authored source when runtime commit fails", async () => {
      const { initial, run } = await createReload(canonical, async () => {
        throw new Error("commit failed");
      });
      await expect(run()).rejects.toThrow("commit failed");
      expectAuthoredSource(initial.source);
    });

    it("does not roll back a newer publication's authored source", async () => {
      const newer = configPair("codex");
      newer.source.models.providers.openai.models[0]!.name = "Newer model";
      newer.config.models!.providers!.openai!.models[0]!.name = "Newer model";
      const { run } = await createReload(canonical, async () => {
        activateSecretsRuntimeSnapshotWithSource(await prepare(newer.config), newer.source);
        throw new Error("superseded commit failed");
      });
      await expect(run()).rejects.toThrow("superseded commit failed");
      expectAuthoredSource(newer.source);
    });
  },
);
