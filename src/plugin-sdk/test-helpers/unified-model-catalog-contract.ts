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
