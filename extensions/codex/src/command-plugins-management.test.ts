// Codex tests cover command plugins management plugin behavior.
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import type { v2 } from "./app-server/protocol.js";
import {
  handleCodexPluginsSubcommand,
  type CodexPluginsConfigBlock,
  type CodexPluginsManagementIO,
} from "./command-plugins-management.js";

type CodexPluginConfigEntry = NonNullable<CodexPluginsConfigBlock["plugins"]>[string];
type CodexPluginsManagementRuntime = NonNullable<
  Parameters<typeof handleCodexPluginsSubcommand>[3]
>;

function inMemoryIO(
  initial: Record<string, CodexPluginConfigEntry> = {},
  options: { enabled?: boolean } = { enabled: true },
): CodexPluginsManagementIO & {
  current: () => Record<string, CodexPluginConfigEntry>;
  currentConfig: () => CodexPluginsConfigBlock;
} {
  const store: CodexPluginsConfigBlock = {
    enabled: options.enabled,
    plugins: structuredClone(initial),
  };
  return {
    current: () => structuredClone(store.plugins ?? {}),
    currentConfig: () => structuredClone(store),
    readConfig: () => Promise.resolve(structuredClone(store)),
    mutate: async (update) => {
      update(store);
    },
  };
}

const fakeCtx: PluginCommandContext = {
  args: "",
  config: {},
  channel: "test",
  isAuthorizedSender: true,
  senderIsOwner: true,
  commandBody: "/codex plugins",
  requestConversationBinding: async () => ({ status: "error", message: "unused" }),
  detachConversationBinding: async () => ({ removed: false }),
  getCurrentConversationBinding: async () => null,
};

function buttonCommands(result: PluginCommandResult): string[] {
  const block = result.presentation?.blocks.find((candidate) => candidate.type === "buttons");
  if (!block || block.type !== "buttons") {
    throw new Error("expected button presentation");
  }
  return block.buttons.map((button) =>
    button.action?.type === "command" ? button.action.command : "",
  );
}

function pluginSummary(
  name: string,
  marketplace: string,
  overrides: Partial<v2.PluginSummary> = {},
) {
  return {
    id: `${name}@${marketplace}`,
    name,
    installed: false,
    enabled: false,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_USE",
    ...(overrides.remotePluginId ? { mustShowInstallationInterstitial: false } : {}),
    interface: { shortDescription: "Security review <@team> *instructions*" },
    ...overrides,
  } satisfies v2.PluginSummary;
}

function pluginRuntime(params?: {
  marketplace?: string;
  marketplacePath?: string;
  pluginName?: string;
  remotePluginId?: string;
  mustShowInstallationInterstitial?: boolean | null;
  installed?: boolean;
  enabled?: boolean;
  install?: CodexPluginsManagementRuntime["install"];
  refresh?: CodexPluginsManagementRuntime["refresh"];
}) {
  const marketplace = params?.marketplace ?? "company-tools";
  const pluginName = params?.pluginName ?? "security-review";
  const listed = {
    marketplaces: [
      {
        name: marketplace,
        ...(params?.marketplacePath ? { path: params.marketplacePath } : {}),
        plugins: [
          pluginSummary(pluginName, marketplace, {
            ...(params?.remotePluginId
              ? {
                  remotePluginId: params.remotePluginId,
                  ...(params.mustShowInstallationInterstitial !== undefined
                    ? {
                        mustShowInstallationInterstitial: params.mustShowInstallationInterstitial,
                      }
                    : {}),
                }
              : {}),
            ...(params?.installed ? { installed: true } : {}),
            ...(params?.enabled ? { enabled: true } : {}),
          }),
        ],
      },
    ],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  } satisfies v2.PluginListResponse;
  return {
    workspaceDir: vi.fn(async () => "/repo/company"),
    list: vi.fn(async () => listed),
    install: params?.install ?? vi.fn(async () => ({ authPolicy: "ON_USE", appsNeedingAuth: [] })),
    ...(params?.refresh ? { refresh: params.refresh } : {}),
  } satisfies CodexPluginsManagementRuntime;
}

