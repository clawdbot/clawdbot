import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { projectPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";

describe("fallback candidates across provider generations", () => {
  afterEach(() => resetPluginRuntimeStateForTest());

  it.each(["generation", "request"] as const)(
    "uses the %s registry with identical metadata and config",
    (scope) => {
      const provider = `fallback-${scope}`;
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: `${provider}/primary`, fallbacks: [`${provider}/latest`] },
          },
        },
      };
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [{ id: provider, providers: [provider] }],
      });
      const createGeneration = (model: string) => {
        const pluginRegistry = createEmptyPluginRegistry();
        pluginRegistry.providers.push({
          pluginId: provider,
          source: "/tmp/fallback-generation/index.js",
          provider: {
            id: provider,
            label: "Fallback generation",
            auth: [],
            normalizeModelId: ({ modelId }) => (modelId === "latest" ? model : undefined),
          },
        });
        return { metadataSnapshot, pluginRegistry };
      };
      const a = createGeneration("model-a");
      const b = createGeneration("model-b");
      const empty = { metadataSnapshot, pluginRegistry: createEmptyPluginRegistry() };
      const active = createGeneration("model-active");
      setActivePluginRegistry(active.pluginRegistry, "fallback-generation-fixture");
      const resolve = () => resolveModelCandidateChain({ cfg, provider, model: "primary" });
      const expected = (model: string) => [
        { provider, model: "primary", routeOrigin: "requested", routeResolution: "raw" },
        { provider, model, routeOrigin: "configured-fallback", routeResolution: "resolved" },
      ];
      for (const [generation, model] of [
        [a, "model-a"],
        [b, "model-b"],
        [empty, "latest"],
        [a, "model-a"],
        [a, "model-a"],
      ] as const) {
        const candidates =
          scope === "generation"
            ? withPluginRuntimeGenerationScope(generation, resolve)
            : withPluginMetadataSnapshotScope(metadataSnapshot, () =>
                withPluginRuntimeRegistryScope(generation.pluginRegistry, resolve),
              );
        expect(candidates).toEqual(expected(model));
        for (const candidate of candidates) {
          candidate.model = "caller-mutation";
          candidate.routeOrigin = "configured-primary";
          candidate.routeResolution = "resolved";
        }
      }
      expect(withPluginMetadataSnapshotScope(metadataSnapshot, resolve)).toEqual(
        expected("model-active"),
      );
    },
  );

  it("keeps narrowed manifest policies separate when the runtime registry is shared", () => {
    const provider = "fallback-manifest";
    const metadata = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: provider,
          providers: [provider],
          modelIdNormalization: {
            providers: { [provider]: { aliases: { latest: "model-full" } } },
          },
        },
      ],
    });
    const narrowed = projectPluginMetadataSnapshot(metadata, []);
    const pluginRegistry = createEmptyPluginRegistry();
    const cfg: OpenClawConfig = {};
    for (const [metadataSnapshot, model] of [
      [metadata, "model-full"],
      [narrowed, "latest"],
      [metadata, "model-full"],
    ] as const) {
      expect(
        withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, () =>
          resolveModelCandidateChain({ cfg, provider, model: "latest", fallbacksOverride: [] }),
        ),
      ).toEqual([{ provider, model, routeOrigin: "requested", routeResolution: "raw" }]);
    }
  });
});
