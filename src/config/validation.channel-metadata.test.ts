import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";

const mockLoadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn(
    (): PluginManifestRegistry => ({
      diagnostics: [],
      plugins: [],
    }),
  ),
);

function createTelegramSchemaRegistry(): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      createPluginManifestRecord({
        id: "telegram",
        channels: ["telegram"],
        channelCatalogMeta: {
          id: "telegram",
          label: "Telegram",
          blurb: "Telegram channel",
        },
        channelConfigs: {
          telegram: {
            schema: {
              type: "object",
              properties: {
                dmPolicy: {
                  type: "string",
                  enum: ["pairing", "allowlist"],
                  default: "pairing",
                },
              },
              // validateConfigObjectWithPlugins starts from the core validated
              // config, which can already include bundled runtime defaults for
              // the channel. Keep this mock schema focused on the plugin-owned
              // default under test instead of rejecting unrelated core fields.
              additionalProperties: true,
            },
            uiHints: {},
          },
        },
      }),
    ],
  };
}

function createPluginConfigSchemaRegistry(): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      createPluginManifestRecord({
        id: "opik",
        configSchema: {
          type: "object",
          properties: {
            workspace: {
              type: "string",
              default: "default-workspace",
            },
          },
          required: ["workspace"],
          additionalProperties: true,
        },
      }),
    ],
  };
}

function createCompatPluginConfigSchemaRegistry(): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      createPluginManifestRecord({
        id: "opik",
        configSchema: {
          type: "object",
          additionalProperties: true,
        },
      }),
      createPluginManifestRecord({
        id: "brave-search",
        contracts: {
          webSearchProviders: ["brave"],
        },
      }),
    ],
  };
}

function createPluginManifestRecord(
  overrides: Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id">,
): PluginManifestRecord {
  return {
    channels: [],
    cliBackends: [],
    hooks: [],
    manifestPath: `/tmp/${overrides.id}/openclaw.plugin.json`,
    origin: "bundled",
    providers: [],
    rootDir: `/tmp/${overrides.id}`,
    skills: [],
    source: `/tmp/${overrides.id}/index.js`,
    ...overrides,
  };
}

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: () => mockLoadPluginManifestRegistry(),
  resolveManifestContractPluginIds: () => [],
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => mockLoadPluginManifestRegistry(),
}));

vi.mock("../plugins/doctor-contract-registry.js", () => ({
  collectRelevantDoctorPluginIds: () => [],
  listPluginDoctorLegacyConfigRules: () => [],
  applyPluginDoctorCompatibilityMigrations: () => ({ next: null, changes: [] }),
}));

vi.mock("../channels/plugins/legacy-config.js", () => ({
  collectChannelLegacyConfigRules: () => [],
}));

vi.mock("./zod-schema.js", () => ({
  OpenClawSchema: {
    safeParse: (raw: unknown) => ({ success: true, data: raw }),
  },
}));

function setupTelegramSchemaWithDefault() {
  mockLoadPluginManifestRegistry.mockReturnValue(createTelegramSchemaRegistry());
}

function setupPluginSchemaWithRequiredDefault() {
  mockLoadPluginManifestRegistry.mockReturnValue(createPluginConfigSchemaRegistry());
}

beforeEach(() => {
  mockLoadPluginManifestRegistry.mockClear();
});

describe("validateConfigObjectWithPlugins channel metadata (applyDefaults: true)", () => {
  it("applies bundled channel defaults from plugin-owned schema metadata", async () => {
    setupTelegramSchemaWithDefault();

    const result = validateConfigObjectWithPlugins({
      channels: {
        telegram: {},
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.channels?.telegram).toEqual(
        expect.objectContaining({ dmPolicy: "pairing" }),
      );
    }
  });
});

describe("validateConfigObjectRawWithPlugins channel metadata", () => {
  it("still injects channel AJV defaults even in raw mode — persistence safety is handled by io.ts", async () => {
    // Channel and plugin AJV validation always runs with applyDefaults: true
    // (hardcoded) to avoid breaking schemas that mark defaulted fields as
    // required (e.g., BlueBubbles enrichGroupParticipantsFromContacts).
    //
    // The actual protection against leaking these defaults to disk lives in
    // writeConfigFile (io.ts), which uses persistCandidate (the pre-validation
    // merge-patched value) instead of validated.config.
    setupTelegramSchemaWithDefault();

    const result = validateConfigObjectRawWithPlugins({
      channels: {
        telegram: {},
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // AJV defaults ARE injected into validated.config even in raw mode.
      // This is intentional — see comment above.
      expect(result.config.channels?.telegram).toEqual(
        expect.objectContaining({ dmPolicy: "pairing" }),
      );
    }
  });
});

describe("validateConfigObjectRawWithPlugins plugin config defaults", () => {
  it("does not inject plugin AJV defaults in raw mode for plugin-owned config", async () => {
    setupPluginSchemaWithRequiredDefault();

    const result = validateConfigObjectRawWithPlugins({
      plugins: {
        entries: {
          opik: {
            enabled: true,
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.plugins?.entries?.opik?.config).toBeUndefined();
    }
  });
});

describe("validateConfigObjectWithPlugins bundled allowlist compatibility", () => {
  it("reuses the manifest registry loaded for compatibility during plugin validation", () => {
    mockLoadPluginManifestRegistry.mockReturnValue(createCompatPluginConfigSchemaRegistry());

    const result = validateConfigObjectWithPlugins({
      plugins: {
        allow: ["opik"],
        entries: {
          opik: {
            enabled: true,
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(mockLoadPluginManifestRegistry).toHaveBeenCalledOnce();
  });

  it("uses a provided plugin metadata snapshot during plugin validation", () => {
    const result = validateConfigObjectWithPlugins(
      {
        plugins: {
          allow: ["opik"],
          entries: {
            opik: {
              enabled: true,
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createPluginConfigSchemaRegistry(),
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(mockLoadPluginManifestRegistry).not.toHaveBeenCalled();
    if (result.ok) {
      expect(result.config.plugins?.entries?.opik?.config).toEqual({
        workspace: "default-workspace",
      });
    }
  });

  it("loads a plugin metadata snapshot once during plugin validation", () => {
    const loadPluginMetadataSnapshot = vi.fn((_config: unknown) => ({
      manifestRegistry: createPluginConfigSchemaRegistry(),
    }));

    const result = validateConfigObjectWithPlugins(
      {
        plugins: {
          allow: ["opik"],
          entries: {
            opik: {
              enabled: true,
            },
          },
        },
      },
      {
        loadPluginMetadataSnapshot,
      },
    );

    expect(result.ok).toBe(true);
    expect(loadPluginMetadataSnapshot).toHaveBeenCalledOnce();
    expect(mockLoadPluginManifestRegistry).not.toHaveBeenCalled();
  });
});