describe("Codex /codex plugins subcommand", () => {
  it("lists a configured plugin with its enabled marker and explains the underlying file", async () => {
    const io = inMemoryIO({
      "google-calendar": {
        enabled: true,
        marketplaceName: "openai-curated",
        pluginName: "google-calendar",
      },
    });

    const result = await handleCodexPluginsSubcommand(fakeCtx, ["list"], io);
    expect(result.text).toContain("ON   google-calendar");
    expect(result.text).toContain("openclaw.json");
  });

  it("lists effective disabled status when the global plugin switch is off", async () => {
    const io = inMemoryIO(
      {
        "google-calendar": {
          enabled: true,
          marketplaceName: "openai-curated",
          pluginName: "google-calendar",
        },
      },
      { enabled: false },
    );

    const result = await handleCodexPluginsSubcommand(fakeCtx, ["list"], io);
    expect(result.text).toContain("OFF  google-calendar");
    expect(result.text).toContain("Global codexPlugins.enabled is off");
  });

  it("renders the plugins menu as portable slash-command buttons", async () => {
    const io = inMemoryIO();

    const result = await handleCodexPluginsSubcommand(fakeCtx, ["menu"], io);

    expect(result.text).toContain("/codex plugins list");
    expect(buttonCommands(result)).toEqual([
      "/codex plugins list",
      "/codex plugins available",
      "/codex plugins status",
      "/codex plugins enable",
      "/codex plugins disable",
      "/codex plugins help",
      "/codex",
    ]);
  });

  it("renders enable and disable target pickers from effective plugin state", async () => {
    const io = inMemoryIO({
      "google-calendar": {
        enabled: false,
        marketplaceName: "openai-curated",
        pluginName: "google-calendar",
      },
      notion: {
        enabled: true,
        marketplaceName: "openai-curated",
        pluginName: "notion",
      },
    });

    const enableResult = await handleCodexPluginsSubcommand(fakeCtx, ["enable"], io);
    expect(enableResult.text).toContain("/codex plugins enable google-calendar");
    expect(buttonCommands(enableResult)).toEqual([
      "/codex plugins enable google-calendar",
      "/codex plugins menu",
    ]);

    const disableResult = await handleCodexPluginsSubcommand(fakeCtx, ["disable"], io);
    expect(disableResult.text).toContain("/codex plugins disable notion");
    expect(buttonCommands(disableResult)).toEqual([
      "/codex plugins disable notion",
      "/codex plugins menu",
    ]);
  });

  it("enables and disables a configured plugin and reflects the change in subsequent reads", async () => {
    const io = inMemoryIO({
      "google-calendar": {
        enabled: true,
        marketplaceName: "openai-curated",
        pluginName: "google-calendar",
      },
    });

    const disabled = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["disable", "google-calendar"],
      io,
    );
    expect(disabled.text).toContain("disabled");
    expect(io.current()["google-calendar"]?.enabled).toBe(false);

    const enabled = await handleCodexPluginsSubcommand(fakeCtx, ["enable", "google-calendar"], io);
    expect(enabled.text).toContain("enabled");
    expect(io.currentConfig().enabled).toBe(true);
    expect(io.current()["google-calendar"]?.enabled).toBe(true);
  });

  it.each(["enable", "disable"] as const)(
    "preserves an exact legacy config key containing @ when running %s",
    async (verb) => {
      const io = inMemoryIO({
        "team@prod": {
          enabled: verb === "disable",
          marketplaceName: "openai-curated",
          pluginName: "gmail",
        },
      });

      const result = await handleCodexPluginsSubcommand(fakeCtx, [verb, "team@prod"], io);

      expect(result.text).toContain(`team＠prod: ${verb}d`);
      expect(io.current()["team@prod"]?.enabled).toBe(verb === "enable");
    },
  );

  it("rejects enable and disable from non-owner non-admin callers", async () => {
    const io = inMemoryIO({
      "google-calendar": {
        enabled: true,
        marketplaceName: "openai-curated",
        pluginName: "google-calendar",
      },
    });
    const ctx = { ...fakeCtx, senderIsOwner: false, gatewayClientScopes: ["operator.write"] };

    const result = await handleCodexPluginsSubcommand(ctx, ["disable", "google-calendar"], io);
    expect(result.text).toContain("Only an owner or operator.admin");
    expect(io.current()["google-calendar"]?.enabled).toBe(true);
  });

  it("allows operator.admin gateway callers to enable and disable", async () => {
    const io = inMemoryIO({
      "google-calendar": {
        enabled: true,
        marketplaceName: "openai-curated",
        pluginName: "google-calendar",
      },
    });
    const ctx = { ...fakeCtx, senderIsOwner: false, gatewayClientScopes: ["operator.admin"] };

    const result = await handleCodexPluginsSubcommand(ctx, ["disable", "google-calendar"], io);
    expect(result.text).toContain("disabled");
    expect(io.current()["google-calendar"]?.enabled).toBe(false);
  });

  it("lists workspace-scoped marketplaces and escapes untrusted plugin descriptions", async () => {
    const runtime = pluginRuntime({
      marketplacePath: "/repo/company/.agents/plugins/marketplace.json",
    });

    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["available"],
      inMemoryIO(),
      runtime,
    );

    expect(runtime.workspaceDir).toHaveBeenCalledOnce();
    expect(runtime.list).toHaveBeenCalledWith({ cwds: ["/repo/company"] });
    expect(runtime.list).toHaveBeenCalledWith({
      cwds: ["/repo/company"],
      marketplaceKinds: [
        "workspace-directory",
        "shared-with-me",
        "created-by-me-remote",
        "vertical",
      ],
    });
    expect(result.text).toContain("security-review@company-tools");
    expect(result.text).toContain("&lt;＠team&gt;");
    expect(result.text).not.toContain("<@team>");
    expect(result.text).not.toContain("*instructions*");
  });

  it("installs local plugins from their exact marketplace path and enables only the selected plugin", async () => {
    const io = inMemoryIO({}, { enabled: false });
    const runtime = pluginRuntime({
      marketplacePath: "/repo/company/.agents/plugins/marketplace.json",
    });

    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "security-review@company-tools"],
      io,
      runtime,
    );

    expect(runtime.install).toHaveBeenCalledWith({
      marketplacePath: "/repo/company/.agents/plugins/marketplace.json",
      pluginName: "security-review",
    });
    expect(io.currentConfig()).toEqual({
      enabled: true,
      plugins: {
        "security-review@company-tools": {
          enabled: true,
          marketplaceName: "company-tools",
          pluginName: "security-review",
        },
      },
    });
    expect(io.currentConfig()).not.toHaveProperty("allow_all_plugins");
    expect(result.text).toContain("installed and authorized");
  });

  it("installs remote plugins with their opaque remote identity and preserves exact summary ids", async () => {
    const io = inMemoryIO();
    const runtime = pluginRuntime({
      marketplace: "workspace-directory",
      remotePluginId: "plugins~Plugin_11111111111111111111111111111111",
    });

    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "security-review@workspace-directory"],
      io,
      runtime,
    );

    expect(runtime.install).toHaveBeenCalledWith({
      remoteMarketplaceName: "workspace-directory",
      pluginName: "plugins~Plugin_11111111111111111111111111111111",
    });
    expect(io.current()["security-review@workspace-directory"]?.pluginName).toBe(
      "security-review@workspace-directory",
    );
    expect(result.text).toContain("installed and authorized");
  });

  it.each([
    { policy: true, message: "requires a Codex installation confirmation" },
    { policy: null, message: "did not provide its required installation-confirmation policy" },
  ] as const)(
    "honors remote Codex installation interstitial policy $policy without invoking plugin/install",
    async ({ policy, message }) => {
      const runtime = pluginRuntime({
        marketplace: "workspace-directory",
        remotePluginId: "plugins~Plugin_remote_opaque",
        mustShowInstallationInterstitial: policy,
      });

      const result = await handleCodexPluginsSubcommand(
        fakeCtx,
        ["install", "security-review@workspace-directory"],
        inMemoryIO(),
        runtime,
      );

      expect(runtime.install).not.toHaveBeenCalled();
      expect(result.text).toContain(message);
      expect(result.text).toContain("Install it in Codex first");
    },
  );

  it.each([true, null] as const)(
    "authorizes a remote plugin already installed through its Codex interstitial (%j)",
    async (mustShowInstallationInterstitial) => {
      const io = inMemoryIO();
      const runtime = pluginRuntime({
        marketplace: "workspace-directory",
        remotePluginId: "plugins~Plugin_remote_opaque",
        mustShowInstallationInterstitial,
        installed: true,
        enabled: true,
      });

      const result = await handleCodexPluginsSubcommand(
        fakeCtx,
        ["install", "security-review@workspace-directory"],
        io,
        runtime,
      );

      expect(runtime.install).not.toHaveBeenCalled();
      expect(io.current()).toHaveProperty("security-review@workspace-directory");
      expect(result.text).toContain("already installed in Codex and is now authorized");
    },
  );

  it("authorizes an already active plugin without requiring an installation selector", async () => {
    const io = inMemoryIO();
    const runtime = pluginRuntime({ installed: true, enabled: true });

    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "security-review@company-tools"],
      io,
      runtime,
    );

    expect(runtime.install).not.toHaveBeenCalled();
    expect(io.current()).toHaveProperty("security-review@company-tools");
    expect(result.text).toContain("already installed in Codex and is now authorized");
  });

  it("accepts Codex-approved local marketplace roots outside the selected workspace", async () => {
    const runtime = pluginRuntime({
      marketplacePath: "/approved/codex-home/company-tools/marketplace.json",
    });

    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "security-review@company-tools"],
      inMemoryIO(),
      runtime,
    );

    expect(runtime.list).toHaveBeenCalledWith({ cwds: ["/repo/company"] });
    expect(runtime.install).toHaveBeenCalledWith({
      marketplacePath: "/approved/codex-home/company-tools/marketplace.json",
      pluginName: "security-review",
    });
    expect(result.text).toContain("installed and authorized");
  });

  it("updates an existing legacy policy for the same marketplace-qualified plugin", async () => {
    const io = inMemoryIO({
      security: {
        enabled: false,
        marketplaceName: "company-tools",
        pluginName: "security-review",
        allow_destructive_actions: "ask",
      },
    });
    const runtime = pluginRuntime({
      marketplacePath: "/repo/company/.agents/plugins/marketplace.json",
    });

    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "security-review@company-tools"],
      io,
      runtime,
    );

    expect(io.current()).toEqual({
      security: {
        enabled: true,
        marketplaceName: "company-tools",
        pluginName: "security-review",
        allow_destructive_actions: "ask",
      },
    });
    expect(result.text).toContain("installed and authorized");
  });

  it.each(["openai-curated-remote", "openai-api-curated"])(
    "preserves existing curated authorization when discovery reports the %s wire alias",
    async (marketplace) => {
      const io = inMemoryIO({
        github: {
          enabled: false,
          marketplaceName: "openai-curated",
          pluginName: "github",
          allow_destructive_actions: "ask",
        },
      });
      const runtime = pluginRuntime({
        marketplace,
        pluginName: "github",
        remotePluginId: "plugins~Plugin_github_opaque",
      });

      const result = await handleCodexPluginsSubcommand(
        fakeCtx,
        ["install", `github@${marketplace}`],
        io,
        runtime,
      );

      expect(io.current()).toEqual({
        github: {
          enabled: true,
          marketplaceName: "openai-curated",
          pluginName: "github",
          allow_destructive_actions: "ask",
        },
      });
      expect(runtime.install).toHaveBeenCalledWith({
        remoteMarketplaceName: marketplace,
        pluginName: "plugins~Plugin_github_opaque",
      });
      expect(result.text).toContain("installed and authorized");
    },
  );

  it.each(["openai-curated-remote", "openai-api-curated"])(
    "stores a newly installed %s plugin under the stable curated identity",
    async (marketplace) => {
      const io = inMemoryIO();
      const runtime = pluginRuntime({
        marketplace,
        pluginName: "github",
        remotePluginId: "plugins~Plugin_github_opaque",
      });

      const result = await handleCodexPluginsSubcommand(
        fakeCtx,
        ["install", `github@${marketplace}`],
        io,
        runtime,
      );

      expect(io.current()).toEqual({
        "github@openai-curated": {
          enabled: true,
          marketplaceName: "openai-curated",
          pluginName: "github",
        },
      });
      expect(result.text).toContain("installed and authorized");
    },
  );

  it.each(["openai-curated-remote", "openai-api-curated"])(
    "accepts the stable curated install command when Codex advertises %s",
    async (marketplace) => {
      const io = inMemoryIO();
      const runtime = pluginRuntime({
        marketplace,
        pluginName: "github",
        remotePluginId: "plugins~Plugin_github_opaque",
      });

      const result = await handleCodexPluginsSubcommand(
        fakeCtx,
        ["install", "github@openai-curated"],
        io,
        runtime,
      );

      expect(io.current()).toHaveProperty("github@openai-curated");
      expect(runtime.install).toHaveBeenCalledWith({
        remoteMarketplaceName: marketplace,
        pluginName: "plugins~Plugin_github_opaque",
      });
      expect(result.text).toContain("installed and authorized");
    },
  );

  it("deduplicates curated marketplace aliases pointing to the same opaque remote plugin", async () => {
    const io = inMemoryIO();
    const remotePluginId = "plugins~Plugin_github_opaque";
    const runtime = {
      ...pluginRuntime({ pluginName: "github", remotePluginId }),
      list: vi.fn(async (params: v2.PluginListParams) => {
        const marketplace = params.marketplaceKinds ? "openai-curated-remote" : "openai-curated";
        return {
          marketplaces: [
            {
              name: marketplace,
              plugins: [pluginSummary("github", marketplace, { remotePluginId })],
            },
          ],
          marketplaceLoadErrors: [],
          featuredPluginIds: [],
        } satisfies v2.PluginListResponse;
      }),
    } satisfies CodexPluginsManagementRuntime;

    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "github@openai-curated"],
      io,
      runtime,
    );

    expect(runtime.install).toHaveBeenCalledWith({
      remoteMarketplaceName: "openai-curated",
      pluginName: remotePluginId,
    });
    expect(io.current()).toHaveProperty("github@openai-curated");
    expect(result.text).toContain("installed and authorized");
  });

  it("preserves an already active plugin reported under another curated wire alias", async () => {
    const io = inMemoryIO();
    const remotePluginId = "plugins~Plugin_github_opaque";
    const runtime = {
      ...pluginRuntime({ pluginName: "github", remotePluginId }),
      list: vi.fn(async (params: v2.PluginListParams) => {
        const active = Boolean(params.marketplaceKinds);
        const marketplace = active ? "openai-curated-remote" : "openai-curated";
        return {
          marketplaces: [
            {
              name: marketplace,
              plugins: [
                pluginSummary("github", marketplace, {
                  remotePluginId,
                  installed: active,
                  enabled: active,
                  mustShowInstallationInterstitial: true,
                }),
              ],
            },
          ],
          marketplaceLoadErrors: [],
          featuredPluginIds: [],
        } satisfies v2.PluginListResponse;
      }),
    } satisfies CodexPluginsManagementRuntime;

    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "github@openai-curated"],
      io,
      runtime,
    );

    expect(runtime.install).not.toHaveBeenCalled();
    expect(io.current()).toHaveProperty("github@openai-curated");
    expect(result.text).toContain("already installed in Codex and is now authorized");
  });

  it("retains administrator restrictions when curated wire aliases are deduplicated", async () => {
    const remotePluginId = "plugins~Plugin_github_opaque";
    const runtime = {
      ...pluginRuntime({ pluginName: "github", remotePluginId }),
      list: vi.fn(async (params: v2.PluginListParams) => {
        const restricted = Boolean(params.marketplaceKinds);
        const marketplace = restricted ? "openai-curated-remote" : "openai-curated";
        return {
          marketplaces: [
            {
              name: marketplace,
              plugins: [
                pluginSummary("github", marketplace, {
                  remotePluginId,
                  ...(restricted ? { availability: "DISABLED_BY_ADMIN" } : {}),
                }),
              ],
            },
          ],
          marketplaceLoadErrors: [],
          featuredPluginIds: [],
        } satisfies v2.PluginListResponse;
      }),
    } satisfies CodexPluginsManagementRuntime;

    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "github@openai-curated"],
      inMemoryIO(),
      runtime,
    );

    expect(runtime.install).not.toHaveBeenCalled();
    expect(result.text).toContain("unavailable or disabled");
  });

  it("rejects a curated alias when the canonical config slot belongs to another plugin", async () => {
    const io = inMemoryIO({
      "github@openai-curated": {
        enabled: false,
        marketplaceName: "company-tools",
        pluginName: "security-review",
        allow_destructive_actions: true,
      },
    });
    const runtime = pluginRuntime({
      marketplace: "openai-curated-remote",
      pluginName: "github",
      remotePluginId: "plugins~Plugin_github_opaque",
    });

    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "github@openai-curated-remote"],
      io,
      runtime,
    );

    expect(result.text).toContain("points to a different plugin identity");
    expect(runtime.install).not.toHaveBeenCalled();
    expect(io.current()["github@openai-curated"]?.enabled).toBe(false);
  });

  it("rejects a mismatched install identity without breaking exact legacy lifecycle keys", async () => {
    const io = inMemoryIO({
      "security-review@company-tools": {
        enabled: false,
        marketplaceName: "another-marketplace",
        pluginName: "different-plugin",
        allow_destructive_actions: true,
      },
    });
    const runtime = pluginRuntime({
      marketplacePath: "/repo/company/.agents/plugins/marketplace.json",
    });

    const installed = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "security-review@company-tools"],
      io,
      runtime,
    );
    const enabled = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["enable", "security-review@company-tools"],
      io,
    );
    expect(installed.text).toContain("points to a different plugin identity");
    expect(enabled.text).toContain("enabled in openclaw.json");
    expect(runtime.install).not.toHaveBeenCalled();
    expect(io.current()["security-review@company-tools"]).toEqual({
      enabled: true,
      marketplaceName: "another-marketplace",
      pluginName: "different-plugin",
      allow_destructive_actions: true,
    });
  });

  it("rejects duplicate legacy policies before installation or qualified enablement", async () => {
    const io = inMemoryIO({
      first: {
        enabled: false,
        marketplaceName: "company-tools",
        pluginName: "security-review",
        allow_destructive_actions: false,
      },
      second: {
        enabled: false,
        marketplaceName: "company-tools",
        pluginName: "security-review@company-tools",
        allow_destructive_actions: true,
      },
    });
    const runtime = pluginRuntime({
      marketplacePath: "/repo/company/.agents/plugins/marketplace.json",
    });

    const installed = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "security-review@company-tools"],
      io,
      runtime,
    );
    const enabled = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["enable", "security-review@company-tools"],
      io,
    );
    const enabledDirect = await handleCodexPluginsSubcommand(fakeCtx, ["enable", "first"], io);

    expect(installed.text).toContain("Multiple configured Codex plugins match");
    expect(enabled.text).toContain("Multiple configured Codex plugins match");
    expect(enabledDirect.text).toContain("Multiple configured Codex plugins match");
    expect(runtime.install).not.toHaveBeenCalled();
    expect(Object.keys(io.current())).toEqual(["first", "second"]);
    expect(io.current().first?.enabled).toBe(false);
    expect(io.current().second?.enabled).toBe(false);
  });

  it("rejects direct legacy enablement when another plugin occupies its canonical slot", async () => {
    const io = inMemoryIO({
      security: {
        enabled: false,
        marketplaceName: "company-tools",
        pluginName: "security-review",
      },
      "security-review@company-tools": {
        enabled: false,
        marketplaceName: "different-tools",
        pluginName: "another-plugin",
      },
    });

    const result = await handleCodexPluginsSubcommand(fakeCtx, ["enable", "security"], io);

    expect(result.text).toContain("points to a different plugin identity");
    expect(io.current().security?.enabled).toBe(false);
    expect(io.current()["security-review@company-tools"]?.enabled).toBe(false);
  });

  it("rejects a duplicated canonical and legacy policy for the same plugin", async () => {
    const io = inMemoryIO({
      "security-review@company-tools": {
        enabled: false,
        marketplaceName: "company-tools",
        pluginName: "security-review",
      },
      legacy: {
        enabled: false,
        marketplaceName: "company-tools",
        pluginName: "security-review",
        allow_destructive_actions: true,
      },
    });
    const runtime = pluginRuntime({
      marketplacePath: "/repo/company/.agents/plugins/marketplace.json",
    });

    const installed = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "security-review@company-tools"],
      io,
      runtime,
    );
    const enabled = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["enable", "security-review@company-tools"],
      io,
    );

    expect(installed.text).toContain("Multiple configured Codex plugins match");
    expect(enabled.text).toContain("Multiple configured Codex plugins match");
    expect(runtime.install).not.toHaveBeenCalled();
    expect(io.current()["security-review@company-tools"]?.enabled).toBe(false);
    expect(io.current().legacy?.enabled).toBe(false);
  });

  it("allows operator.admin installation but rejects ordinary users before catalog access", async () => {
    const io = inMemoryIO();
    const runtime = pluginRuntime({ marketplacePath: "/repo/marketplace.json" });
    const denied = { ...fakeCtx, senderIsOwner: false, gatewayClientScopes: ["operator.write"] };

    const rejected = await handleCodexPluginsSubcommand(
      denied,
      ["install", "security-review@company-tools"],
      io,
      runtime,
    );
    expect(rejected.text).toContain("Only an owner or operator.admin");
    expect(runtime.workspaceDir).not.toHaveBeenCalled();
    expect(runtime.list).not.toHaveBeenCalled();
    expect(runtime.install).not.toHaveBeenCalled();

    const allowed = await handleCodexPluginsSubcommand(
      { ...fakeCtx, senderIsOwner: false, gatewayClientScopes: ["operator.admin"] },
      ["install", "security-review@company-tools"],
      io,
      runtime,
    );
    expect(allowed.text).toContain("installed and authorized");
    expect(runtime.install).toHaveBeenCalledOnce();
  });

  it("does not mutate explicit plugin authorization when Codex installation fails", async () => {
    const io = inMemoryIO({}, { enabled: false });
    const runtime = pluginRuntime({
      marketplacePath: "/repo/marketplace.json",
      install: vi.fn(async () => {
        throw new Error("workspace administrator rejected installation");
      }),
    });

    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "security-review@company-tools"],
      io,
      runtime,
    );

    expect(result.text).toContain("workspace administrator rejected installation");
    expect(io.currentConfig()).toEqual({ enabled: false, plugins: {} });
  });

  it("reports successful installation separately when authorization persistence fails", async () => {
    const io = {
      ...inMemoryIO(),
      mutate: vi.fn(async () => {
        throw new Error("config file is read-only");
      }),
    };
    const runtime = pluginRuntime({ marketplacePath: "/repo/marketplace.json" });

    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "security-review@company-tools"],
      io,
      runtime,
    );

    expect(result.text).toContain("installed in Codex but could not be authorized");
    expect(result.text).toContain("will not be exposed");
  });

  it("preserves app setup links without undoing owner authorization", async () => {
    const io = inMemoryIO();
    const installUrl = "https://chatgpt.com/apps/github/connector_github";
    const runtime = pluginRuntime({
      marketplacePath: "/repo/marketplace.json",
      install: vi.fn(async () => ({
        authPolicy: "ON_INSTALL",
        appsNeedingAuth: [
          { id: "github", name: "GitHub", description: null, installUrl, category: null },
        ],
      })),
    });

    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "security-review@company-tools"],
      io,
      runtime,
    );

    expect(result.text).toContain("1 app still requires connector authentication");
    expect(result.text).toContain(installUrl);
    expect(result.presentation?.blocks).toContainEqual({
      type: "buttons",
      buttons: [{ label: "Set up / manage GitHub", action: { type: "url", url: installUrl } }],
    });
    expect(io.current()["security-review@company-tools"]?.enabled).toBe(true);
  });

  it("preserves the returned hosted origin and URL punctuation in setup links", async () => {
    const installUrl =
      "https://preview.chatgpt-staging.com/apps/github/connector_github?source=app&view=setup#details";
    const runtime = pluginRuntime({
      marketplacePath: "/repo/marketplace.json",
      install: vi.fn(async () => ({
        authPolicy: "ON_INSTALL",
        appsNeedingAuth: [
          { id: "github", name: "GitHub", description: null, installUrl, category: null },
        ],
      })),
    });

    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "security-review@company-tools"],
      inMemoryIO(),
      runtime,
    );

    expect(result.text).toContain(installUrl);
    expect(result.text).toContain("same ChatGPT account and workspace as Codex");
    expect(result.text).toContain("does not confirm that it is connected or callable");
    expect(result.presentation?.blocks).toContainEqual({
      type: "buttons",
      buttons: [{ label: "Set up / manage GitHub", action: { type: "url", url: installUrl } }],
    });
    expect(result.presentationTextMode).toBe("fallback");
  });

  it.each([
    null,
    "not a URL",
    "javascript:alert(1)",
    "http://chatgpt.com/apps/github/github",
    "https://fixture-user@chatgpt.com/apps/github/github",
    "https://chatgpt.com.evil.example/apps/github/github",
    "https://evilchatgpt.com/apps/github/github",
    "https://chatgpt.com/\u0000apps/github/github",
    `https://chatgpt.com/apps/${"x".repeat(2048)}`,
  ])("gives a manual setup path without exposing unsafe or missing URL %j", async (installUrl) => {
    const io = inMemoryIO();
    const runtime = pluginRuntime({
      marketplacePath: "/repo/marketplace.json",
      install: vi.fn(async () => ({
        authPolicy: "ON_INSTALL",
        appsNeedingAuth: [
          { id: "github", name: "GitHub", description: null, installUrl, category: null },
        ],
      })),
    });

    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "security-review@company-tools"],
      io,
      runtime,
    );

    expect(result.text).toContain("GitHub: setup/manage link unavailable");
    expect(result.text).toContain("In Codex CLI, run /apps and select this app");
    expect(result.presentation?.blocks.some((block) => block.type === "buttons")).toBe(false);
    if (installUrl) {
      expect(result.text).not.toContain(installUrl);
    }
    expect(io.current()["security-review@company-tools"]?.enabled).toBe(true);
  });

  it("bounds app setup output and accounts for apps beyond the displayed links", async () => {
    const runtime = pluginRuntime({
      marketplacePath: "/repo/marketplace.json",
      install: vi.fn(async () => ({
        authPolicy: "ON_INSTALL",
        appsNeedingAuth: Array.from({ length: 7 }, (_, index) => ({
          id: `app-${index}`,
          name: `App ${index}`,
          description: null,
          installUrl: `https://chatgpt.com/apps/app-${index}/app-${index}`,
          category: null,
        })),
      })),
    });

    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "security-review@company-tools"],
      inMemoryIO(),
      runtime,
    );

    const buttons = result.presentation?.blocks.flatMap((block) =>
      block.type === "buttons" ? block.buttons : [],
    );
    expect(buttons).toHaveLength(5);
    expect(buttons?.map((button) => button.label)).toEqual([
      "Set up / manage App 0",
      "Set up / manage App 1",
      "Set up / manage App 2",
      "Set up / manage App 3",
      "Set up / manage App 4",
    ]);
    expect(result.text).toContain("7 apps still require connector authentication");
    expect(result.text).toContain("2 more apps are not shown");
    expect(result.text).toContain("In Codex CLI, run /apps to review the remaining apps");
  });

  it("supports qualified identifiers when enabling a legacy configured plugin key", async () => {
    const io = inMemoryIO({
      security: {
        enabled: false,
        marketplaceName: "company-tools",
        pluginName: "security-review",
      },
    });

    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["enable", "security-review@company-tools"],
      io,
    );

    expect(result.text).toContain("security: enabled");
    expect(io.current().security?.enabled).toBe(true);
  });

  it("rejects unsafe or ambiguous marketplace identifiers before contacting Codex", async () => {
    const runtime = pluginRuntime({ marketplacePath: "/repo/marketplace.json" });

    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["install", "../plugin@company-tools"],
      inMemoryIO(),
      runtime,
    );

    expect(result.text).toContain("Invalid plugin identifier");
    expect(runtime.list).not.toHaveBeenCalled();
  });

  it("escapes configured plugin fields before listing them in chat", async () => {
    const io = inMemoryIO({
      "google-calendar": {
        enabled: true,
        marketplaceName: "openai-curated",
        pluginName: "google-calendar_@team_*name*",
      },
    });

    const result = await handleCodexPluginsSubcommand(fakeCtx, ["list"], io);
    expect(result.text).toContain("google-calendar");
    expect(result.text).toContain("google-calendar＿＠team＿∗name∗");
    expect(result.text).not.toContain("@team");
    expect(result.text).not.toContain("*name*");
  });

  it("reports when a target plugin is not configured rather than silently no-oping", async () => {
    const io = inMemoryIO();
    const result = await handleCodexPluginsSubcommand(fakeCtx, ["disable", "chrome_@ops"], io);
    expect(result.text).toContain("not configured");
    expect(result.text).toContain("chrome＿＠ops");
    expect(result.text).not.toContain("@ops");
  });

  it("returns usage when list, menu, enable, or disable receives the wrong arity", async () => {
    const io = inMemoryIO();
    const listResult = await handleCodexPluginsSubcommand(fakeCtx, ["list", "chrome"], io);
    expect(listResult.text).toContain("Usage: /codex plugins list");

    const menuResult = await handleCodexPluginsSubcommand(fakeCtx, ["menu", "extra"], io);
    expect(menuResult.text).toContain("Usage: /codex plugins menu");

    const extraResult = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["enable", "google-calendar", "extra"],
      io,
    );
    expect(extraResult.text).toContain("Usage: /codex plugins enable <name>");
  });
});
