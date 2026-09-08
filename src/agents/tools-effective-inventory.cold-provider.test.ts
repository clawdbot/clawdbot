import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { applySessionEntryLifecycleMutation } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createToolsEffectiveHandlers,
  testing,
} from "../gateway/server-methods/tools-effective.js";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { planEffectiveModelCatalogRows } from "../model-catalog/index.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resolveProviderRuntimePlugin } from "../plugins/provider-hook-runtime.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveModelAsync } from "./embedded-agent-runner/model.js";
import { acquireReadOnlyPreparedModelRuntime } from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import { resolveEffectiveToolInventoryRuntimeModelContextAsync } from "./tools-effective-inventory.js";
import type { EffectiveToolInventoryResult } from "./tools-effective-inventory.types.js";
import type { AnyAgentTool } from "./tools/common.js";

// Shell, channel, media, and MCP factories are unrelated to model metadata. Keep
// the real provider normalizer, schema quarantine, notices, and grouping below.
vi.mock("./agent-tools.js", () => {
  const execute = async () => {
    throw new Error("Inventory must not execute tools");
  };
  return {
    createOpenClawCodingTools: () =>
      [
        {
          name: "healthy_tool",
          label: "Healthy tool",
          description: "A tool with a complete input schema.",
          parameters: { type: "object", properties: {} },
          execute,
        },
        {
          name: "parameterless_tool",
          label: "Parameterless tool",
          description: "A parameterless tool normalized by the selected provider.",
          parameters: undefined,
          execute,
        },
      ] as unknown as AnyAgentTool[],
  };
});

const provider = "cold-inventory-provider";
const pluginId = "cold-inventory-plugin";
const pinnedId = "chat-2026-08-17-pinned";
const curatedId = "chat-latest";
const throwingId = "chat-throws";

function ownerCount() {
  // Reuse the existing owner API without importing the harness that mocks preparation.
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.preparedModelRuntimeTestApi")
  ] as { getPreparedModelRuntimeOwnerCountForTest(): number };
  return api.getPreparedModelRuntimeOwnerCountForTest();
}

