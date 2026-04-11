import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";

type MockPluginRegistry = {
  diagnostics: Array<Record<string, unknown>>;
  plugins: Array<Record<string, unknown>>;
};

function createEmptyPluginRegistry(): MockPluginRegistry {
  return { diagnostics: [], plugins: [] };
}

const mockLoadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => MockPluginRegistry>(() => createEmptyPluginRegistry()),
);

vi.mock("../plugins/manifest-registry.js", () => {
  return {
    loadPluginManifestRegistry: (...args: unknown[]) => mockLoadPluginManifestRegistry(...args),
    resolveManifestContractPluginIds: () => [],
  };
});

vi.mock("../plugins/doctor-contract-registry.js", () => {
  return {
    collectRelevantDoctorPluginIds: () => [],
    listPluginDoctorLegacyConfigRules: () => [],
  };
});

afterEach(() => {
  mockLoadPluginManifestRegistry.mockReset();
  mockLoadPluginManifestRegistry.mockImplementation(createEmptyPluginRegistry);
});

function setupTelegramSchemaWithDefault() {
  mockLoadPluginManifestRegistry.mockReturnValue({
    diagnostics: [],
    plugins: [
      {
        id: "telegram",
        origin: "bundled",
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
      },
    ],
  });
}

function setupPluginSchemaWithRequiredDefault() {
  mockLoadPluginManifestRegistry.mockReturnValue({
    diagnostics: [],
    plugins: [
      {
        id: "opik",
        origin: "bundled",
        channels: [],
        providers: [],
        kind: ["tool"],
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
      },
    ],
  });
}

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
