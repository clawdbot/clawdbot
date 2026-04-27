import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexComputerUseSetupError,
  ensureCodexComputerUse,
  installCodexComputerUse,
  readCodexComputerUseStatus,
  type CodexComputerUseRequest,
} from "./computer-use.js";

describe("Codex Computer Use setup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays disabled until configured", async () => {
    await expect(
      readCodexComputerUseStatus({ pluginConfig: {}, request: vi.fn() }),
    ).resolves.toEqual(
      expect.objectContaining({
        enabled: false,
        ready: false,
        message: "Computer Use is disabled.",
      }),
    );
  });

  it("reports an installed Computer Use MCP server from a registered marketplace", async () => {
    const request = createComputerUseRequest({ installed: true });

    await expect(
      readCodexComputerUseStatus({
        pluginConfig: { computerUse: { enabled: true, marketplaceName: "desktop-tools" } },
        request,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        enabled: true,
        ready: true,
        installed: true,
        pluginEnabled: true,
        mcpServerAvailable: true,
        marketplaceName: "desktop-tools",
        tools: ["list_apps"],
        message: "Computer Use is ready.",
      }),
    );
    expect(request).not.toHaveBeenCalledWith("marketplace/add", expect.anything());
    expect(request).not.toHaveBeenCalledWith(
      "experimentalFeature/enablement/set",
      expect.anything(),
    );
    expect(request).not.toHaveBeenCalledWith("plugin/install", expect.anything());
  });

  it("does not register marketplace sources during status checks", async () => {
    const request = createComputerUseRequest({ installed: true });

    await expect(
      readCodexComputerUseStatus({
        pluginConfig: {
          computerUse: {
            enabled: true,
            marketplaceSource: "github:example/desktop-tools",
          },
        },
        request,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ready: true,
        message: "Computer Use is ready.",
      }),
    );
    expect(request).not.toHaveBeenCalledWith("marketplace/add", expect.anything());
    expect(request).not.toHaveBeenCalledWith(
      "experimentalFeature/enablement/set",
      expect.anything(),
    );
  });

  it("fails closed when multiple marketplaces contain Computer Use", async () => {
    const request = createAmbiguousComputerUseRequest();

    await expect(
      readCodexComputerUseStatus({
        pluginConfig: { computerUse: { enabled: true } },
        request,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ready: false,
        message:
          "Multiple Codex marketplaces contain computer-use. Configure computerUse.marketplaceName or computerUse.marketplacePath to choose one.",
      }),
    );
    expect(request).not.toHaveBeenCalledWith("plugin/read", expect.anything());
  });

  it("installs Computer Use from a configured marketplace source", async () => {
    const request = createComputerUseRequest({ installed: false });

    await expect(
      installCodexComputerUse({
        pluginConfig: {
          computerUse: {
            marketplaceSource: "github:example/desktop-tools",
          },
        },
        request,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ready: true,
        installed: true,
        pluginEnabled: true,
        tools: ["list_apps"],
      }),
    );
    expect(request).toHaveBeenCalledWith("experimentalFeature/enablement/set", {
      enablement: { plugins: true },
    });
    expect(request).toHaveBeenCalledWith("marketplace/add", {
      source: "github:example/desktop-tools",
    });
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
      pluginName: "computer-use",
    });
    expect(request).toHaveBeenCalledWith("config/mcpServer/reload", undefined);
  });

  it("fails closed when Computer Use is required but not installed", async () => {
    const request = createComputerUseRequest({ installed: false });

    await expect(
      ensureCodexComputerUse({
        pluginConfig: { computerUse: { enabled: true, marketplaceName: "desktop-tools" } },
        request,
      }),
    ).rejects.toThrow(CodexComputerUseSetupError);
    expect(request).not.toHaveBeenCalledWith("plugin/install", expect.anything());
  });

  it("skips setup writes when auto-install is already ready", async () => {
    const request = createComputerUseRequest({ installed: true });

    await expect(
      ensureCodexComputerUse({
        pluginConfig: {
          computerUse: {
            enabled: true,
            autoInstall: true,
            marketplaceName: "desktop-tools",
          },
        },
        request,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ready: true,
        message: "Computer Use is ready.",
      }),
    );
    expect(request).not.toHaveBeenCalledWith("marketplace/add", expect.anything());
    expect(request).not.toHaveBeenCalledWith(
      "experimentalFeature/enablement/set",
      expect.anything(),
    );
    expect(request).not.toHaveBeenCalledWith("plugin/install", expect.anything());
  });

  it("uses setup writes when auto-install needs to install", async () => {
    const request = createComputerUseRequest({ installed: false });

    await expect(
      ensureCodexComputerUse({
        pluginConfig: {
          computerUse: {
            enabled: true,
            autoInstall: true,
          },
        },
        request,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ready: true,
        message: "Computer Use is ready.",
      }),
    );
    expect(request).toHaveBeenCalledWith("experimentalFeature/enablement/set", {
      enablement: { plugins: true },
    });
    expect(request).not.toHaveBeenCalledWith("marketplace/add", expect.anything());
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
      pluginName: "computer-use",
    });
  });

  it("requires an explicit install command for configured marketplace sources", async () => {
    const request = createComputerUseRequest({ installed: false });

    await expect(
      ensureCodexComputerUse({
        pluginConfig: {
          computerUse: {
            enabled: true,
            autoInstall: true,
            marketplaceSource: "github:example/desktop-tools",
          },
        },
        request,
      }),
    ).rejects.toThrow(CodexComputerUseSetupError);
    expect(request).not.toHaveBeenCalledWith("marketplace/add", expect.anything());
    expect(request).not.toHaveBeenCalledWith("plugin/install", expect.anything());
  });

  it("fails closed when a configured marketplace name is not discovered", async () => {
    const request = createEmptyMarketplaceComputerUseRequest();

    await expect(
      readCodexComputerUseStatus({
        pluginConfig: {
          computerUse: {
            enabled: true,
            marketplaceName: "missing-marketplace",
          },
        },
        request,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ready: false,
        message:
          "Configured Codex marketplace missing-marketplace was not found or does not contain computer-use. Run /codex computer-use install with a source or path to install from a new marketplace.",
      }),
    );
    expect(request).not.toHaveBeenCalledWith("plugin/read", expect.anything());
  });

  it("waits for the default Codex marketplace during install", async () => {
    vi.useFakeTimers();
    const request = createComputerUseRequest({
      installed: false,
      marketplaceAvailableAfterListCalls: 3,
    });
    const installed = installCodexComputerUse({
      pluginConfig: { computerUse: {} },
      request,
    });

    await vi.advanceTimersByTimeAsync(4_000);

    await expect(installed).resolves.toEqual(
      expect.objectContaining({
        ready: true,
        message: "Computer Use is ready.",
      }),
    );
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
      pluginName: "computer-use",
    });
    expect(
      vi.mocked(request).mock.calls.filter(([method]) => method === "plugin/list"),
    ).toHaveLength(3);
  });

  it("prefers the official Computer Use marketplace when multiple matches are present", async () => {
    const request = createMultiMarketplaceComputerUseRequest();

    await expect(
      installCodexComputerUse({
        pluginConfig: { computerUse: {} },
        request,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ready: true,
        marketplaceName: "openai-curated",
      }),
    );
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: "/marketplaces/openai-curated/.agents/plugins/marketplace.json",
      pluginName: "computer-use",
    });
  });
});

