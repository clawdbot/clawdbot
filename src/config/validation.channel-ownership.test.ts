// Channel schema OWNERSHIP contracts in config validation: canonical channel identity for
// authored variant spellings, and ownership planning from the defaulted config the gateway's
// auto-enable pass actually consumes.
import { describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

const mockLoadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn(
    (): PluginManifestRegistry => ({
      diagnostics: [],
      plugins: [],
    }),
  ),
);

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

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: () => ({
    manifestRegistry: mockLoadPluginManifestRegistry(),
  }),
  resolvePluginMetadataSnapshot: () => ({
    manifestRegistry: mockLoadPluginManifestRegistry(),
  }),
}));

vi.mock("../plugins/doctor-contract-registry.js", () => ({
  collectRelevantDoctorPluginIds: () => [],
}));

// #120332 round 48 (P2): an authored variant spelling of a claimed channel validates with the
// canonical schema. Schema metadata is keyed by canonical channel identity, so a raw-key lookup
// found no schema and silently accepted unsupported fields under the declared spelling.
describe("variant channel spellings validate canonically", () => {
  it("rejects unsupported keys authored under a claimed variant spelling", () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        createPluginManifestRecord({
          id: "qqbot-variant",
          origin: "global",
          channels: ["QQBot"],
          channelConfigs: {
            QQBot: {
              schema: {
                type: "object",
                properties: { mode: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        }),
      ],
    });

    const result = validateConfigObjectWithPlugins({
      channels: { QQBot: { bogusKey: true } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path.startsWith("channels.QQBot"))).toBe(true);
    }
  });
});

// #120332 round 48 (P1): ownership is planned from the DEFAULTED config. A `{}` channel whose
// schema default makes it meaningfully configured activates its replacement claim in the
// validated config gateway auto-enable consumes — the replacement supersedes the claimant
// serving ANOTHER channel, so that channel must be validated with the post-default owner's
// schema instead of the pre-default plan's.
describe("channel schema ownership follows the defaulted config", () => {
  it("ranks a sibling channel by the post-default owner", () => {
    const strictSchema = (property: string, extra?: Record<string, unknown>) => ({
      type: "object",
      properties: { [property]: { type: "string", ...extra } },
      additionalProperties: false,
    });
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        createPluginManifestRecord({
          id: "acme-multi",
          origin: "global",
          enabledByDefault: true,
          channels: ["acha", "bchb"],
          channelConfigs: {
            acha: { schema: strictSchema("region") },
            bchb: { schema: strictSchema("multiOpt") },
          },
        }),
        createPluginManifestRecord({
          id: "acme-alt",
          origin: "global",
          enabledByDefault: true,
          channels: ["bchb"],
          channelConfigs: { bchb: { schema: strictSchema("altOpt") } },
        }),
        createPluginManifestRecord({
          id: "acme-rep",
          origin: "global",
          enabledByDefault: true,
          channels: ["acha"],
          channelConfigs: {
            acha: {
              schema: strictSchema("region", { default: "us" }),
              preferOver: ["acme-multi"],
            },
          },
        }),
      ],
    });

    const result = validateConfigObjectWithPlugins({
      channels: { acha: {}, bchb: { multiOpt: "x" } },
    });

    // Post-defaults `acha` is configured, its replacement kills the multi-channel incumbent,
    // and `bchb`'s runtime owner is the alternative claimant whose schema rejects the
    // incumbent-only key.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path.startsWith("channels.bchb"))).toBe(true);
    }
  });
});
