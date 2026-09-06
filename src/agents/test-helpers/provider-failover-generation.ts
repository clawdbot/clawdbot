import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";

/** Runs core classifier fixtures with the provider generation prepared by agent runs. */
export function withPreparedFailoverProviders<T>(providerIds: string[], run: () => T): T {
  const pluginRegistry = createEmptyPluginRegistry();
  for (const id of providerIds) {
    pluginRegistry.providers.push({
      pluginId: id,
      source: "test",
      provider: { id, label: id, auth: [], classifyFailoverReason: () => undefined },
    });
  }
  return withPluginRuntimeGenerationScope(
    {
      metadataSnapshot: createPluginMetadataSnapshot({
        manifestRegistry: makeRegistry(
          providerIds.map((id) => ({ id, channels: [], providers: [id] })),
        ),
      }),
      pluginRegistry,
    },
    run,
  );
}
