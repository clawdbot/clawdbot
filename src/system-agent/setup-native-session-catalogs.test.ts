import { describe, expect, it } from "vitest";
import { applyWizardMetadata } from "../commands/onboard-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { initializeNativeSessionCatalogPreferences } from "../plugins/native-session-catalog-config.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  applySetupNativeSessionCatalogPreference,
  listSetupNativeSessionCatalogs,
  requiresSetupNativeSessionCatalogConsent,
  resolveSetupNativeSessionCatalogPreference,
} from "./setup-native-session-catalogs.js";

const metadataSnapshot = createPluginMetadataSnapshotFixture();
const catalogs = listSetupNativeSessionCatalogs({ config: {}, metadataSnapshot });

describe("native conversation setup preferences", () => {
  it("offers and persists consent for an installed catalog outside the generated defaults", () => {
    const config = initializeNativeSessionCatalogPreferences({});
    const installed = createPluginMetadataSnapshotFixture({
      plugins: [{ id: "fixture", setup: { nativeSessionCatalog: { label: "Fixture" } } }],
    });
    const options = listSetupNativeSessionCatalogs({ config, metadataSnapshot: installed });
    expect(
      requiresSetupNativeSessionCatalogConsent({ config, configExists: true, catalogs: options }),
    ).toBe(true);
    for (const enabled of [false, true]) {
      const selected = applySetupNativeSessionCatalogPreference({
        config,
        metadataSnapshot: installed,
        enabled,
      });
      expect(selected.plugins?.entries?.fixture?.config).toEqual({ sessionCatalog: { enabled } });
    }
  });
  it.each(["doctor", "onboard"])(
    "keeps discovery opt-in available after %s writes machine setup metadata",
    (command) => {
      const config = initializeNativeSessionCatalogPreferences(
        applyWizardMetadata({}, { command, mode: "local" }),
      );
      expect(config.wizard?.lastRunAt).toBeTruthy();
      expect(config.wizard?.lastRunCommand).toBe(command);
      const required = requiresSetupNativeSessionCatalogConsent({
        config,
        configExists: true,
        catalogs,
      });
      expect(required).toBe(true);
      expect(resolveSetupNativeSessionCatalogPreference({ consentRequired: required })).toBe(false);
      expect(
        applySetupNativeSessionCatalogPreference({ config, enabled: false, metadataSnapshot }),
      ).toBe(config);
    },
  );

  it("preserves an authored malformed value for the plugin validator", () => {
    const config = initializeNativeSessionCatalogPreferences({
      plugins: { entries: { codex: { config: { sessionCatalog: { enabled: "invalid" } } } } },
    });
    expect(config.plugins?.entries?.codex?.config).toEqual({
      sessionCatalog: { enabled: "invalid" },
    });
  });

  it("offers an unchecked choice after fresh configuration creation, even with an explicit agent", () => {
    const config = initializeNativeSessionCatalogPreferences({
      agents: { entries: { research: {} } },
    });
    const required = requiresSetupNativeSessionCatalogConsent({
      config,
      configExists: true,
      catalogs,
    });
    expect(required).toBe(true);
    expect(resolveSetupNativeSessionCatalogPreference({ consentRequired: required })).toBe(false);
    expect(
      resolveSetupNativeSessionCatalogPreference({ consentRequired: required, requested: true }),
    ).toBe(true);
  });

  it("preserves missing and mixed legacy preferences without inferring consent from a new agent", () => {
    const configs: OpenClawConfig[] = [
      { agents: { entries: { research: {} } } },
      { plugins: { entries: { anthropic: { config: { sessionCatalog: { enabled: false } } } } } },
      {
        plugins: {
          entries: {
            anthropic: { config: { sessionCatalog: { enabled: false } } },
            codex: { config: { sessionCatalog: { enabled: true } } },
          },
        },
      },
    ];
    for (const config of configs) {
      const required = requiresSetupNativeSessionCatalogConsent({
        config,
        configExists: true,
        catalogs,
      });
      expect(required).toBe(false);
      expect(
        resolveSetupNativeSessionCatalogPreference({ consentRequired: required, requested: false }),
      ).toBeUndefined();
    }
  });

  it("includes an absent official plugin before install and retains its unchecked preference", () => {
    expect(catalogs.map(({ pluginId }) => pluginId)).toContain("codex");
    const config = applySetupNativeSessionCatalogPreference({
      config: {},
      enabled: false,
      metadataSnapshot,
    });
    expect(config.plugins?.entries?.codex).toEqual({
      config: { sessionCatalog: { enabled: false } },
    });
    expect(config.plugins?.entries?.anthropic).toEqual({
      config: { sessionCatalog: { enabled: false } },
    });
    expect(
      applySetupNativeSessionCatalogPreference({ config, enabled: false, metadataSnapshot }),
    ).toBe(config);
  });
});
