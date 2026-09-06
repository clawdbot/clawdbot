// Setup plugin config tests cover plugin choices and generated config.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginConfigUiHint } from "../plugins/types.js";
import type { WizardPrompter } from "./prompts.js";
import {
  discoverConfigurablePlugins,
  discoverUnconfiguredPlugins,
  setupPluginConfig,
} from "./setup.plugin-config.js";

const loadPluginManifestRegistryCore = vi.fn();

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore,
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: loadPluginManifestRegistryCore,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: () => {
    const registry = loadPluginManifestRegistryCore();
    return {
      plugins: registry.plugins,
      manifestRegistry: registry,
      discovery: registry.discovery,
    };
  },
}));

// Wraps the real resolver rather than replacing it, so every other test keeps running
// against actual activation behaviour while this one can see what it was handed.
const activationInputs: { discovery?: unknown; manifestRegistry?: unknown }[] = [];

vi.mock("../plugins/activation-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/activation-context.js")>();
  return {
    ...actual,
    resolvePluginActivationInputs: (
      params: Parameters<typeof actual.resolvePluginActivationInputs>[0],
    ) => {
      activationInputs.push(params);
      return actual.resolvePluginActivationInputs(params);
    },
  };
});

function makeManifestPlugin(
  id: string,
  uiHints?: Record<string, PluginConfigUiHint>,
  configSchema?: Record<string, unknown>,
) {
  return {
    id,
    name: id,
    configUiHints: uiHints,
    configSchema,
    enabled: true,
    enabledByDefault: true,
    // Real manifest records always carry one, and activation resolution walks it.
    rootDir: `/tmp/openclaw-test-plugins/${id}`,
    origin: "bundled" as const,
  };
}

function requireFirst<T>(values: T[], label: string): T {
  const value = values[0];
  if (value === undefined) {
    throw new Error(`expected first ${label}`);
  }
  return value;
}

describe("discoverConfigurablePlugins", () => {
  it("returns plugins with non-advanced uiHints", () => {
    const plugins = [
      makeManifestPlugin("openshell", {
        mode: { label: "Mode", help: "Sandbox mode" },
        gateway: { label: "Gateway", help: "Gateway name" },
        gpu: { label: "GPU", advanced: true },
      }),
    ];
    const result = discoverConfigurablePlugins({ manifestPlugins: plugins });
    expect(result).toHaveLength(1);
    const plugin = requireFirst(result, "configurable plugin");
    expect(plugin.id).toBe("openshell");
    expect(Object.keys(plugin.uiHints)).toEqual(["mode", "gateway"]);
    // Advanced field excluded
    expect(plugin.uiHints.gpu).toBeUndefined();
  });

  it("excludes plugins with no uiHints", () => {
    const plugins = [makeManifestPlugin("bare-plugin")];
    const result = discoverConfigurablePlugins({ manifestPlugins: plugins });
    expect(result).toHaveLength(0);
  });

  it("excludes sensitive fields from promptable hints", () => {
    const plugins = [
      makeManifestPlugin("secret-plugin", {
        endpoint: { label: "Endpoint" },
        apiKey: { label: "API Key", sensitive: true },
      }),
    ];
    const result = discoverConfigurablePlugins({ manifestPlugins: plugins });
    expect(result).toHaveLength(1);
    // sensitive fields are still included in uiHints for discovery —
    // they are skipped at prompt time, not at discovery time
    const plugin = requireFirst(result, "configurable plugin");
    expect(plugin.uiHints.endpoint?.label).toBe("Endpoint");
    expect(plugin.uiHints.apiKey?.label).toBe("API Key");
    expect(plugin.uiHints.apiKey?.sensitive).toBe(true);
  });

  it("excludes plugins where all fields are advanced", () => {
    const plugins = [
      makeManifestPlugin("all-advanced", {
        gpu: { label: "GPU", advanced: true },
        timeout: { label: "Timeout", advanced: true },
      }),
    ];
    const result = discoverConfigurablePlugins({ manifestPlugins: plugins });
    expect(result).toHaveLength(0);
  });

  it("sorts results alphabetically by name", () => {
    const plugins = [
      makeManifestPlugin("zeta", { a: { label: "A" } }),
      makeManifestPlugin("alpha", { b: { label: "B" } }),
    ];
    const result = discoverConfigurablePlugins({ manifestPlugins: plugins });
    expect(result.map((p) => p.id)).toEqual(["alpha", "zeta"]);
  });
});