async function withColdFixture(run: (fixture: ReturnType<typeof createFixture>) => Promise<void>) {
  await withOpenClawTestState(
    { prefix: "openclaw-cold-inventory-", layout: "split" },
    async (state) => {
      const fixture = createFixture(state);
      await withEnvAsync(
        {
          OPENCLAW_BUNDLED_PLUGINS_DIR: fixture.emptyBundledRoot,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
        async () => {
          await resetPreparedModelRuntimeSnapshotsForTest();
          clearPluginMetadataLifecycleCaches();
          testing.resetToolsEffectiveCacheForTest();
          try {
            expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
            expect(ownerCount()).toBe(0);
            expect(isColdPluginRuntimeLoaded(fixture.selected)).toBe(false);
            await run(fixture);
            expect(isColdPluginRuntimeLoaded(fixture.unrelated)).toBe(false);
            expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
            expect(ownerCount()).toBe(0);
          } finally {
            testing.resetToolsEffectiveCacheForTest();
            await resetPreparedModelRuntimeSnapshotsForTest();
            clearPluginMetadataLifecycleCaches();
            resetPluginLoaderTestStateForTest();
            cleanupPluginLoaderFixturesForTest();
          }
        },
      );
    },
  );
}

function createFixture(state: OpenClawTestState) {
  const root = state.root;
  const selectedRoot = path.join(root, "selected");
  const unrelatedRoot = path.join(root, "unrelated");
  const emptyBundledRoot = path.join(root, "empty-bundled");
  const agentDir = state.agentDir();
  const workspaceDir = state.workspaceDir;
  for (const dir of [selectedRoot, unrelatedRoot, emptyBundledRoot, agentDir, workspaceDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const selected = createColdPluginFixture({
    rootDir: selectedRoot,
    pluginId,
    providerId: provider,
    manifest: {
      channels: [],
      channelConfigs: {},
      providerAuthChoices: [],
      modelCatalog: {
        providers: {
          [provider]: {
            discovery: "static",
            api: "openai-completions",
            baseUrl: "https://inventory.invalid/v1",
            models: [{ id: curatedId, name: "Curated chat", input: ["text"] }],
          },
        },
      },
    },
  });
  const unrelated = createColdPluginFixture({
    rootDir: unrelatedRoot,
    pluginId: "unrelated-inventory-plugin",
    providerId: "unrelated-inventory-provider",
    runtimeMessage: "Unrelated provider must stay cold",
  });
  fs.writeFileSync(
    selected.runtimeSource,
    `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(selected.runtimeMarker)}, "loaded", "utf8");
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(provider)}, label: "Cold inventory provider", auth: [],
      async prepareDynamicModel(ctx) {
        if (ctx.modelId === ${JSON.stringify(throwingId)}) throw new Error("Provider preparation failed");
        if (ctx.modelId !== ${JSON.stringify(pinnedId)}) return;
        return {
          id: ctx.modelId, name: "Pinned chat", provider: ctx.provider,
          api: "openai-completions", baseUrl: "https://inventory.invalid/v1",
          reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
      },
      normalizeToolSchemas(ctx) {
        if (ctx.model?.api !== "openai-completions") return ctx.tools;
        return ctx.tools.map(tool => tool.parameters === undefined
          ? { ...tool, parameters: { type: "object", properties: {}, additionalProperties: false } }
          : tool);
      },
    });
  },
};
`,
    "utf8",
  );
  const config: OpenClawConfig = {
    agents: {
      defaults: { model: { primary: `${provider}/${pinnedId}` }, workspace: workspaceDir },
    },
    plugins: {
      load: { paths: [selectedRoot, unrelatedRoot] },
      slots: { memory: "none" },
      entries: { [pluginId]: { enabled: true }, "unrelated-inventory-plugin": { enabled: true } },
    },
  };
  const input = { agentId: "main", agentDir, workspaceDir, config, readOnly: true };
  const inventoryParams = {
    cfg: config,
    agentId: "main",
    agentDir,
    workspaceDir,
    modelProvider: provider,
    modelId: pinnedId,
  };
  return { state, selected, unrelated, emptyBundledRoot, config, input, inventoryParams };
}

function pickerIds(fixture: ReturnType<typeof createFixture>) {
  const snapshot = resolvePluginMetadataSnapshot({
    config: fixture.config,
    workspaceDir: fixture.input.workspaceDir,
  });
  return planEffectiveModelCatalogRows({
    registry: snapshot.manifestRegistry,
    config: fixture.config,
    providerFilter: provider,
  }).entries.flatMap((entry) => entry.rows.map((row) => row.id));
}

describe("cold dynamic-model effective inventory", () => {
  it("includes provider-supported tools through the default Gateway inventory path", async () => {
    await withColdFixture(async (fixture) => {
      expect(pickerIds(fixture)).toEqual([curatedId]);
      expect(isColdPluginRuntimeLoaded(fixture.selected)).toBe(false);
      setRuntimeConfigSnapshot(fixture.config);
      const sessionKey = "agent:main:cold-inventory";
      await applySessionEntryLifecycleMutation({
        agentId: "main",
        storePath: path.join(fixture.state.sessionsDir(), "sessions.json"),
        upserts: [
          {
            sessionKey,
            entry: {
              sessionId: "cold-inventory-session",
              updatedAt: 1,
              providerOverride: provider,
              modelOverride: pinnedId,
              modelOverrideSource: "user",
            },
          },
        ],
        skipMaintenance: true,
      });
      const respond = vi.fn<RespondFn>();
      const handler = expectDefined(
        createToolsEffectiveHandlers()["tools.effective"],
        "default tools.effective handler",
      );
      await handler({
        params: { sessionKey },
        respond,
        context: { getRuntimeConfig: () => fixture.config } as GatewayRequestContext,
        client: null,
        req: { type: "req", id: "cold-inventory", method: "tools.effective" },
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, expect.any(Object), undefined);
      const inventory = respond.mock.calls[0]?.[1] as EffectiveToolInventoryResult;
      expect({
        tools: inventory.groups.flatMap((group) => group.tools.map((tool) => tool.id)),
        notices: inventory.notices,
      }).toEqual({
        tools: ["healthy_tool", "parameterless_tool"],
        notices: undefined,
      });
      expect(isColdPluginRuntimeLoaded(fixture.selected)).toBe(true);
      expect(fixture.config.agents?.defaults?.model).toEqual({
        primary: `${provider}/${pinnedId}`,
      });
      expect(pickerIds(fixture)).toEqual([curatedId]);
    });
  });

  it("keeps a catalog-only generation isolated after selected runtime preparation", async () => {
    await withColdFixture(async (fixture) => {
      const catalogLease = await acquireReadOnlyPreparedModelRuntime(fixture.input);
      try {
        const lease = await acquireReadOnlyPreparedModelRuntime({
          ...fixture.input,
          loadRuntimePlugins: true,
          runtimePluginSelections: [{ provider, modelId: pinnedId, agentId: "main" }],
        });
        try {
          expect(ownerCount()).toBe(2);
          const resolve = (snapshot: typeof lease.snapshot) =>
            resolveModelAsync(provider, pinnedId, fixture.input.agentDir, fixture.config, {
              ...snapshot.createStores(),
              agentId: "main",
              workspaceDir: fixture.input.workspaceDir,
              preparedModelRuntime: snapshot,
            });
          const resolved = await resolve(lease.snapshot);
          expect(resolved.model).toMatchObject({
            id: pinnedId,
            provider,
            api: "openai-completions",
          });
          expect(resolved.error).toBeUndefined();
          // Loading B must not lend hooks to A: a generation miss remains authoritative.
          const catalogResolved = await resolve(catalogLease.snapshot);
          expect(catalogResolved.model).toBeUndefined();
          expect(catalogResolved.error).toContain(`Unknown model: ${provider}/${pinnedId}`);
          expect(isColdPluginRuntimeLoaded(fixture.selected)).toBe(true);
          expect(pickerIds(fixture)).toEqual([curatedId]);
        } finally {
          lease.release();
        }
        expect(ownerCount()).toBe(1);
      } finally {
        catalogLease.release();
      }
    });
  });

  it.each([
    { policy: "global disable", plugins: { enabled: false } },
    { policy: "entry disable", plugins: { entries: { [pluginId]: { enabled: false } } } },
    { policy: "deny", plugins: { deny: [pluginId] } },
    { policy: "restrictive allow omission", plugins: { allow: ["unrelated-inventory-plugin"] } },
  ])("honors $policy despite an ambient competing provider", async ({ plugins }) => {
    await withColdFixture(async (fixture) => {
      const config: OpenClawConfig = {
        ...fixture.config,
        plugins: { ...fixture.config.plugins, ...plugins },
      };
      const ambientHook = vi.fn(() => {
        throw new Error("Ambient provider must not resolve the model");
      });
      const registry = createEmptyPluginRegistry();
      registry.providers.push({
        pluginId: "ambient-provider",
        source: "test",
        provider: {
          id: provider,
          label: "Ambient provider",
          auth: [],
          prepareDynamicModel: ambientHook,
          resolveDynamicModel: ambientHook,
        },
      });
      await withPluginRuntimeRegistryScope(registry, async () => {
        expect(resolveProviderRuntimePlugin({ provider, config })).toBeUndefined();
        await expect(
          resolveEffectiveToolInventoryRuntimeModelContextAsync({
            ...fixture.inventoryParams,
            cfg: config,
          }),
        ).resolves.toEqual({});
      });
      expect(ambientHook).not.toHaveBeenCalled();
      expect(isColdPluginRuntimeLoaded(fixture.selected)).toBe(false);
    });
  });

  it.each([
    { modelId: "chat-unknown", throws: false },
    { modelId: throwingId, throws: true },
  ])("releases the selected owner when resolving $modelId", async ({ modelId, throws }) => {
    await withColdFixture(async (fixture) => {
      const resolution = resolveEffectiveToolInventoryRuntimeModelContextAsync({
        ...fixture.inventoryParams,
        modelId,
      });
      if (throws) {
        await expect(resolution).rejects.toThrow("Provider preparation failed");
      } else {
        await expect(resolution).resolves.toEqual({});
      }
      expect(isColdPluginRuntimeLoaded(fixture.selected)).toBe(true);
    });
  });
});
