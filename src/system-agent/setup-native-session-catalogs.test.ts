import { describe, expect, it } from "vitest";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  applySetupNativeSessionCatalogPreference,
  listSetupNativeSessionCatalogs,
  resolveSetupNativeSessionCatalogPreference,
} from "./setup-native-session-catalogs.js";

function metadata(): PluginMetadataSnapshot {
  const catalogPlugin = (id: string, label: string) => ({
    id,
    name: label,
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: "/fixture",
    source: "/fixture/index.js",
    manifestPath: "/fixture/openclaw.plugin.json",
    configSchema: {
      type: "object",
      properties: {
        sessionCatalog: {
          type: "object",
          properties: { enabled: { type: "boolean", default: true } },
        },
      },
    },
    configUiHints: {
      "sessionCatalog.enabled": {
        label: `Discover ${label} Sessions`,
        help: `Show existing ${label} conversations.`,
      },
    },
  });
  return {
    plugins: [catalogPlugin("codex", "Codex"), catalogPlugin("anthropic", "Claude Code")],
  } as unknown as PluginMetadataSnapshot;
}

describe("native session catalog onboarding", () => {
  it("defaults fresh setup off and ignores stale explicit values for existing installs", () => {
    expect(resolveSetupNativeSessionCatalogPreference({ consentRequired: true })).toBe(false);
    expect(
      resolveSetupNativeSessionCatalogPreference({ consentRequired: true, requested: true }),
    ).toBe(true);
    expect(
      resolveSetupNativeSessionCatalogPreference({ consentRequired: false, requested: true }),
    ).toBeUndefined();
  });
  it("requires consent only for an otherwise fresh default-agent setup", async () => {
    const { requiresSetupNativeSessionCatalogConsent } =
      await import("./setup-native-session-catalogs.js");
    const configPath = "/fixture/openclaw.json";
    const classify = (params: Parameters<typeof requiresSetupNativeSessionCatalogConsent>[0]) =>
      requiresSetupNativeSessionCatalogConsent({ ...params, completedLocalOnboarding: false });
    expect(classify({ configPath, config: {}, setupComplete: false })).toBe(true);
    expect(
      classify({
        configPath,
        config: { wizard: { lastRunAt: "2026-09-05T00:00:00.000Z" } },
        setupComplete: false,
      }),
    ).toBe(false);
    expect(
      classify({
        configPath,
        config: { channels: { telegram: {} } },
        setupComplete: false,
      }),
    ).toBe(false);
    expect(
      classify({
        configPath,
        config: {
          plugins: {
            entries: { codex: { config: { sessionCatalog: { enabled: true } } } },
          },
        },
        setupComplete: false,
      }),
    ).toBe(false);
    expect(classify({ configPath, config: {}, setupComplete: false, agentId: "research" })).toBe(
      false,
    );
    expect(classify({ configPath, config: {}, setupComplete: true })).toBe(false);
  });
  it("lists manifest-declared catalogs without provider-id policy", () => {
    expect(listSetupNativeSessionCatalogs({ config: {}, metadataSnapshot: metadata() })).toEqual([
      {
        pluginId: "anthropic",
        label: "Claude Code",
        detail: "Show existing Claude Code conversations.",
      },
      {
        pluginId: "codex",
        label: "Codex",
        detail: "Show existing Codex conversations.",
      },
    ]);
  });

  it("persists an explicit decline for every declared native catalog", () => {
    const config = applySetupNativeSessionCatalogPreference({
      config: {},
      enabled: false,
      metadataSnapshot: metadata(),
    });
    expect(config.plugins?.entries?.anthropic?.config).toEqual({
      sessionCatalog: { enabled: false },
    });
    expect(config.plugins?.entries?.codex?.config).toEqual({
      sessionCatalog: { enabled: false },
    });
  });
});