describe("discoverUnconfiguredPlugins", () => {
  it("returns plugins with at least one unconfigured field", () => {
    const plugins = [
      makeManifestPlugin("openshell", {
        mode: { label: "Mode" },
        gateway: { label: "Gateway" },
      }),
    ];
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          openshell: {
            config: { mode: "mirror" },
          },
        },
      },
    };
    const result = discoverUnconfiguredPlugins({
      manifestPlugins: plugins,
      config,
    });
    // gateway is unconfigured
    expect(result).toHaveLength(1);
    expect(requireFirst(result, "unconfigured plugin").id).toBe("openshell");
  });

  it("excludes plugins where all fields are configured", () => {
    const plugins = [
      makeManifestPlugin("openshell", {
        mode: { label: "Mode" },
        gateway: { label: "Gateway" },
      }),
    ];
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          openshell: {
            config: { mode: "mirror", gateway: "my-gw" },
          },
        },
      },
    };
    const result = discoverUnconfiguredPlugins({
      manifestPlugins: plugins,
      config,
    });
    expect(result).toHaveLength(0);
  });

  it("treats empty string as unconfigured", () => {
    const plugins = [
      makeManifestPlugin("test-plugin", {
        endpoint: { label: "Endpoint" },
      }),
    ];
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          "test-plugin": {
            config: { endpoint: "" },
          },
        },
      },
    };
    const result = discoverUnconfiguredPlugins({
      manifestPlugins: plugins,
      config,
    });
    expect(result).toHaveLength(1);
  });

  it("returns empty when no plugins have uiHints", () => {
    const plugins = [makeManifestPlugin("bare")];
    const result = discoverUnconfiguredPlugins({
      manifestPlugins: plugins,
      config: {},
    });
    expect(result).toHaveLength(0);
  });

  it("treats dotted uiHint paths as configured when nested config exists", () => {
    const plugins = [
      makeManifestPlugin(
        "brave",
        {
          "webSearch.mode": { label: "Brave Search Mode" },
        },
        {
          type: "object",
          properties: {
            webSearch: {
              type: "object",
              properties: {
                mode: {
                  type: "string",
                  enum: ["web", "llm-context"],
                },
              },
            },
          },
        },
      ),
    ];
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          brave: {
            config: {
              webSearch: {
                mode: "llm-context",
              },
            },
          },
        },
      },
    };
    const result = discoverUnconfiguredPlugins({
      manifestPlugins: plugins,
      config,
    });
    expect(result).toHaveLength(0);
  });
});