function createComputerUseRequest(params: {
  installed: boolean;
  marketplaceAvailableAfterListCalls?: number;
}): CodexComputerUseRequest {
  let installed = params.installed;
  let pluginListCalls = 0;
  return vi.fn(async (method: string, requestParams?: unknown) => {
    if (method === "experimentalFeature/enablement/set") {
      return { enablement: { plugins: true } };
    }
    if (method === "marketplace/add") {
      return {
        marketplaceName: "desktop-tools",
        installedRoot: "/marketplaces/desktop-tools",
        alreadyAdded: false,
      };
    }
    if (method === "plugin/list") {
      pluginListCalls += 1;
      const marketplaceAvailable =
        pluginListCalls >= (params.marketplaceAvailableAfterListCalls ?? 1);
      return {
        marketplaces: marketplaceAvailable
          ? [
              {
                name: "desktop-tools",
                path: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
                interface: null,
                plugins: [pluginSummary(installed)],
              },
            ]
          : [],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      };
    }
    if (method === "plugin/read") {
      expect(requestParams).toEqual(
        expect.objectContaining({
          pluginName: "computer-use",
        }),
      );
      return {
        plugin: {
          marketplaceName: "desktop-tools",
          marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
          summary: pluginSummary(installed),
          description: "Control desktop apps.",
          skills: [],
          apps: [],
          mcpServers: ["computer-use"],
        },
      };
    }
    if (method === "plugin/install") {
      installed = true;
      return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] };
    }
    if (method === "config/mcpServer/reload") {
      return undefined;
    }
    if (method === "mcpServerStatus/list") {
      return {
        data: installed
          ? [
              {
                name: "computer-use",
                tools: {
                  list_apps: {
                    name: "list_apps",
                    inputSchema: { type: "object" },
                  },
                },
                resources: [],
                resourceTemplates: [],
                authStatus: "unsupported",
              },
            ]
          : [],
        nextCursor: null,
      };
    }
    throw new Error(`unexpected request ${method}`);
  }) as CodexComputerUseRequest;
}

