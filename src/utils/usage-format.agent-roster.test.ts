import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { normalizeStaticProviderModelId } from "../agents/model-ref-shared.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveEstimatedSessionCostUsd } from "../gateway/session-utils-core.js";
import { buildSessionListRowMetadataContext } from "../gateway/session-utils-projection.js";
import { installPluginMetadataOwner } from "../plugins/current-plugin-metadata.test-support.js";
import { createPluginCache } from "../plugins/plugin-cache.js";
import {
  createPluginMetadataOwner,
  getPluginMetadataWorkspaceSnapshot,
  type PreparedPluginMetadata,
} from "../plugins/plugin-metadata-collection.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { projectPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  resetUsageFormatCachesForTest,
  resolveModelCostConfig,
  resolveModelCostConfigFingerprint,
} from "./usage-format.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withPreparedPricingMetadata(
  source: "configured" | "agent-local",
  run: (params: {
    config: OpenClawConfig;
    metadata: PreparedPluginMetadata;
    agentDir: (agentId?: string) => string;
  }) => void,
  provider = "anthropic",
): Promise<void> {
  const bundledRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pricing-bundled-"));
  try {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot } },
      async (state) => {
        const workspaces = { main: state.workspaceDir, work: state.path("work") };
        const fixtures = [];
        for (const [agentId, workspace] of Object.entries(workspaces)) {
          const pluginId = `${agentId}-pricing`;
          const rootDir = path.join(workspace, ".openclaw", "extensions", pluginId);
          await fs.mkdir(rootDir, { recursive: true });
          fixtures.push(
            createColdPluginFixture({
              rootDir,
              pluginId,
              manifest: {
                providers: [provider],
                channels: [],
                channelConfigs: {},
                providerAuthChoices: [],
                modelIdNormalization: {
                  providers: {
                    [provider]: {
                      aliases: {
                        "scope-pricing-legacy": `${agentId}-priced`,
                        [agentId === "main" ? "pricing-first" : "pricing-second"]:
                          `${agentId}-priced`,
                      },
                    },
                  },
                },
              },
            }),
          );
        }
        const pricingModels = (multiplier: number) =>
          ["pricing-first", "pricing-second"].map((id, index) => ({
            id,
            name: id,
            reasoning: false,
            input: ["text" as const],
            maxTokens: 1024,
            cost: {
              input: (index === 0 ? 3 : 7) * multiplier,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          }));
        const config: OpenClawConfig = {
          plugins: {
            allow: fixtures.map(({ pluginId }) => pluginId),
            entries: Object.fromEntries(
              fixtures.map(({ pluginId }) => [pluginId, { enabled: true }]),
            ),
          },
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "main" } },
            entries: Object.fromEntries(
              Object.entries(workspaces).map(([agentId, workspace]) => [
                agentId,
                { workspace, agentDir: state.agentDir(agentId) },
              ]),
            ),
          },
          models: {
            providers: {
              [provider]: {
                baseUrl: "https://pricing.example.invalid",
                models: source === "configured" ? pricingModels(1) : [],
              },
            },
          },
        };
        if (source === "agent-local") {
          for (const agentId of Object.keys(workspaces)) {
            await state.writeJson(`agents/${agentId}/agent/models.json`, {
              providers: { [provider]: { models: pricingModels(agentId === "main" ? 1 : 10) } },
            });
          }
        }
        const pluginCache = createPluginCache();
        const owner = createPluginMetadataOwner(pluginCache);
        const dispose = installPluginMetadataOwner(owner, pluginCache);
        try {
          const metadata = owner.prepare({ config });
          owner.publish(metadata, { config });
          run({ config, metadata, agentDir: state.agentDir });
          expect(fixtures.some(isColdPluginRuntimeLoaded)).toBe(false);
        } finally {
          dispose();
          clearPluginMetadataLifecycleCaches();
        }
      },
    );
  } finally {
    await fs.rm(bundledRoot, { recursive: true, force: true });
  }
}

