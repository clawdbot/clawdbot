// Verifies channel metadata validation and plugin capability lookups.

import { expectDefined } from "@openclaw/normalization-core";
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

function createExternalFeishuSchemaRegistry(): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      createPluginManifestRecord({
        id: "openclaw-lark",
        origin: "global",
        channels: ["feishu"],
        channelConfigs: {
          feishu: {
            schema: {
              type: "object",
              properties: {
                appId: { type: "string" },
                appSecret: { type: "string" },
                replyMode: { type: "string", enum: ["thread", "direct"] },
                footer: { type: "string" },
              },
              required: ["appId", "appSecret"],
              additionalProperties: false,
            },
            uiHints: {},
          },
        },
      }),
    ],
  };
}

function createExternalFeishuSchemaWithCloserMetadataRegistry(): PluginManifestRegistry {
  const registry = createExternalFeishuSchemaRegistry();
  return {
    diagnostics: [],
    plugins: [
      createPluginManifestRecord({
        id: "workspace-channel-labels",
        origin: "workspace",
        channels: ["feishu"],
        channelConfigs: {
          feishu: {
            schema: undefined as never,
            label: "Workspace Feishu",
          },
        },
      }),
      ...registry.plugins,
    ],
  };
}

function createExternalFeishuSchemaWithRootOnlyShadowRegistry(): PluginManifestRegistry {
  const firstSchema = expectDefined(
    createExternalFeishuSchemaRegistry().plugins[0],
    "createExternalFeishuSchemaRegistry().plugins[0] test invariant",
  );
  return {
    diagnostics: [],
    plugins: [
      firstSchema,
      createPluginManifestRecord({
        id: "workspace-channel-labels",
        origin: "workspace",
        channels: ["feishu"],
      }),
      createPluginManifestRecord({
        id: "other-global-feishu",
        origin: "global",
        channels: ["feishu"],
        channelConfigs: {
          feishu: {
            schema: {
              type: "object",
              properties: {
                otherField: { type: "string" },
              },
              additionalProperties: false,
            },
          },
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
  listPluginDoctorLegacyConfigRules: () => [],
  applyPluginDoctorCompatibilityMigrations: () => ({ next: null, changes: [] }),
}));

vi.mock("../secrets/target-registry-data.js", () => ({
  getCoreSecretTargetRegistry: () => [],
  getSecretTargetRegistry: () => [],
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
  it("applies bundled channel defaults from plugin-owned schema metadata", () => {
    setupTelegramSchemaWithDefault();

    const result = validateConfigObjectWithPlugins({
      channels: {
        telegram: {},
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.channels?.telegram?.dmPolicy).toBe("pairing");
    }
  });

  it("accepts Discord agent component TTL in generated bundled channel metadata", () => {
    const result = validateConfigObjectWithPlugins({
      channels: {
        discord: {
          agentComponents: {
            ttlMs: 120_000,
          },
          accounts: {
            work: {
              agentComponents: {
                ttlMs: 60_000,
              },
            },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.channels?.discord?.agentComponents?.ttlMs).toBe(120_000);
      expect(result.config.channels?.discord?.accounts?.work?.agentComponents?.ttlMs).toBe(60_000);
    }
  });

  it('warns on Mattermost dmPolicy="open" without wildcard allowFrom', () => {
    const result = validateConfigObjectWithPlugins({
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://chat.example.com",
          botToken: "test-token",
          dmPolicy: "open",
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        path: "channels.mattermost.allowFrom",
        message: expect.stringContaining('channels.mattermost.dmPolicy="open"'),
      }),
    );
  });

  it('warns on account-scoped Mattermost dmPolicy="open" without wildcard allowFrom', () => {
    const result = validateConfigObjectWithPlugins({
      channels: {
        mattermost: {
          accounts: {
            work: {
              enabled: true,
              baseUrl: "https://chat.example.com",
              botToken: "test-token",
              dmPolicy: "open",
            },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        path: "channels.mattermost.accounts.work.allowFrom",
        message: expect.stringContaining('channels.mattermost.accounts.work.dmPolicy="open"'),
      }),
    );
  });

  it("applies the dmPolicy/allowFrom dependency check generically (telegram), not just Mattermost", () => {
    // Use generated bundled metadata (no plugin-owned schema override) so this proves
    // the check is channel-agnostic rather than wired to a specific channel id.
    mockLoadPluginManifestRegistry.mockReturnValue({ diagnostics: [], plugins: [] });
    const result = validateConfigObjectWithPlugins({
      channels: {
        telegram: {
          botToken: "test-token",
          dmPolicy: "open",
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        path: "channels.telegram.allowFrom",
        message: expect.stringContaining('channels.telegram.dmPolicy="open"'),
      }),
    );
  });

  it('does not warn when dmPolicy="open" includes a wildcard allowFrom', () => {
    const result = validateConfigObjectWithPlugins({
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://chat.example.com",
          botToken: "test-token",
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(
      result.warnings.some((warning) => warning.path === "channels.mattermost.allowFrom"),
    ).toBe(false);
  });

  it("does not warn when an account inherits a wildcard allowFrom from the channel default", () => {
    const result = validateConfigObjectWithPlugins({
      channels: {
        mattermost: {
          baseUrl: "https://chat.example.com",
          botToken: "test-token",
          allowFrom: ["*"],
          accounts: {
            work: {
              dmPolicy: "open",
            },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => warning.path.startsWith("channels.mattermost"))).toBe(
      false,
    );
  });

  it('does not warn when dmPolicy="open" is satisfied by the legacy dm.allowFrom alias', () => {
    // Runtime resolves allowFrom as canonical `allowFrom` ?? legacy `dm.allowFrom`, so a
    // top-level-canonical channel (Discord) that keeps its wildcard under `dm.allowFrom`
    // is valid and must not produce a false "all DMs dropped" warning.
    const result = validateConfigObjectWithPlugins({
      channels: {
        discord: {
          enabled: true,
          token: "test-token",
          dmPolicy: "open",
          dm: { allowFrom: ["*"] },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => warning.path === "channels.discord.allowFrom")).toBe(
      false,
    );
  });
});

describe("validateConfigObjectWithPlugins DM policy warnings", () => {
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

describe("validateConfigObjectRawWithPlugins channel metadata", () => {
  it("still injects channel AJV defaults even in raw mode — persistence safety is handled by io.ts", () => {
    // Channel and plugin AJV validation always runs with applyDefaults: true
    // (hardcoded) to avoid breaking schemas that mark defaulted fields as
    // required.
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
      expect(result.config.channels?.telegram?.dmPolicy).toBe("pairing");
    }
  });

  it("uses external plugin channel schemas for raw validation", () => {
    mockLoadPluginManifestRegistry.mockReturnValue(createExternalFeishuSchemaRegistry());

    const result = validateConfigObjectRawWithPlugins({
      channels: {
        feishu: {
          appId: "app-id",
          appSecret: "secret",
          replyMode: "thread",
          footer: "OpenClaw",
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("names the external plugin owner for unsupported channel properties", () => {
    mockLoadPluginManifestRegistry.mockReturnValue(createExternalFeishuSchemaRegistry());

    const result = validateConfigObjectRawWithPlugins({
      channels: {
        feishu: {
          appId: "app-id",
          appSecret: "secret",
          unsupportedField: true,
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          path: "channels.feishu",
          message:
            'invalid config for plugin openclaw-lark: must not have additional properties: "unsupportedField"',
        }),
      );
    }
  });

  it("keeps unsupported property diagnostics assigned to the schema owner", () => {
    mockLoadPluginManifestRegistry.mockReturnValue(
      createExternalFeishuSchemaWithCloserMetadataRegistry(),
    );

    const result = validateConfigObjectRawWithPlugins({
      channels: {
        feishu: {
          appId: "app-id",
          appSecret: "secret",
          unsupportedField: true,
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          path: "channels.feishu",
          message:
            'invalid config for plugin openclaw-lark: must not have additional properties: "unsupportedField"',
        }),
      );
      expect(result.issues.map((issue) => issue.message)).not.toContain(
        'invalid config for plugin workspace-channel-labels: must not have additional properties: "unsupportedField"',
      );
    }
  });

  it("keeps schema ownership coupled when closer root metadata preserves a schema", () => {
    mockLoadPluginManifestRegistry.mockReturnValue(
      createExternalFeishuSchemaWithRootOnlyShadowRegistry(),
    );

    const result = validateConfigObjectRawWithPlugins({
      channels: {
        feishu: {
          appId: "app-id",
          appSecret: "secret",
          unsupportedField: true,
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          path: "channels.feishu",
          message:
            'invalid config for plugin openclaw-lark: must not have additional properties: "unsupportedField"',
        }),
      );
      expect(result.issues.map((issue) => issue.message)).not.toContain(
        'invalid config for plugin other-global-feishu: must not have additional properties: "unsupportedField"',
      );
    }
  });

  it("sanitizes the schema owner in validation diagnostics", () => {
    const unsafeId = `openclaw${String.fromCharCode(10)}${String.fromCharCode(27)}[31m-lark`;
    const registry = createExternalFeishuSchemaRegistry();
    const plugin = expectDefined(registry.plugins[0], "external Feishu plugin manifest");
    registry.plugins[0] = {
      ...plugin,
      id: unsafeId,
    };
    mockLoadPluginManifestRegistry.mockReturnValue(registry);

    const result = validateConfigObjectRawWithPlugins({
      channels: {
        feishu: {
          appId: "app-id",
          appSecret: "secret",
          unsupportedField: true,
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          path: "channels.feishu",
          message:
            'invalid config for plugin openclaw-lark: must not have additional properties: "unsupportedField"',
        }),
      );
    }
  });

  it("keeps raw channel validation diagnostics plugin-agnostic", () => {
    const result = validateConfigObjectRawWithPlugins({
      channels: {
        telegram: {
          groups: ["-1001234567890"],
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          path: "channels.telegram.groups",
          message: expect.stringContaining("invalid config:"),
        }),
      );
      expect(result.issues[0]?.message).not.toContain("Telegram groups");
      expect(result.issues[0]?.message).not.toContain("openclaw doctor --fix");
    }
  });
});

describe("validateConfigObjectRawWithPlugins plugin config defaults", () => {
  it("does not inject plugin AJV defaults in raw mode for plugin-owned config", () => {
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
  it("accepts the shipped deprecated bundledDiscovery marker", () => {
    const result = validateConfigObjectWithPlugins({
      plugins: {
        allow: ["telegram"],
        bundledDiscovery: "compat",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.plugins?.bundledDiscovery).toBe("compat");
    }
  });

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
    const loadPluginMetadataSnapshot = vi.fn((_configForTest: unknown) => ({
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