function createAmbiguousComputerUseRequest(): CodexComputerUseRequest {
  return vi.fn(async (method: string) => {
    if (method === "plugin/list") {
      return {
        marketplaces: [
          {
            name: "desktop-tools",
            path: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
            interface: null,
            plugins: [pluginSummary(true, "desktop-tools")],
          },
          {
            name: "other-tools",
            path: "/marketplaces/other-tools/.agents/plugins/marketplace.json",
            interface: null,
            plugins: [pluginSummary(true, "other-tools")],
          },
        ],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      };
    }
    throw new Error(`unexpected request ${method}`);
  }) as CodexComputerUseRequest;
}

function createEmptyMarketplaceComputerUseRequest(): CodexComputerUseRequest {
  return vi.fn(async (method: string) => {
    if (method === "plugin/list") {
      return {
        marketplaces: [],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      };
    }
    throw new Error(`unexpected request ${method}`);
  }) as CodexComputerUseRequest;
}

function createMultiMarketplaceComputerUseRequest(): CodexComputerUseRequest {
  let installed = false;
  return vi.fn(async (method: string, requestParams?: unknown) => {
    if (method === "experimentalFeature/enablement/set") {
      return { enablement: { plugins: true } };
    }
    if (method === "plugin/list") {
      return {
        marketplaces: [
          marketplaceEntry("workspace-tools", false),
          marketplaceEntry("openai-curated", installed),
        ],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      };
    }
    if (method === "plugin/read") {
      return {
        plugin: {
          marketplaceName: "openai-curated",
          marketplacePath: "/marketplaces/openai-curated/.agents/plugins/marketplace.json",
          summary: pluginSummary(installed, "openai-curated"),
          description: "Control desktop apps.",
          skills: [],
          apps: [],
          mcpServers: ["computer-use"],
        },
      };
    }
    if (method === "plugin/install") {
      expect(requestParams).toEqual({
        marketplacePath: "/marketplaces/openai-curated/.agents/plugins/marketplace.json",
        pluginName: "computer-use",
      });
      installed = true;
      return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] };
    }
    if (method === "config/mcpServer/reload") {
      return undefined;
    }
    if (method === "mcpServerStatus/list") {
      return {
        data: installed
          ? [
              {
                name: "computer-use",
                tools: {
                  list_apps: {
                    name: "list_apps",
                    inputSchema: { type: "object" },
                  },
                },
                resources: [],
                resourceTemplates: [],
                authStatus: "unsupported",
              },
            ]
          : [],
        nextCursor: null,
      };
    }
    throw new Error(`unexpected request ${method}`);
  }) as CodexComputerUseRequest;
}

function marketplaceEntry(marketplaceName: string, installed: boolean) {
  return {
    name: marketplaceName,
    path: `/marketplaces/${marketplaceName}/.agents/plugins/marketplace.json`,
    interface: null,
    plugins: [pluginSummary(installed, marketplaceName)],
  };
}

function pluginSummary(installed: boolean, marketplaceName = "desktop-tools") {
  return {
    id: `computer-use@${marketplaceName}`,
    name: "computer-use",
    source: { type: "local", path: `/marketplaces/${marketplaceName}/plugins/computer-use` },
    installed,
    enabled: installed,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_INSTALL",
    interface: null,
  };
}