describe("setupPluginConfig", () => {
  it("does not offer a default-on plugin that config explicitly disables", async () => {
    // `enabledByDefault || entry.enabled === true` reads an explicit false as "not true" and
    // falls back to the manifest default, so the wizard used to solicit settings for a plugin
    // that is switched off and then warn that its config is present but the plugin is disabled.
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        {
          ...makeManifestPlugin("xai", { apiKey: { label: "API key" } }),
          origin: "bundled",
          enabledByDefault: true,
        },
      ],
    });

    const multiselect = vi.fn(async () => {
      throw new Error("multiselect should not run when no plugin is active");
    });
    const text = vi.fn(async () => {
      throw new Error("text should not run when no plugin is active");
    });

    const result = await setupPluginConfig({
      config: {
        plugins: {
          entries: {
            xai: { enabled: false },
          },
        },
      } as OpenClawConfig,
      prompter: {
        intro: vi.fn(async () => {}),
        outro: vi.fn(async () => {}),
        note: vi.fn(async () => {}),
        select: vi.fn(async () => {
          throw new Error("select should not run when no plugin is active");
        }) as unknown as WizardPrompter["select"],
        multiselect: multiselect as unknown as WizardPrompter["multiselect"],
        text: text as unknown as WizardPrompter["text"],
        confirm: vi.fn(async () => {
          throw new Error("confirm should not run when no plugin is active");
        }),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      },
    });

    expect(multiselect).not.toHaveBeenCalled();
    expect(result).toEqual({
      plugins: {
        entries: {
          xai: { enabled: false },
        },
      },
    });
  });

  it("allows skipping plugin setup from the multiselect prompt", async () => {
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        {
          ...makeManifestPlugin("device-pairing", {
            enabled: { label: "Enable pairing" },
          }),
          enabledByDefault: true,
        },
      ],
    });

    const note = vi.fn(async () => {});
    const select = vi.fn(async () => {
      throw new Error("select should not run when plugin setup is skipped");
    });
    const text = vi.fn(async () => {
      throw new Error("text should not run when plugin setup is skipped");
    });
    const confirm = vi.fn(async () => {
      throw new Error("confirm should not run when plugin setup is skipped");
    });

    const result = await setupPluginConfig({
      config: {
        plugins: {
          entries: {
            "device-pairing": {
              enabled: true,
            },
          },
        },
      },
      prompter: {
        intro: vi.fn(async () => {}),
        outro: vi.fn(async () => {}),
        note,
        select: select as unknown as WizardPrompter["select"],
        multiselect: vi.fn(async () => ["__skip__"]) as unknown as WizardPrompter["multiselect"],
        text,
        confirm,
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      },
    });

    expect(result).toEqual({
      plugins: {
        entries: {
          "device-pairing": {
            enabled: true,
          },
        },
      },
    });
    expect(note).not.toHaveBeenCalled();
  });

  it("writes dotted uiHint values into nested plugin config", async () => {
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        {
          ...makeManifestPlugin(
            "brave",
            {
              "webSearch.mode": { label: "Brave Search Mode" },
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                webSearch: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    mode: {
                      type: "string",
                      enum: ["web", "llm-context"],
                    },
                  },
                },
              },
            },
          ),
          enabledByDefault: true,
        },
      ],
    });

    const result = await setupPluginConfig({
      config: {
        plugins: {
          entries: {
            brave: {
              enabled: true,
            },
          },
        },
      },
      prompter: {
        intro: vi.fn(async () => {}),
        outro: vi.fn(async () => {}),
        note: vi.fn(async () => {}),
        select: vi.fn(async () => "llm-context") as unknown as WizardPrompter["select"],
        multiselect: vi.fn(async () => ["brave"]) as unknown as WizardPrompter["multiselect"],
        text: vi.fn(async () => ""),
        confirm: vi.fn(async () => true),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      },
    });

    expect(result.plugins?.entries?.brave?.config).toEqual({
      webSearch: {
        mode: "llm-context",
      },
    });
    expect(result.plugins?.entries?.brave?.config?.["webSearch.mode"]).toBeUndefined();
  });

  it("keeps config saved under a legacy plugin id when the wizard writes", async () => {
    // `google-gemini-cli` is a real alias for `google`. Looking the entry up by the canonical
    // id alone reads back nothing, so the wizard re-asked for fields that were already set
    // and then wrote a second entry, leaving the answers on the old key behind.
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        {
          ...makeManifestPlugin("google", {
            apiKey: { label: "API key" },
            region: { label: "Region" },
          }),
          enabledByDefault: true,
        },
      ],
    });

    const asked: string[] = [];
    const text = vi.fn(async (opts: { message: string }) => {
      asked.push(opts.message);
      return "eu-west";
    });

    const result = await setupPluginConfig({
      config: {
        plugins: {
          entries: {
            "google-gemini-cli": {
              enabled: true,
              config: { apiKey: "existing-key" },
            },
          },
        },
      } as unknown as OpenClawConfig,
      prompter: {
        intro: vi.fn(async () => {}),
        outro: vi.fn(async () => {}),
        note: vi.fn(async () => {}),
        select: vi.fn(async () => "") as unknown as WizardPrompter["select"],
        multiselect: vi.fn(async () => ["google"]) as unknown as WizardPrompter["multiselect"],
        text: text as unknown as WizardPrompter["text"],
        confirm: vi.fn(async () => true),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      },
    });

    // The key it already had is seen through the alias, so it is not asked for again.
    expect(asked).toHaveLength(1);
    expect(requireFirst(asked, "prompt")).toContain("Region");

    // One entry on the canonical id carrying both the old value and the new one.
    expect(result.plugins?.entries?.google?.config).toEqual({
      apiKey: "existing-key",
      region: "eu-west",
    });
    expect(result.plugins?.entries?.["google-gemini-cli"]).toBeUndefined();
  });

  it.each([
    { name: "alias written first", aliasFirst: true },
    { name: "canonical written first", aliasFirst: false },
  ])(
    "keeps both sides when alias and canonical both hold config, $name",
    async ({ aliasFirst }) => {
      // A config can carry both keys at once. Collapsing them keeps only whichever one the
      // normalizer wrote last, so one side's settings vanish, and which side that is depends
      // on the order they sit in the file. Both orders have to end up the same.
      const aliasEntry = { enabled: true, config: { apiKey: "from-alias" } };
      const canonicalEntry = { enabled: true, config: { region: "from-canonical" } };
      const entries = aliasFirst
        ? { "google-gemini-cli": aliasEntry, google: canonicalEntry }
        : { google: canonicalEntry, "google-gemini-cli": aliasEntry };

      loadPluginManifestRegistryCore.mockReturnValue({
        plugins: [
          {
            ...makeManifestPlugin("google", {
              apiKey: { label: "API key" },
              region: { label: "Region" },
              model: { label: "Model" },
            }),
            enabledByDefault: true,
          },
        ],
      });

      const result = await setupPluginConfig({
        config: { plugins: { entries } } as unknown as OpenClawConfig,
        prompter: {
          intro: vi.fn(async () => {}),
          outro: vi.fn(async () => {}),
          note: vi.fn(async () => {}),
          select: vi.fn(async () => "") as unknown as WizardPrompter["select"],
          multiselect: vi.fn(async () => ["google"]) as unknown as WizardPrompter["multiselect"],
          text: vi.fn(async () => "gemini-2"),
          confirm: vi.fn(async () => true),
          progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
        },
      });

      expect(result.plugins?.entries?.google?.config).toEqual({
        apiKey: "from-alias",
        region: "from-canonical",
        model: "gemini-2",
      });
      expect(result.plugins?.entries?.["google-gemini-cli"]).toBeUndefined();
    },
  );

  it("does not grant a permission a later alias is denying", async () => {
    // Runtime normalization takes the last raw entry, so an alias written after the canonical
    // one is the effective policy. Folding canonical-last would write the grant back and hand
    // the plugin conversation access and prompt injection it is currently refused.
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        {
          ...makeManifestPlugin("google", { apiKey: { label: "API key" } }),
          enabledByDefault: true,
        },
      ],
    });

    const result = await setupPluginConfig({
      config: {
        plugins: {
          entries: {
            google: {
              enabled: true,
              hooks: { allowConversationAccess: true, allowPromptInjection: true },
            },
            "google-gemini-cli": {
              enabled: true,
              hooks: { allowConversationAccess: false, allowPromptInjection: false },
            },
          },
        },
      } as unknown as OpenClawConfig,
      prompter: {
        intro: vi.fn(async () => {}),
        outro: vi.fn(async () => {}),
        note: vi.fn(async () => {}),
        select: vi.fn(async () => "") as unknown as WizardPrompter["select"],
        multiselect: vi.fn(async () => ["google"]) as unknown as WizardPrompter["multiselect"],
        text: vi.fn(async () => "written-key"),
        confirm: vi.fn(async () => true),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      },
    });

    expect(result.plugins?.entries?.google?.hooks).toEqual({
      allowConversationAccess: false,
      allowPromptInjection: false,
    });
  });

  it("does not write normalization-only fields into the saved config", async () => {
    // normalizePluginsConfig derives hasAllowedModelsConfig for runtime policy and drops the
    // allowedModels list it came from. Those derived keys are not allowed in persisted config,
    // so folding through the normalized entry would both add a forbidden key and lose a real
    // setting the user had.
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        {
          ...makeManifestPlugin("google", {
            apiKey: { label: "API key" },
          }),
          enabledByDefault: true,
        },
      ],
    });

    const result = await setupPluginConfig({
      config: {
        plugins: {
          entries: {
            google: { enabled: true, llm: { allowedModels: [] } },
          },
        },
      } as unknown as OpenClawConfig,
      prompter: {
        intro: vi.fn(async () => {}),
        outro: vi.fn(async () => {}),
        note: vi.fn(async () => {}),
        select: vi.fn(async () => "") as unknown as WizardPrompter["select"],
        multiselect: vi.fn(async () => ["google"]) as unknown as WizardPrompter["multiselect"],
        text: vi.fn(async () => "written-key"),
        confirm: vi.fn(async () => true),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      },
    });

    const llm = result.plugins?.entries?.google?.llm as Record<string, unknown> | undefined;
    expect(llm).toEqual({ allowedModels: [] });
    expect(llm).not.toHaveProperty("hasAllowedModelsConfig");
  });

  it("does not switch a plugin off while folding a conflicting alias", async () => {
    // Raw entries are applied in file order, so a later alias saying enabled true beats a
    // canonical false and the plugin is running. A fold that always puts canonical last
    // would write that false back and silently disable it on the next wizard answer.
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        {
          ...makeManifestPlugin("google", {
            apiKey: { label: "API key" },
            region: { label: "Region" },
          }),
          enabledByDefault: false,
        },
      ],
    });

    const result = await setupPluginConfig({
      config: {
        plugins: {
          entries: {
            google: { enabled: false, config: { region: "eu" } },
            "google-gemini-cli": { enabled: true },
          },
        },
      } as unknown as OpenClawConfig,
      prompter: {
        intro: vi.fn(async () => {}),
        outro: vi.fn(async () => {}),
        note: vi.fn(async () => {}),
        select: vi.fn(async () => "") as unknown as WizardPrompter["select"],
        multiselect: vi.fn(async () => ["google"]) as unknown as WizardPrompter["multiselect"],
        text: vi.fn(async () => "written-key"),
        confirm: vi.fn(async () => true),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      },
    });

    // Still on, and the region it already had is still there.
    expect(result.plugins?.entries?.google?.enabled).toBe(true);
    expect(result.plugins?.entries?.google?.config).toMatchObject({ region: "eu" });
    expect(result.plugins?.entries?.["google-gemini-cli"]).toBeUndefined();
  });

  it("hands activation the discovery its inventory came from", async () => {
    // With only the registry forwarded, auto-enable re-derives a default scope discovery, so
    // a workspace scoped run judges activation against a different generation than the
    // plugin list was built from.
    const discovery = { candidates: [], diagnostics: [] };
    activationInputs.length = 0;
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [makeManifestPlugin("brave", { token: { label: "Token" } })],
      discovery,
    });

    await setupPluginConfig({
      config: { plugins: { entries: { brave: { enabled: true } } } } as OpenClawConfig,
      workspaceDir: "/tmp/openclaw-test-workspace",
      prompter: {
        intro: vi.fn(async () => {}),
        outro: vi.fn(async () => {}),
        note: vi.fn(async () => {}),
        select: vi.fn(async () => "") as unknown as WizardPrompter["select"],
        multiselect: vi.fn(async () => ["__skip__"]) as unknown as WizardPrompter["multiselect"],
        text: vi.fn(async () => ""),
        confirm: vi.fn(async () => true),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      },
    });

    expect(activationInputs.at(-1)?.discovery).toBe(discovery);
  });

  it.each([
    {
      name: "an existing array through a dotted index",
      field: "accounts.0.token",
      existing: { accounts: [{}] },
      expected: { accounts: [{ token: "configured" }] },
    },
    {
      name: "a missing schema-declared array through a dotted index",
      field: "accounts.0.token",
      schema: {
        type: "object",
        properties: {
          accounts: {
            type: "array",
            items: { type: "object", properties: { token: { type: "string" } } },
          },
        },
      },
      expected: { accounts: [{ token: "configured" }] },
    },
    {
      name: "a numeric record key through a dotted path",
      field: "accounts.0.token",
      schema: {
        type: "object",
        properties: {
          accounts: {
            type: "object",
            properties: {
              "0": { type: "object", properties: { token: { type: "string" } } },
            },
          },
        },
      },
      expected: { accounts: { "0": { token: "configured" } } },
    },
    {
      name: "an explicit bracketed array index without a schema",
      field: "accounts[0].token",
      expected: { accounts: [{ token: "configured" }] },
    },
    {
      name: "an explicitly quoted numeric record key without a schema",
      field: 'accounts["0"].token',
      expected: { accounts: { "0": { token: "configured" } } },
    },
    {
      name: "a quoted record key containing a literal dot",
      field: 'accounts["primary.backup"].token',
      expected: { accounts: { "primary.backup": { token: "configured" } } },
    },
  ])("writes $name", async ({ field, existing, schema, expected }) => {
    const pluginId = "indexed-plugin";
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [makeManifestPlugin(pluginId, { [field]: { label: "Token" } }, schema)],
    });

    const result = await setupPluginConfig({
      config: {
        plugins: {
          entries: { [pluginId]: { enabled: true, ...(existing && { config: existing }) } },
        },
      },
      prompter: {
        intro: vi.fn(async () => {}),
        outro: vi.fn(async () => {}),
        note: vi.fn(async () => {}),
        select: vi.fn(async () => "") as unknown as WizardPrompter["select"],
        multiselect: vi.fn(async () => [pluginId]) as unknown as WizardPrompter["multiselect"],
        text: vi.fn(async () => "configured") as unknown as WizardPrompter["text"],
        confirm: vi.fn(async () => true),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      },
    });

    expect(result.plugins?.entries?.[pluginId]?.config).toEqual(expected);
  });

  it("rejects prototype-polluting dotted uiHint paths without mutating config", async () => {
    const pollutionProbe = "openclawPluginPollutionProbe";
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        {
          ...makeManifestPlugin("unsafe-plugin", {
            [`safe.__proto__.${pollutionProbe}`]: { label: "Unsafe field" },
          }),
          enabledByDefault: true,
        },
      ],
    });
    const config: OpenClawConfig = {
      plugins: { entries: { "unsafe-plugin": { enabled: true } } },
    };

    await expect(
      setupPluginConfig({
        config,
        prompter: {
          intro: vi.fn(async () => {}),
          outro: vi.fn(async () => {}),
          note: vi.fn(async () => {}),
          select: vi.fn(async () => "") as unknown as WizardPrompter["select"],
          multiselect: vi.fn(async () => [
            "unsafe-plugin",
          ]) as unknown as WizardPrompter["multiselect"],
          text: vi.fn(async () => "owned") as unknown as WizardPrompter["text"],
          confirm: vi.fn(async () => true),
          progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
        },
      }),
    ).rejects.toThrow(/Invalid path segment/);
    expect(config.plugins?.entries?.["unsafe-plugin"]?.config).toBeUndefined();
    expect(({} as Record<string, unknown>)[pollutionProbe]).toBeUndefined();
  });

  it("coerces only JSON-compatible numeric inputs", async () => {
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        makeManifestPlugin(
          "numeric-plugin",
          {
            decimal: { label: "Decimal" },
            scientific: { label: "Scientific" },
            retries: { label: "Retries" },
            hexadecimal: { label: "Hexadecimal" },
            fractionalRetries: { label: "Fractional retries" },
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              decimal: {
                type: "number",
              },
              scientific: {
                type: "number",
              },
              retries: {
                type: "integer",
              },
              hexadecimal: {
                type: "number",
              },
              fractionalRetries: {
                type: "integer",
              },
            },
          },
        ),
      ],
    });

    const answers = ["1.5", "1e2", "3", "0x10", "1.5"];

    const result = await setupPluginConfig({
      config: {
        plugins: {
          entries: {
            "numeric-plugin": {
              enabled: true,
            },
          },
        },
      },
      prompter: {
        intro: vi.fn(async () => {}),
        outro: vi.fn(async () => {}),
        note: vi.fn(async () => {}),
        select: vi.fn(async () => "") as unknown as WizardPrompter["select"],
        multiselect: vi.fn(async () => [
          "numeric-plugin",
        ]) as unknown as WizardPrompter["multiselect"],
        text: vi.fn(async () => answers.shift() ?? "") as unknown as WizardPrompter["text"],
        confirm: vi.fn(async () => true),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      },
    });

    expect(result.plugins?.entries?.["numeric-plugin"]?.config).toEqual({
      decimal: 1.5,
      scientific: 100,
      retries: 3,
    });
  });
});