describe("usage-format agent roster", () => {
  beforeEach(() => {
    resetUsageFormatCachesForTest();
  });

  afterEach(() => {
    resetUsageFormatCachesForTest();
  });

  it("uses the default agent directory from a list-shaped roster", async () => {
    const opsAgentDir = path.join(tempDirs.make("openclaw-usage-list-roster-"), "custom-ops-agent");
    await fs.mkdir(opsAgentDir, { recursive: true });
    await fs.writeFile(
      path.join(opsAgentDir, "models.json"),
      JSON.stringify({
        providers: {
          "demo-list-roster": {
            models: [
              {
                id: "demo-model",
                cost: { input: 42, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
      "utf8",
    );
    const config = {
      agents: {
        list: [{ id: "ops", default: true, agentDir: opsAgentDir }],
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveModelCostConfig({
        provider: "demo-list-roster",
        model: "demo-model",
        config,
      })?.input,
    ).toBe(42);
  });

  it.each([
    { source: "configured", provider: "anthropic" },
    { source: "agent-local", provider: "anthropic" },
    { source: "configured", provider: "fixture-pricing" },
  ] as const)(
    "keeps $source session cost estimates on each prepared $provider workspace",
    async ({ source, provider }) => {
      await withPreparedPricingMetadata(
        source,
        ({ config, metadata, agentDir }) => {
          const rowContext = buildSessionListRowMetadataContext({ now: 1 });
          const estimates = ["main", "work", "main"].map((agentId) =>
            resolveEstimatedSessionCostUsd({
              cfg: config,
              provider,
              model: "scope-pricing-legacy",
              entry: { inputTokens: 1_000_000 },
              rowContext,
              agentId,
            }),
          );
          expect(estimates).toEqual([3, source === "configured" ? 7 : 70, 3]);

          const canonicalEstimates = ["main", "work"].map((agentId) =>
            resolveEstimatedSessionCostUsd({
              cfg: config,
              agentId,
              provider,
              model: `${agentId}-priced`,
              entry: { inputTokens: 1_000_000 },
              rowContext,
            }),
          );
          expect(canonicalEstimates).toEqual([3, source === "configured" ? 7 : 70]);

          const costs = ["main", "work", "main"].map((agentId) => {
            const workspaceDir = metadata.agentWorkspaceDirs.get(agentId);
            const pluginMetadataSnapshot = getPluginMetadataWorkspaceSnapshot(metadata, {
              workspaceDir,
            });
            return resolveModelCostConfig({
              config,
              provider,
              model: "scope-pricing-legacy",
              agentDir: agentDir("main"),
              workspaceDir,
              pluginMetadataSnapshot,
            })?.input;
          });
          expect(costs).toEqual([3, 7, 3]);
        },
        provider,
      );
    },
  );

  it("keeps cost estimates on the exact retained metadata generation", async () => {
    await withPreparedPricingMetadata("configured", ({ config, metadata }) => {
      const full = projectPluginMetadataSnapshot(
        getPluginMetadataWorkspaceSnapshot(metadata, {
          workspaceDir: metadata.agentWorkspaceDirs.get("work"),
        }),
        ["work-pricing"],
      );
      expect(
        normalizeStaticProviderModelId("anthropic", "scope-pricing-legacy", {
          manifestPlugins: full.plugins,
        }),
      ).toBe("work-priced");
      const empty = projectPluginMetadataSnapshot(full, []);
      const read = () =>
        resolveEstimatedSessionCostUsd({
          cfg: config,
          provider: "anthropic",
          model: "scope-pricing-legacy",
          entry: { inputTokens: 1_000_000 },
          agentId: "main",
          pluginMetadataSnapshot: metadata.selectedSnapshot,
        });

      const estimates = [full, empty, full].map((metadataSnapshot) =>
        withPluginRuntimeGenerationScope({ config, metadataSnapshot }, read),
      );

      expect(estimates).toEqual([7, undefined, 7]);
    });
  });

  it("keeps cost estimates current after a metadata restart with the same config", async () => {
    await withPreparedPricingMetadata("configured", ({ config, metadata, agentDir }) => {
      const read = () =>
        resolveEstimatedSessionCostUsd({
          cfg: config,
          agentId: "main",
          provider: "anthropic",
          model: "scope-pricing-legacy",
          entry: { inputTokens: 1_000_000 },
          rowContext: buildSessionListRowMetadataContext({ now: 1 }),
        });
      expect(read()).toBe(3);
      const fingerprint = resolveModelCostConfigFingerprint(config, agentDir("main"), {
        agentId: "main",
      });
      const plugin = expectDefined(
        metadata.selectedSnapshot.byPluginId.get("main-pricing"),
        "main pricing fixture",
      );
      const manifest = JSON.parse(nodeFs.readFileSync(plugin.manifestPath, "utf8"));
      manifest.modelIdNormalization.providers.anthropic.aliases["scope-pricing-legacy"] =
        "pricing-second";
      nodeFs.writeFileSync(plugin.manifestPath, JSON.stringify(manifest));
      clearPluginMetadataLifecycleCaches();
      const replacementCache = createPluginCache();
      const replacementOwner = createPluginMetadataOwner(replacementCache);
      const releaseReplacement = installPluginMetadataOwner(replacementOwner, replacementCache);
      try {
        replacementOwner.publish(replacementOwner.prepare({ config }), { config });
        expect(read()).toBe(7);
        expect(
          resolveModelCostConfigFingerprint(config, agentDir("main"), { agentId: "main" }),
        ).not.toBe(fingerprint);
      } finally {
        releaseReplacement();
      }
    });
  });
});
