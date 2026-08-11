// Channel DM-policy warning contracts in config validation: manifest-declared dmAllowFromMode
// shapes decide which authored configs the generic dmPolicy/allowFrom dependency check covers.
import { describe, expect, it } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

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

function createDmPolicyRegistry(params: {
  channelId: string;
  dmAllowFromMode?: "topOnly" | "topOrNested" | "nestedOnly";
}): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      createPluginManifestRecord({
        id: params.channelId,
        channels: [params.channelId],
        packageChannel: {
          id: params.channelId,
          ...(params.dmAllowFromMode
            ? { doctorCapabilities: { dmAllowFromMode: params.dmAllowFromMode } }
            : {}),
        },
      }),
    ],
  };
}

describe("validateConfigObjectWithPlugins DM policy warnings", () => {
  // #120332 round 53 (P2): DM-policy modes are keyed by CANONICAL channel identity. A manifest
  // declaring a variant spelling ("QQBot") admits the canonical authored key, but a raw-key
  // mode lookup missed and downgraded the nested-only channel to the default top-only shape —
  // false DM-policy warnings on a valid config.
  it("skips nested-only shapes when the manifest declares a variant channel spelling", () => {
    const result = validateConfigObjectWithPlugins(
      {
        channels: {
          qqbot: {
            dm: {
              policy: "open",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createDmPolicyRegistry({
            channelId: "QQBot",
            dmAllowFromMode: "nestedOnly",
          }),
        },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.warnings.filter((warning) => warning.path.startsWith("channels.qqbot")),
      ).toEqual([]);
    }
  });

  // #120332 round 55 (P2): alias-equivalent claimants collapse by ORIGIN RANK inside metadata
  // collection, not by raw key order in a consumer's map — a closer claimant's nestedOnly must
  // win over a farther variant's topOnly, or the warning path evaluates the wrong shape.
  it("ranks alias-equivalent DM modes by origin before the warning path", () => {
    const result = validateConfigObjectWithPlugins(
      { channels: { qqbot: { dmPolicy: "open" } } },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: {
            diagnostics: [],
            plugins: [
              createPluginManifestRecord({
                id: "qqbot-closer",
                origin: "config",
                channels: ["qqbot"],
                packageChannel: {
                  id: "qqbot",
                  doctorCapabilities: { dmAllowFromMode: "nestedOnly" },
                },
              }),
              createPluginManifestRecord({
                id: "qqbot-farther",
                origin: "global",
                channels: ["QQBot"],
                packageChannel: {
                  id: "QQBot",
                  doctorCapabilities: { dmAllowFromMode: "topOnly" },
                },
              }),
            ],
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.warnings.filter((warning) => warning.path.startsWith("channels.qqbot")),
      ).toEqual([]);
    }
  });

  // #120332 round 58 (P2): one plugin's alias-equivalent spellings share a canonical record —
  // the package-channel mode survives the same-rank channels/channelConfigs writes that carry
  // no mode (their raw spelling differs from the package id), or the channel defaults back to
  // topOnly and emits false warnings.
  it("keeps the package-channel DM mode beside alias-equivalent claim spellings", () => {
    const result = validateConfigObjectWithPlugins(
      { channels: { clickclack: { dmPolicy: "open" } } },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: {
            diagnostics: [],
            plugins: [
              createPluginManifestRecord({
                id: "clickclack-alias-modes",
                origin: "global",
                channels: ["ClickClack"],
                packageChannel: {
                  id: "clickclack",
                  doctorCapabilities: { dmAllowFromMode: "nestedOnly" },
                },
                channelConfigs: { ClickClack: { schema: { type: "object" } } },
              }),
            ],
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.warnings.filter((warning) => warning.path.startsWith("channels.clickclack")),
      ).toEqual([]);
    }
  });

  it("uses manifest metadata to skip nested-only DM config shapes", () => {
    const result = validateConfigObjectWithPlugins(
      {
        channels: {
          matrix: {
            dm: {
              policy: "open",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createDmPolicyRegistry({
            channelId: "matrix",
            dmAllowFromMode: "nestedOnly",
          }),
        },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.warnings.filter((warning) => warning.path.startsWith("channels.matrix")),
      ).toEqual([]);
    }
  });

  it("does not warn for disabled channels or accounts", () => {
    const result = validateConfigObjectWithPlugins(
      {
        channels: {
          mattermost: {
            enabled: false,
            dmPolicy: "open",
            accounts: {
              team: {
                dmPolicy: "open",
              },
            },
          },
          slack: {
            accounts: {
              work: {
                enabled: false,
                dmPolicy: "open",
              },
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: {
            diagnostics: [],
            plugins: [
              ...createDmPolicyRegistry({ channelId: "mattermost" }).plugins,
              ...createDmPolicyRegistry({ channelId: "slack" }).plugins,
            ],
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.warnings.filter((warning) => warning.path.startsWith("channels.mattermost")),
      ).toEqual([]);
      expect(
        result.warnings.filter((warning) => warning.path.startsWith("channels.slack")),
      ).toEqual([]);
    }
  });

  it("does not suggest channel allowFrom as sufficient when account allowFrom overrides it", () => {
    const result = validateConfigObjectWithPlugins(
      {
        channels: {
          mattermost: {
            allowFrom: ["*"],
            accounts: {
              team: {
                dmPolicy: "open",
                allowFrom: [],
              },
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createDmPolicyRegistry({ channelId: "mattermost" }),
        },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const warning = result.warnings.find(
        (entry) => entry.path === "channels.mattermost.accounts.team.allowFrom",
      );
      expect(warning?.message).toContain(
        "remove channels.mattermost.accounts.team.allowFrom to inherit channels.mattermost.allowFrom",
      );
      expect(warning?.message).not.toContain("(or channels.mattermost.allowFrom)");
    }
  });
});
