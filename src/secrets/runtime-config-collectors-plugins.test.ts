import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginOrigin } from "../plugins/types.js";
import { collectPluginConfigAssignments } from "./runtime-config-collectors-plugins.js";
import {
  createResolverContext,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";

const { loadPluginManifestRegistryForPluginRegistryMock } = vi.hoisted(() => ({
  loadPluginManifestRegistryForPluginRegistryMock: vi.fn(),
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: loadPluginManifestRegistryForPluginRegistryMock,
}));

vi.mock("../plugins/bundled-plugin-metadata.js", () => ({
  findBundledPluginMetadataById: () => undefined,
  listBundledPluginMetadata: () => [],
}));

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function makeContext(sourceConfig: OpenClawConfig): ResolverContext {
  return createResolverContext({
    sourceConfig,
    env: {},
  });
}

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

function loadablePluginOrigins(entries: Array<[string, PluginOrigin]>) {
  return new Map(entries);
}

function createAcpxMcpSecretConfig(params: {
  plugins?: Record<string, unknown>;
  entry?: Record<string, unknown>;
}): OpenClawConfig {
  return asConfig({
    plugins: {
      ...params.plugins,
      entries: {
        acpx: {
          ...params.entry,
          config: {
            mcpServers: {
              s1: { command: "node", env: { K: envRef("K") } },
            },
          },
        },
      },
    },
  });
}

function collectAcpxConfigAssignments(config: OpenClawConfig): ResolverContext {
  const context = makeContext(config);
  collectPluginConfigAssignments({
    config,
    defaults: undefined,
    context,
    loadablePluginOrigins: loadablePluginOrigins([["acpx", "bundled"]]),
  });
  return context;
}

function expectInactiveAcpxConfig(config: OpenClawConfig): void {
  const context = collectAcpxConfigAssignments(config);
  expect(context.assignments).toHaveLength(0);
  expect(context.warnings.some((w) => w.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE")).toBe(
    true,
  );
}

describe("collectPluginConfigAssignments", () => {
  beforeEach(() => {
    loadPluginManifestRegistryForPluginRegistryMock.mockReset();
    loadPluginManifestRegistryForPluginRegistryMock.mockReturnValue({
      plugins: [
        {
          id: "acpx",
          origin: "bundled",
          providers: [],
          legacyPluginIds: [],
          configContracts: {
            secretInputs: {
              bundledDefaultEnabled: false,
              paths: [{ path: "mcpServers.*.env.*", expected: "string" }],
            },
          },
        },
        {
          id: "other",
          origin: "config",
          providers: [],
          legacyPluginIds: [],
        },
      ],
      diagnostics: [],
    });
  });

  it("collects SecretRef assignments from active acpx MCP server env vars", () => {
    const config = asConfig({
      plugins: {
        entries: {
          acpx: {
            enabled: true,
            config: {
              mcpServers: {
                github: {
                  command: "npx",
                  args: ["-y", "@modelcontextprotocol/server-github"],
                  env: {
                    GITHUB_TOKEN: envRef("GITHUB_TOKEN"),
                    PLAIN_VAR: "plain-value",
                  },
                },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);
    const defaults: SecretDefaults = undefined;

    collectPluginConfigAssignments({
      config,
      defaults,
      context,
      loadablePluginOrigins: loadablePluginOrigins([["acpx", "bundled"]]),
    });

    expect(context.assignments).toHaveLength(1);
    expect(context.assignments[0]?.path).toBe(
      "plugins.entries.acpx.config.mcpServers.github.env.GITHUB_TOKEN",
    );
    expect(context.assignments[0]?.expected).toBe("string");
  });

  it("resolves assignments via apply callback", () => {
    const config = asConfig({
      plugins: {
        entries: {
          acpx: {
            enabled: true,
            config: {
              mcpServers: {
                mcp1: {
                  command: "node",
                  env: {
                    API_KEY: envRef("MY_API_KEY"),
                  },
                },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({
      config,
      defaults: undefined,
      context,
      loadablePluginOrigins: loadablePluginOrigins([["acpx", "bundled"]]),
    });

    expect(context.assignments).toHaveLength(1);
    context.assignments[0]?.apply("resolved-key-value");

    const entries = config.plugins?.entries as Record<string, Record<string, unknown>>;
    const mcpServers = (entries?.acpx?.config as Record<string, unknown>)?.mcpServers as Record<
      string,
      Record<string, unknown>
    >;
    const env = mcpServers?.mcp1?.env as Record<string, unknown>;
    expect(env?.API_KEY).toBe("resolved-key-value");
  });

  it("collects across multiple acpx servers only", () => {
    const config = asConfig({
      plugins: {
        entries: {
          acpx: {
            enabled: true,
            config: {
              mcpServers: {
                s1: { command: "a", env: { K1: envRef("K1") } },
                s2: { command: "b", env: { K2: envRef("K2"), K3: envRef("K3") } },
              },
            },
          },
          other: {
            enabled: true,
            config: {
              mcpServers: {
                s3: { command: "c", env: { K4: envRef("K4") } },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({
      config,
      defaults: undefined,
      context,
      loadablePluginOrigins: loadablePluginOrigins([
        ["acpx", "bundled"],
        ["other", "config"],
      ]),
    });

    expect(context.assignments).toHaveLength(3);
    const paths = context.assignments.map((a) => a.path).toSorted();
    expect(paths).toEqual([
      "plugins.entries.acpx.config.mcpServers.s1.env.K1",
      "plugins.entries.acpx.config.mcpServers.s2.env.K2",
      "plugins.entries.acpx.config.mcpServers.s2.env.K3",
    ]);
  });

  it("skips entries without config or mcpServers", () => {
    const config = asConfig({
      plugins: {
        entries: {
          noConfig: {},
          noMcpServers: { config: { otherKey: "value" } },
          noEnv: { config: { mcpServers: { s1: { command: "x" } } } },
        },
      },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({
      config,
      defaults: undefined,
      context,
      loadablePluginOrigins: loadablePluginOrigins([]),
    });

    expect(context.assignments).toHaveLength(0);
  });

  it("skips when no plugins.entries at all", () => {
    const config = asConfig({});
    const context = makeContext(config);

    collectPluginConfigAssignments({
      config,
      defaults: undefined,
      context,
      loadablePluginOrigins: loadablePluginOrigins([]),
    });

    expect(context.assignments).toHaveLength(0);
  });

  it("skips assignments when plugins.enabled is false", () => {
    expectInactiveAcpxConfig(
      createAcpxMcpSecretConfig({
        plugins: { enabled: false },
        entry: { enabled: true },
      }),
    );
  });

  it("skips assignments when entry.enabled is false", () => {
    expectInactiveAcpxConfig(createAcpxMcpSecretConfig({ entry: { enabled: false } }));
  });

  it("treats bundled acpx SecretRef surfaces as inactive until enabled", () => {
    expectInactiveAcpxConfig(createAcpxMcpSecretConfig({ plugins: { enabled: true } }));
  });

  it("skips assignments when plugin is in denylist", () => {
    expectInactiveAcpxConfig(
      createAcpxMcpSecretConfig({
        plugins: { deny: ["acpx"] },
        entry: { enabled: true },
      }),
    );
  });

  it("skips assignments when allowlist is set and plugin is not in it", () => {
    expectInactiveAcpxConfig(
      createAcpxMcpSecretConfig({
        plugins: { allow: ["other-plugin"] },
        entry: { enabled: true },
      }),
    );
  });

  it("collects assignments when plugin is in allowlist", () => {
    const config = createAcpxMcpSecretConfig({
      plugins: { allow: ["acpx"] },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({
      config,
      defaults: undefined,
      context,
      loadablePluginOrigins: loadablePluginOrigins([["acpx", "config"]]),
    });

    expect(context.assignments).toHaveLength(1);
  });

  it("ignores plain string env values", () => {
    const config = asConfig({
      plugins: {
        entries: {
          acpx: {
            enabled: true,
            config: {
              mcpServers: {
                s1: {
                  command: "node",
                  env: { PLAIN: "hello", ALSO_PLAIN: "world" },
                },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({
      config,
      defaults: undefined,
      context,
      loadablePluginOrigins: loadablePluginOrigins([["acpx", "bundled"]]),
    });

    expect(context.assignments).toHaveLength(0);
  });

  it("collects inline env-template refs while leaving normal strings literal", () => {
    const config = asConfig({
      plugins: {
        entries: {
          acpx: {
            enabled: true,
            config: {
              mcpServers: {
                s1: {
                  command: "node",
                  env: {
                    INLINE: "${INLINE_KEY}",
                    SECOND: "${SECOND_KEY}",
                    LITERAL: "hello",
                  },
                },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({
      config,
      defaults: undefined,
      context,
      loadablePluginOrigins: loadablePluginOrigins([["acpx", "bundled"]]),
    });

    expect(context.assignments).toHaveLength(2);
    expect(context.assignments[0]?.path).toBe(
      "plugins.entries.acpx.config.mcpServers.s1.env.INLINE",
    );
    expect(context.assignments[1]?.path).toBe(
      "plugins.entries.acpx.config.mcpServers.s1.env.SECOND",
    );
  });

  it("skips stale acpx entries not in loadablePluginOrigins", () => {
    const config = asConfig({
      plugins: {
        entries: {
          acpx: {
            enabled: true,
            config: {
              mcpServers: {
                s1: { command: "node", env: { K1: envRef("K1") } },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({
      config,
      defaults: undefined,
      context,
      loadablePluginOrigins: loadablePluginOrigins([]),
    });

    expect(context.assignments).toHaveLength(0);
    expect(
      context.warnings.some(
        (w) =>
          w.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE" &&
          w.path === "plugins.entries.acpx.config.mcpServers.s1.env.K1",
      ),
    ).toBe(true);
  });

  it("ignores non-acpx plugin mcpServers surfaces", () => {
    const config = asConfig({
      plugins: {
        entries: {
          other: {
            enabled: true,
            config: {
              mcpServers: {
                s1: { command: "node", env: { K1: envRef("K1") } },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({
      config,
      defaults: undefined,
      context,
      loadablePluginOrigins: loadablePluginOrigins([["other", "config"]]),
    });

    expect(context.assignments).toHaveLength(0);
  });

  it("collects manifest-declared SecretRef surfaces for non-acpx plugins", () => {
    loadPluginManifestRegistryForPluginRegistryMock.mockReturnValue({
      plugins: [
        {
          id: "other",
          origin: "config",
          providers: [],
          legacyPluginIds: [],
          configContracts: {
            secretInputs: {
              paths: [{ path: "service.tokens.*", expected: "string" }],
            },
          },
        },
      ],
      diagnostics: [],
    });
    const config = asConfig({
      plugins: {
        entries: {
          other: {
            enabled: true,
            config: {
              service: {
                tokens: {
                  primary: envRef("PRIMARY_TOKEN"),
                  secondary: "${SECONDARY_TOKEN}",
                },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({
      config,
      defaults: undefined,
      context,
      loadablePluginOrigins: loadablePluginOrigins([["other", "config"]]),
    });

    expect(context.assignments.map((assignment) => assignment.path).toSorted()).toEqual([
      "plugins.entries.other.config.service.tokens.primary",
      "plugins.entries.other.config.service.tokens.secondary",
    ]);
  });
});
