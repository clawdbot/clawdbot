/**
 * Assertions for unified model catalog provider contract tests.
 */
import { expect } from "vitest";
import type {
  OpenClawPluginApi,
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogKind,
  UnifiedModelCatalogProviderPlugin,
} from "../plugin-entry.js";
import { createCapturedPluginRegistration } from "../plugin-test-runtime.js";

type RegistrablePlugin = {
  register(api: OpenClawPluginApi): void;
};

/** Verifies catalog rows are normalized and owned by the expected provider/kind. */
export function expectUnifiedModelCatalogEntries(
  rows: readonly UnifiedModelCatalogEntry[] | null | undefined,
  params: {
    provider: string;
    kind: UnifiedModelCatalogKind;
  },
): asserts rows is readonly UnifiedModelCatalogEntry[] {
  expect(rows).toBeTruthy();
  for (const row of rows ?? []) {
    expect(row).toEqual(
      expect.objectContaining({
        provider: params.provider,
        kind: params.kind,
      }),
    );
    expect(row.model.trim()).toBe(row.model);
    expect(row.model).not.toBe("");
    expect(row.source).not.toBe("");
  }
}

/** Registers a plugin and returns the matching unified model catalog provider. */
export function expectUnifiedModelCatalogProviderRegistration(params: {
  plugin: RegistrablePlugin;
  pluginId?: string;
  pluginName?: string;
  provider: string;
  kind: UnifiedModelCatalogKind;
}): UnifiedModelCatalogProviderPlugin {
  const captured = createCapturedPluginRegistration({
    id: params.pluginId ?? params.provider,
    name: params.pluginName ?? params.provider,
    source: "test",
  });
  params.plugin.register(captured.api);
  const registration = captured.modelCatalogProviders.find(
    (provider) => provider.provider === params.provider && provider.kinds.includes(params.kind),
  );
  expect(registration).toBeTruthy();
  return registration!;
}
