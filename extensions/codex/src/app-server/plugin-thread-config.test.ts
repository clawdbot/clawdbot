// Codex tests cover plugin thread config plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache, defaultCodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import {
  CODEX_PLUGINS_MARKETPLACE_NAME,
  CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
} from "./config.js";
import { resolveRecoverableCodexPluginConfigKeys } from "./plugin-inventory.js";
import { CodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import { createCodexPluginThreadConfigStartupProvider } from "./plugin-thread-config-deadline.js";
import {
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  buildCodexPluginThreadConfig,
  buildCodexPluginThreadConfigInputFingerprint,
  buildCodexPluginThreadConfigTimeoutFallback,
  isCodexPluginThreadBindingStale,
  mergeCodexThreadConfigs,
  shouldBuildCodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import type { CodexAppServerRequestParams, JsonObject, v2 } from "./protocol.js";

describe("Codex plugin thread config", () => {
  beforeEach(() => {
    defaultCodexAppInventoryCache.clear();
  });

  it("defaults destructive app access on for accessible migrated plugin apps", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) =>
        codexAppInventoryResponse(method, [appInfo("google-calendar-app", true)], params),
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method) => {
        if (method === "config/read") {
          return { config: {}, layers: [] };
        }
        if (method === "plugin/installed") {
          return pluginInstalled([
            pluginSummary("google-calendar", { installed: true, enabled: true }),
          ]);
        }
        if (method === "plugin/read") {
          return pluginDetail(
            "google-calendar",
            [appSummary("google-calendar-app")],
            ["google-calendar"],
          );
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
        "google-calendar-app": {
          enabled: true,
          destructive_enabled: true,
          open_world_enabled: true,
          default_tools_approval_mode: "auto",
        },
      },
    });
    expect(config.configPatch).not.toHaveProperty("approvals_reviewer");
    const apps = config.configPatch?.apps as Record<string, unknown> | undefined;
    expect(apps?.["_default"]).not.toHaveProperty("approvals_reviewer");
    expect(config.policyContext.apps["google-calendar-app"]).toEqual({
      configKey: "google-calendar",
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
      pluginName: "google-calendar",
      allowDestructiveActions: true,
      allowOpenWorld: true,
      destructiveApprovalMode: "allow",
      mcpServerNames: ["google-calendar"],
    });
    expect(config.diagnostics).toStrictEqual([]);
  });

  it("reuses the existing app policy path for an active workspace plugin", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) =>
        codexAppInventoryResponse(method, [appInfo("workspace-data-app", true)], params),
    });
    const methods: string[] = [];

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            workspaceData: {
              marketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
              pluginName: "workspace-data@workspace-directory",
              allow_destructive_actions: false,
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method, params) => {
        methods.push(method);
        if (method === "config/read") {
          return { config: {}, layers: [] };
        }
        if (method === "plugin/installed") {
          expect(params).toEqual({});
          return pluginInstalled(
            [
              pluginSummary("workspace-data@workspace-directory", {
                remotePluginId: "plugin_workspace_data",
                installed: true,
                enabled: true,
              }),
            ],
            { name: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME, path: null },
          );
        }
        if (method === "plugin/read") {
          expect(params).toEqual({
            remoteMarketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
            pluginName: "plugin_workspace_data",
          });
          return pluginDetail("workspace-data", [appSummary("workspace-data-app")], [], {
            marketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
            marketplacePath: null,
          });
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(methods).toStrictEqual(["plugin/installed", "plugin/read", "config/read"]);
    expect(config.configPatch?.apps).toEqual({
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
      "workspace-data-app": {
        enabled: true,
        destructive_enabled: false,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
      },
    });
    expect(config.policyContext.apps["workspace-data-app"]).toMatchObject({
      configKey: "workspaceData",
      marketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
      pluginName: "workspace-data@workspace-directory",
      destructiveApprovalMode: "deny",
    });
    expect(config.diagnostics).toStrictEqual([]);
  });

  it("exposes an owner-installed repository plugin and its authorized GitHub app", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) =>
        codexAppInventoryResponse(method, [appInfo("github-app", true)], params),
    });
    const methods: string[] = [];

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "security-review@company-tools": {
              marketplaceName: "company-tools",
              pluginName: "security-review",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      configCwd: "/repo/company",
      nowMs: 1,
      request: async (method, params) => {
        methods.push(method);
        if (method === "plugin/installed") {
          expect(params).toEqual({ cwds: ["/repo/company"] });
          return pluginInstalled(
            [pluginSummary("security-review", { installed: true, enabled: true })],
            {
              name: "company-tools",
              path: "/repo/company/.agents/plugins/marketplace.json",
            },
          );
        }
        if (method === "plugin/read") {
          expect(params).toEqual({
            marketplacePath: "/repo/company/.agents/plugins/marketplace.json",
            pluginName: "security-review",
          });
          return pluginDetail("security-review", [appSummary("github-app")], ["github"], {
            marketplaceName: "company-tools",
            marketplacePath: "/repo/company/.agents/plugins/marketplace.json",
          });
        }
        if (method === "config/read") {
          expect(params).toEqual({ includeLayers: true, cwd: "/repo/company" });
          return { config: {}, layers: [] };
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(methods).toEqual(["plugin/installed", "plugin/read", "config/read"]);
    expect(config.policyContext.apps["github-app"]).toMatchObject({
      configKey: "security-review@company-tools",
      marketplaceName: "company-tools",
      pluginName: "security-review",
      mcpServerNames: ["github"],
    });
    expect(config.diagnostics).toEqual([]);
  });

  it("does not silently install an uninstalled repository plugin during a model turn", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) => codexAppInventoryResponse(method, [], params),
    });
    const requests: string[] = [];

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "security-review@company-tools": {
              marketplaceName: "company-tools",
              pluginName: "security-review",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      configCwd: "/repo/company",
      nowMs: 1,
      request: async (method, params) => {
        requests.push(method);
        if (method === "plugin/installed") {
          expect(params).toEqual({ cwds: ["/repo/company"] });
          return {
            marketplaces: [],
            marketplaceLoadErrors: [],
          } satisfies v2.PluginInstalledResponse;
        }
        if (method === "plugin/list") {
          expect(params).toEqual({ cwds: ["/repo/company"] });
          return pluginList(
            [pluginSummary("security-review", { installed: false, enabled: false })],
            {
              name: "company-tools",
              path: "/repo/company/.agents/plugins/marketplace.json",
            },
          );
        }
        if (method === "plugin/read") {
          return pluginDetail("security-review", [], [], {
            marketplaceName: "company-tools",
            marketplacePath: "/repo/company/.agents/plugins/marketplace.json",
          });
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(requests).not.toContain("plugin/install");
    expect(config.configPatch?.apps).toEqual({
      _default: { enabled: false, destructive_enabled: false, open_world_enabled: false },
    });
    expect(config.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "plugin_activation_failed",
        message: expect.stringContaining("/codex plugins install security-review@company-tools"),
      }),
    );
  });

  it("does not silently reactivate an owner-installed but disabled repository plugin", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) => codexAppInventoryResponse(method, [], params),
    });
    const methods: string[] = [];

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "security-review@company-tools": {
              marketplaceName: "company-tools",
              pluginName: "security-review",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      configCwd: "/repo/company",
      nowMs: 1,
      request: async (method) => {
        methods.push(method);
        if (method === "plugin/installed") {
          return pluginInstalled(
            [pluginSummary("security-review", { installed: true, enabled: false })],
            {
              name: "company-tools",
              path: "/repo/company/.agents/plugins/marketplace.json",
            },
          );
        }
        if (method === "plugin/read") {
          return pluginDetail("security-review", [], [], {
            marketplaceName: "company-tools",
            marketplacePath: "/repo/company/.agents/plugins/marketplace.json",
          });
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(methods).toEqual(["plugin/installed", "plugin/read"]);
    expect(methods).not.toContain("plugin/install");
    expect(config.configPatch?.apps).toEqual({
      _default: { enabled: false, destructive_enabled: false, open_world_enabled: false },
    });
    expect(config.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "plugin_activation_failed",
        message: expect.stringContaining("/codex plugins install security-review@company-tools"),
      }),
    );
  });

  it("maps destructive app access from global and per-plugin policy", async () => {
    const pluginOverrideDisabled = await buildReadyGoogleCalendarThreadConfig({
      codexPlugins: {
        enabled: true,
        allow_destructive_actions: true,
        plugins: {
          "google-calendar": {
            marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
            pluginName: "google-calendar",
            allow_destructive_actions: false,
          },
        },
      },
    });

    const disabledApps = pluginOverrideDisabled.configPatch?.apps as
      | Record<string, unknown>
      | undefined;
    expect(disabledApps?.["google-calendar-app"]).toEqual({
      enabled: true,
      destructive_enabled: false,
      open_world_enabled: true,
      default_tools_approval_mode: "auto",
    });
    expect(disabledApps?.["google-calendar-app"]).not.toHaveProperty("default_tools_enabled");
    expect(disabledApps?.["google-calendar-app"]).not.toHaveProperty("approvals_reviewer");
    expect(disabledApps?.["google-calendar-app"]).not.toHaveProperty("tools");
    expect(
      pluginOverrideDisabled.policyContext.apps["google-calendar-app"]?.allowDestructiveActions,
    ).toBe(false);
    expect(
      pluginOverrideDisabled.policyContext.apps["google-calendar-app"]?.destructiveApprovalMode,
    ).toBe("deny");

    const pluginOverrideEnabled = await buildReadyGoogleCalendarThreadConfig({
      codexPlugins: {
        enabled: true,
        allow_destructive_actions: false,
        plugins: {
          "google-calendar": {
            marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
            pluginName: "google-calendar",
            allow_destructive_actions: true,
          },
        },
      },
    });

    const enabledApps = pluginOverrideEnabled.configPatch?.apps as
      | Record<string, unknown>
      | undefined;
    expect(enabledApps?.["google-calendar-app"]).toEqual({
      enabled: true,
      destructive_enabled: true,
      open_world_enabled: true,
      default_tools_approval_mode: "auto",
    });
    expect(enabledApps?.["google-calendar-app"]).not.toHaveProperty("approvals_reviewer");
    expect(
      pluginOverrideEnabled.policyContext.apps["google-calendar-app"]?.allowDestructiveActions,
    ).toBe(true);
    expect(
      pluginOverrideEnabled.policyContext.apps["google-calendar-app"]?.destructiveApprovalMode,
    ).toBe("allow");
  });

  it("exposes destructive app access while marking auto approval mode", async () => {
    const config = await buildReadyGoogleCalendarThreadConfig({
      codexPlugins: {
        enabled: true,
        allow_destructive_actions: "auto",
        plugins: {
          "google-calendar": {
            marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
            pluginName: "google-calendar",
          },
        },
      },
    });

    const apps = config.configPatch?.apps as Record<string, unknown> | undefined;
    expect(apps?.["google-calendar-app"]).toEqual({
      enabled: true,
      destructive_enabled: true,
      open_world_enabled: true,
      default_tools_approval_mode: "auto",
    });
    expect(apps?.["google-calendar-app"]).not.toHaveProperty("approvals_reviewer");
    expect(config.policyContext.apps["google-calendar-app"]).toMatchObject({
      allowDestructiveActions: true,
      destructiveApprovalMode: "auto",
    });
  });

  it("routes destructive approvals to the user while clearing durable overrides for always mode", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) =>
        codexAppInventoryResponse(method, [appInfo("google-calendar-app", true)], params),
    });
    let configReadCount = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginDetail(
          "google-calendar",
          [appSummary("google-calendar-app")],
          ["google-calendar"],
        );
      }
      if (method === "config/read") {
        configReadCount += 1;
        if ((params as { includeLayers?: boolean } | undefined)?.includeLayers !== true) {
          return {
            config: {
              apps: {
                "google-calendar-app": {
                  tools: {
                    "calendar/read": {
                      enabled: false,
                    },
                  },
                },
              },
            },
          };
        }
        return {
          config: {
            apps: {
              "google-calendar-app": {
                tools: {
                  "calendar/create": {
                    approval_mode: "approve",
                    enabled: false,
                  },
                  "calendar/read": {
                    enabled: false,
                  },
                  "calendar/update": {
                    approval_mode: "approve",
                  },
                },
              },
            },
          },
          layers: [],
        };
      }
      if (method === "config/batchWrite") {
        return {
          status: "ok",
          version: "version-1",
          filePath: "/home/test/.codex/config.toml",
          overriddenMetadata: null,
        };
      }
      throw new Error(`unexpected request ${method}`);
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          allow_destructive_actions: "ask",
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request,
    });

    const apps = config.configPatch?.apps as Record<string, unknown> | undefined;
    expect(apps?.["google-calendar-app"]).toEqual({
      enabled: true,
      approvals_reviewer: "user",
      destructive_enabled: true,
      open_world_enabled: true,
      default_tools_approval_mode: "auto",
    });
    expect(config.configPatch).not.toHaveProperty("approvals_reviewer");
    expect(config.policyContext.apps["google-calendar-app"]).toMatchObject({
      allowDestructiveActions: true,
      destructiveApprovalMode: "ask",
    });
    expect(request).toHaveBeenCalledWith("config/read", { includeLayers: false });
    expect(request.mock.calls.filter(([method]) => method === "config/read")).toHaveLength(2);
    expect(request).toHaveBeenCalledWith("config/batchWrite", {
      edits: [
        {
          keyPath: 'apps."google-calendar-app".tools."calendar/create".approval_mode',
          value: null,
          mergeStrategy: "replace",
        },
        {
          keyPath: 'apps."google-calendar-app".tools."calendar/update".approval_mode',
          value: null,
          mergeStrategy: "replace",
        },
      ],
    });
    expect(request.mock.calls.map(([method]) => method)).not.toContain("config/value/write");
  });

  it.each([
    ["auto", "auto", undefined],
    ["boolean true", true, undefined],
    ["boolean false", false, undefined],
    ["ask", "ask", "user"],
  ] as const)(
    "applies the resolved per-plugin %s reviewer policy over global ask",
    async (_name, pluginOverride, expectedReviewer) => {
      const config = await buildReadyGoogleCalendarThreadConfig({
        codexPlugins: {
          enabled: true,
          allow_destructive_actions: "ask",
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
              allow_destructive_actions: pluginOverride,
            },
          },
        },
      });

      const apps = config.configPatch?.apps as Record<string, unknown> | undefined;
      const app = apps?.["google-calendar-app"] as Record<string, unknown> | undefined;
      expect(app?.approvals_reviewer).toBe(expectedReviewer);
      expect(config.policyContext.apps["google-calendar-app"]?.destructiveApprovalMode).toBe(
        pluginOverride === true ? "allow" : pluginOverride === false ? "deny" : pluginOverride,
      );
    },
  );

  it("rebuilds persisted app policy with the same reviewer precedence", () => {
    const configPatch = buildCodexPluginAppsConfigPatchFromPolicyContext({
      fingerprint: "policy",
      apps: {
        "ask-app": {
          configKey: "ask",
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "ask",
          allowDestructiveActions: true,
          destructiveApprovalMode: "ask",
          mcpServerNames: ["ask"],
        },
        "auto-app": {
          configKey: "auto",
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "auto",
          allowDestructiveActions: true,
          destructiveApprovalMode: "auto",
          mcpServerNames: ["auto"],
        },
      },
      pluginAppIds: {
        ask: ["ask-app"],
        auto: ["auto-app"],
      },
    });

    expect(configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
        "ask-app": {
          enabled: true,
          approvals_reviewer: "user",
          destructive_enabled: true,
          open_world_enabled: true,
          default_tools_approval_mode: "auto",
        },
        "auto-app": {
          enabled: true,
          destructive_enabled: true,
          open_world_enabled: true,
          default_tools_approval_mode: "auto",
        },
      },
    });
    expect(configPatch).not.toHaveProperty("approvals_reviewer");
  });

  it("keeps ask policy apps when managed approval overrides cover only read-only tools", async () => {
    const appCache = new CodexAppInventoryCache();
    const linearApp: v2.AppInfo = {
      ...appInfo("linear", true),
      toolSummaries: [
        {
          name: "fetch",
          title: "Fetch",
          description: "Fetch a Linear issue.",
          isEnabled: true,
          disabledReason: null,
          isReadOnly: true,
        },
        {
          name: "save_issue",
          title: "linear/save_issue",
          description: "Create or update a Linear issue.",
          isEnabled: true,
          disabledReason: null,
          isReadOnly: false,
        },
      ],
    };
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) => codexAppInventoryResponse(method, [linearApp], params),
    });
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginList([pluginSummary("linear", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginDetail("linear", [appSummary("linear")], ["linear"]);
      }
      if (method === "config/read") {
        expect(params).toEqual({ includeLayers: true, cwd: "/repo/project" });
        return {
          config: {
            apps: {
              linear: {
                tools: {
                  linear_fetch: { approval_mode: "approve" },
                },
              },
            },
          },
          layers: [],
        };
      }
      throw new Error(`unexpected request ${method}`);
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          allow_destructive_actions: "ask",
          plugins: {
            linear: {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "linear",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      configCwd: "/repo/project",
      nowMs: 1,
      request,
    });

    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
        linear: {
          enabled: true,
          approvals_reviewer: "user",
          destructive_enabled: true,
          open_world_enabled: true,
          default_tools_approval_mode: "auto",
        },
      },
    });
    expect(config.provisionalAppIds).toEqual(["linear"]);
    expect(config.diagnostics).toStrictEqual([]);
    expect(request.mock.calls.filter(([method]) => method === "config/read")).toHaveLength(1);
    expect(request.mock.calls.map(([method]) => method)).not.toContain("config/batchWrite");
  });

  it("omits ask policy apps when cwd effective approval overrides remain after cleanup", async () => {
    const appCache = new CodexAppInventoryCache();
    const calendarApp: v2.AppInfo = {
      ...appInfo("google-calendar-app", true),
      toolSummaries: [
        {
          name: "calendar/create",
          title: null,
          description: "Create a calendar event.",
          isEnabled: true,
          disabledReason: null,
          isReadOnly: false,
        },
      ],
    };
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) => codexAppInventoryResponse(method, [calendarApp], params),
    });
    let configReadCount = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginDetail(
          "google-calendar",
          [appSummary("google-calendar-app")],
          ["google-calendar"],
        );
      }
      if (method === "config/read") {
        const includeLayers =
          (params as { includeLayers?: boolean } | undefined)?.includeLayers === true;
        configReadCount += 1;
        return {
          config: {
            apps: {
              "google-calendar-app": {
                tools: {
                  "calendar/create": {
                    approval_mode: "approve",
                    source: includeLayers ? "user" : "project",
                  },
                },
              },
            },
          },
          ...(includeLayers ? { layers: [] } : {}),
        };
      }
      if (method === "config/batchWrite") {
        return {
          status: "ok",
          version: "version-1",
          filePath: "/home/test/.codex/config.toml",
          overriddenMetadata: null,
        };
      }
      throw new Error(`unexpected request ${method}`);
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          allow_destructive_actions: "ask",
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      configCwd: "/repo/project",
      nowMs: 1,
      request,
    });

    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
    expect(config.policyContext.apps).toStrictEqual({});
    expect(request).toHaveBeenCalledWith("config/read", {
      includeLayers: false,
      cwd: "/repo/project",
    });
    expect(request.mock.calls.filter(([method]) => method === "config/read")).toHaveLength(2);
    expect(config.diagnostics).toStrictEqual([
      {
        code: "approval_overrides_clear_failed",
        plugin: {
          configKey: "google-calendar",
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "google-calendar",
          enabled: true,
          allowDestructiveActions: true,
          destructiveApprovalMode: "ask",
        },
        message:
          "Could not clear durable Codex app approval overrides for google-calendar-app: effective approval overrides remain for calendar/create",
      },
    ]);
  });

  it("omits ask policy apps when approval override writes are overridden", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) =>
        codexAppInventoryResponse(method, [appInfo("google-calendar-app", true)], params),
    });
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginDetail(
          "google-calendar",
          [appSummary("google-calendar-app")],
          ["google-calendar"],
        );
      }
      if (method === "config/read") {
        if ((params as { includeLayers?: boolean } | undefined)?.includeLayers === true) {
          return {
            config: {
              apps: {
                "google-calendar-app": {
                  tools: {
                    "calendar/create": { approval_mode: "approve" },
                  },
                },
              },
            },
            layers: [],
          };
        }
        throw new Error("unexpected confirmation after an overridden batch");
      }
      if (method === "config/batchWrite") {
        return {
          status: "okOverridden",
          version: "version-1",
          filePath: "/home/test/.codex/config.toml",
          overriddenMetadata: null,
        };
      }
      throw new Error(`unexpected request ${method}`);
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          allow_destructive_actions: "ask",
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      configCwd: "/repo/project",
      nowMs: 1,
      request,
    });

    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
    expect(config.policyContext.apps).toStrictEqual({});
    expect(config.provisionalAppIds).toBeUndefined();
    expect(config.diagnostics).toStrictEqual([
      {
        code: "approval_overrides_clear_failed",
        plugin: {
          configKey: "google-calendar",
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "google-calendar",
          enabled: true,
          allowDestructiveActions: true,
          destructiveApprovalMode: "ask",
        },
        message:
          "Could not clear durable Codex app approval overrides for google-calendar-app: approval override for calendar/create is controlled by another config layer",
      },
    ]);
  });

  it("omits ask policy apps when durable approval override cleanup fails", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) =>
        codexAppInventoryResponse(method, [appInfo("google-calendar-app", true)], params),
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          allow_destructive_actions: "ask",
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method, params) => {
        if (method === "plugin/installed" || method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read") {
          return pluginDetail(
            "google-calendar",
            [appSummary("google-calendar-app")],
            ["google-calendar"],
          );
        }
        if (method === "config/read") {
          if ((params as { includeLayers?: boolean } | undefined)?.includeLayers === true) {
            return {
              config: {
                apps: {
                  "google-calendar-app": {
                    tools: { "calendar/create": { approval_mode: "approve" } },
                  },
                },
              },
              layers: [],
            };
          }
        }
        if (method === "config/batchWrite") {
          throw new Error("readonly config");
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
    expect(config.policyContext.apps).toStrictEqual({});
    expect(config.diagnostics).toStrictEqual([
      {
        code: "approval_overrides_clear_failed",
        plugin: {
          configKey: "google-calendar",
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "google-calendar",
          enabled: true,
          allowDestructiveActions: true,
          destructiveApprovalMode: "ask",
        },
        message:
          "Could not clear durable Codex app approval overrides for google-calendar-app: readonly config",
      },
    ]);
  });

  it("builds a restrictive app config when native plugin support is disabled", async () => {
    expect(
      shouldBuildCodexPluginThreadConfig({
        codexPlugins: { enabled: false },
      }),
    ).toBe(true);

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: { codexPlugins: { enabled: false } },
      appCacheKey: "runtime",
      request: async (method) => {
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.enabled).toBe(false);
    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
    expect(config.diagnostics).toStrictEqual([]);
    expect(config.policyContext.apps).toStrictEqual({});
  });

  it("exposes ready and default-disabled authorized account apps from a complete inventory", async () => {
    const pluginConfig = {
      codexPlugins: {
        enabled: true,
        allow_all_plugins: true,
        allow_destructive_actions: false,
      },
    };
    expect(shouldBuildCodexPluginThreadConfig(pluginConfig)).toBe(true);
    const installedParams: CodexAppServerRequestParams<"app/installed">[] = [];
    const accountApps = [
      { ...appInfo("chatgpt-meetings", true), name: "ChatGPT Meetings" },
      appInfo("disabled-account-app", true, false),
      appInfo("inaccessible-app", false),
      { ...appInfo("slack", true), name: "Slack" },
    ];
    const config = await buildCodexPluginThreadConfig({
      pluginConfig,
      appCacheKey: "runtime",
      request: async (method, rawParams) => {
        if (method === "config/read") {
          expect(rawParams).toEqual({ includeLayers: true });
          return { config: {}, layers: [] };
        }
        if (method !== "app/installed" && method !== "app/read") {
          throw new Error(`unexpected request ${method}`);
        }
        if (method === "app/installed") {
          installedParams.push(rawParams as CodexAppServerRequestParams<"app/installed">);
        }
        return codexAppInventoryResponse(method, accountApps);
      },
    });

    expect(installedParams).toEqual([{ forceRefresh: true }]);
    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
        "chatgpt-meetings": {
          enabled: true,
          destructive_enabled: false,
          open_world_enabled: true,
          default_tools_approval_mode: "auto",
        },
        "disabled-account-app": {
          enabled: true,
          destructive_enabled: false,
          open_world_enabled: true,
          default_tools_approval_mode: "auto",
        },
        slack: {
          enabled: true,
          destructive_enabled: false,
          open_world_enabled: true,
          default_tools_approval_mode: "auto",
        },
      },
    });
    expect(config.policyContext.apps).toEqual({
      "chatgpt-meetings": {
        source: "account",
        appName: "ChatGPT Meetings",
        allowDestructiveActions: false,
        allowOpenWorld: true,
        destructiveApprovalMode: "deny",
        mcpServerNames: [],
      },
      "disabled-account-app": {
        source: "account",
        appName: "disabled-account-app",
        allowDestructiveActions: false,
        allowOpenWorld: true,
        destructiveApprovalMode: "deny",
        mcpServerNames: [],
      },
      slack: {
        source: "account",
        appName: "Slack",
        allowDestructiveActions: false,
        allowOpenWorld: true,
        destructiveApprovalMode: "deny",
        mcpServerNames: [],
      },
    });
    expect(config.provisionalAppIds).toEqual(["chatgpt-meetings", "disabled-account-app", "slack"]);
    expect(config.diagnostics).toStrictEqual([]);
  });

  it("does not admit unauthorized or tool-blocked account apps", async () => {
    const accountApps = [
      appInfo("tool-blocked-account-app", true),
      appInfo("unauthorized-account-app", false),
    ];
    const request = vi.fn(async (method: string) => {
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, accountApps, undefined, {
          callableByAppId: { "tool-blocked-account-app": false },
        });
      }
      throw new Error(`unexpected request ${method}`);
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: { enabled: true, allow_all_plugins: true },
      },
      appCacheKey: "runtime",
      request,
    });

    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
    expect(config.policyContext.apps).toStrictEqual({});
    expect(config.provisionalAppIds).toBeUndefined();
    expect(config.diagnostics).toStrictEqual([]);
    expect(request.mock.calls.map(([method]) => method)).not.toContain("config/read");
  });

  it.each([
    {
      name: "excludes an account app explicitly disabled by project config",
      layers: [
        {
          name: "project",
          config: { apps: { "chatgpt-meetings": { enabled: false } } },
          disabledReason: null,
        },
      ],
      meetingsExposed: false,
      slackExposed: true,
    },
    {
      name: "uses the highest-precedence account app configuration",
      layers: [
        {
          name: "project",
          config: { apps: { "chatgpt-meetings": { enabled: true } } },
          disabledReason: null,
        },
        {
          name: "user",
          config: { apps: { "chatgpt-meetings": { enabled: false } } },
          disabledReason: null,
        },
      ],
      meetingsExposed: true,
      slackExposed: true,
    },
    {
      name: "ignores an inactive account app config layer",
      layers: [
        {
          name: "untrusted-project",
          config: { apps: { "chatgpt-meetings": { enabled: false } } },
          disabledReason: "untrusted project",
        },
      ],
      meetingsExposed: true,
      slackExposed: true,
    },
    {
      name: "fails closed for account apps when project config cannot be read",
      configUnavailable: true,
      meetingsExposed: false,
      slackExposed: false,
    },
  ] satisfies Array<{
    name: string;
    layers?: Array<{ name: string; config: JsonObject; disabledReason: string | null }>;
    configUnavailable?: boolean;
    meetingsExposed: boolean;
    slackExposed: boolean;
  }>)(
    "$name",
    async ({
      layers,
      configUnavailable,
      meetingsExposed,
      slackExposed,
    }: {
      layers?: Array<{ name: string; config: JsonObject; disabledReason: string | null }>;
      configUnavailable?: boolean;
      meetingsExposed: boolean;
      slackExposed: boolean;
    }) => {
      const accountApps = [appInfo("chatgpt-meetings", true, false), appInfo("slack", true)];
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "app/installed" || method === "app/read") {
          return codexAppInventoryResponse(method, accountApps);
        }
        if (method === "config/read") {
          expect(params).toEqual({ includeLayers: true, cwd: "/repo/project" });
          if (configUnavailable) {
            throw new Error("config unavailable");
          }
          return { config: {}, layers };
        }
        throw new Error(`unexpected request ${method}`);
      });

      const config = await buildCodexPluginThreadConfig({
        pluginConfig: {
          codexPlugins: { enabled: true, allow_all_plugins: true },
        },
        configCwd: "/repo/project",
        appCacheKey: "runtime",
        request,
      });

      const apps = config.configPatch?.apps as Record<string, unknown> | undefined;
      expect(Object.hasOwn(apps ?? {}, "chatgpt-meetings")).toBe(meetingsExposed);
      expect(Object.hasOwn(apps ?? {}, "slack")).toBe(slackExposed);
      expect(config.provisionalAppIds ?? []).toEqual(
        [meetingsExposed ? "chatgpt-meetings" : null, slackExposed ? "slack" : null]
          .filter((appId): appId is string => appId !== null)
          .toSorted(),
      );
      if (configUnavailable) {
        expect(config.diagnostics).toContainEqual(
          expect.objectContaining({ code: "account_app_config_unavailable" }),
        );
      }
      expect(request.mock.calls.filter(([method]) => method === "config/read")).toHaveLength(1);
    },
  );

  it.each([
    {
      name: "does not re-admit an explicitly disabled curated plugin app",
      configKey: "google-calendar",
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
      pluginName: "google-calendar",
      pluginDisplayName: "Google Calendar",
      enabled: false,
      detailUnavailable: false,
      exposesDisplayName: false,
    },
    {
      name: "does not expose an ambiguously owned curated plugin app",
      configKey: "google-calendar",
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
      pluginName: "google-calendar",
      pluginDisplayName: "Google Calendar",
      enabled: true,
      detailUnavailable: true,
      exposesDisplayName: true,
    },
    {
      name: "does not re-admit an explicitly disabled workspace plugin app",
      configKey: "workspaceData",
      marketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
      pluginName: "workspace-data@workspace-directory",
      pluginDisplayName: "Workspace Data",
      enabled: false,
      detailUnavailable: false,
      exposesDisplayName: false,
    },
  ])("$name", async (testCase) => {
    const ownedApp = {
      ...appInfo("plugin-owned-app", true),
      pluginDisplayNames: testCase.exposesDisplayName ? [testCase.pluginDisplayName] : [],
    };
    const accountApps = [ownedApp, appInfo("unrelated-slack-app", true)];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, accountApps);
      }
      if (method === "plugin/installed") {
        return pluginInstalled(
          [
            pluginSummary(testCase.pluginName, {
              ...(testCase.exposesDisplayName ? { name: testCase.pluginDisplayName } : {}),
              ...(testCase.marketplaceName === CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME
                ? { remotePluginId: "plugin_workspace_data" }
                : {}),
              installed: true,
              enabled: true,
            }),
          ],
          testCase.marketplaceName === CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME
            ? { name: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME, path: null }
            : {},
        );
      }
      if (method === "plugin/read") {
        if (testCase.detailUnavailable) {
          throw new Error("plugin detail unavailable");
        }
        return pluginDetail(
          testCase.pluginName,
          [appSummary("plugin-owned-app")],
          [],
          testCase.marketplaceName === CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME
            ? { marketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME, marketplacePath: null }
            : {},
        );
      }
      if (method === "config/read") {
        expect(params).toEqual({ includeLayers: true });
        return { config: {}, layers: [] };
      }
      throw new Error(`unexpected request ${method}`);
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          allow_all_plugins: true,
          plugins: {
            [testCase.configKey]: {
              enabled: testCase.enabled,
              marketplaceName: testCase.marketplaceName,
              pluginName: testCase.pluginName,
            },
          },
        },
      },
      appCacheKey: "runtime",
      request,
    });

    expect(config.configPatch?.apps).not.toHaveProperty("plugin-owned-app");
    expect(config.configPatch?.apps).toMatchObject({
      "unrelated-slack-app": { enabled: true },
    });
    expect(config.policyContext.apps).not.toHaveProperty("plugin-owned-app");
    expect(config.provisionalAppIds).toEqual(["unrelated-slack-app"]);
    expect(request.mock.calls.map(([method]) => method)).not.toContain("plugin/install");
    if (testCase.detailUnavailable) {
      expect(config.diagnostics).toContainEqual(
        expect.objectContaining({ code: "app_ownership_ambiguous" }),
      );
    }
  });

  it("fails closed when a disabled workspace plugin's app ownership cannot be verified", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, [
          appInfo("plugin-owned-app", true),
          appInfo("unrelated-slack-app", true),
        ]);
      }
      if (method === "plugin/installed") {
        return pluginInstalled([]);
      }
      throw new Error(`unexpected request ${method}`);
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          allow_all_plugins: true,
          plugins: {
            workspaceData: {
              enabled: false,
              marketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
              pluginName: "workspace-data@workspace-directory",
            },
          },
        },
      },
      appCacheKey: "runtime",
      request,
    });

    expect(config.configPatch?.apps).not.toHaveProperty("plugin-owned-app");
    expect(config.configPatch?.apps).not.toHaveProperty("unrelated-slack-app");
    expect(config.provisionalAppIds).toBeUndefined();
    expect(config.diagnostics).toContainEqual(
      expect.objectContaining({ code: "account_app_ownership_unavailable" }),
    );
    expect(request.mock.calls.map(([method]) => method)).not.toContain("plugin/install");
  });

  it.each([
    {
      name: "preserves denied enterprise ownership",
      detailUnavailable: false,
      marketplaceName: "company-tools",
    },
    {
      name: "fails closed for unavailable enterprise ownership",
      detailUnavailable: true,
      marketplaceName: "company-tools",
    },
    {
      name: "preserves denied curated ownership",
      detailUnavailable: false,
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
    },
    {
      name: "fails closed for unavailable curated ownership",
      detailUnavailable: true,
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
    },
  ])(
    "$name for an administrator-disabled marketplace plugin",
    async ({ detailUnavailable, marketplaceName }) => {
      const marketplacePath = `/marketplaces/${marketplaceName}/marketplace.json`;
      const request = vi.fn(async (method: string) => {
        if (method === "app/installed" || method === "app/read") {
          return codexAppInventoryResponse(method, [
            appInfo("admin-denied-app", true),
            appInfo("unrelated-slack-app", true),
          ]);
        }
        if (method === "plugin/installed" || method === "plugin/list") {
          const summaries = [
            pluginSummary("security-review", {
              installed: true,
              enabled: true,
              availability: "DISABLED_BY_ADMIN",
            }),
          ];
          const marketplace = { name: marketplaceName, path: marketplacePath };
          return method === "plugin/installed"
            ? pluginInstalled(summaries, marketplace)
            : pluginList(summaries, marketplace);
        }
        if (method === "plugin/read") {
          if (detailUnavailable) {
            throw new Error("administrator denied plugin ownership details");
          }
          return pluginDetail("security-review", [appSummary("admin-denied-app")], [], {
            marketplaceName,
            marketplacePath,
          });
        }
        if (method === "config/read") {
          return { config: {}, layers: [] };
        }
        throw new Error(`unexpected request ${method}`);
      });

      const config = await buildCodexPluginThreadConfig({
        pluginConfig: {
          codexPlugins: {
            enabled: true,
            allow_all_plugins: true,
            plugins: {
              security: {
                marketplaceName,
                pluginName: "security-review",
              },
            },
          },
        },
        appCacheKey: "runtime",
        request,
      });

      expect(config.configPatch?.apps).not.toHaveProperty("admin-denied-app");
      expect(config.policyContext.apps).not.toHaveProperty("admin-denied-app");
      expect(config.diagnostics).toContainEqual(
        expect.objectContaining({ code: "plugin_disabled" }),
      );
      if (detailUnavailable) {
        expect(config.configPatch?.apps).not.toHaveProperty("unrelated-slack-app");
        expect(config.diagnostics).toContainEqual(
          expect.objectContaining({ code: "account_app_ownership_unavailable" }),
        );
      } else {
        expect(config.configPatch?.apps).toHaveProperty("unrelated-slack-app");
      }
      expect(request.mock.calls.map(([method]) => method)).not.toContain("plugin/install");
    },
  );

  it.each([
    {
      name: "an enterprise plugin omitted from every catalog",
      marketplaceName: "company-tools",
      listedPlugins: [],
    },
    {
      name: "an enterprise plugin unavailable before installation",
      marketplaceName: "company-tools",
      listedPlugins: [
        pluginSummary("security-review", {
          installed: false,
          enabled: false,
          availability: "DISABLED_BY_ADMIN",
        }),
      ],
    },
    {
      name: "a curated plugin unavailable before installation",
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
      listedPlugins: [
        pluginSummary("security-review", {
          installed: false,
          enabled: false,
          availability: "DISABLED_BY_ADMIN",
        }),
      ],
    },
  ])("fails closed when $name", async ({ listedPlugins, marketplaceName }) => {
    const request = vi.fn(async (method: string) => {
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, [
          appInfo("admin-denied-app", true),
          appInfo("unrelated-slack-app", true),
        ]);
      }
      if (method === "plugin/installed") {
        return pluginInstalled([], { name: marketplaceName, path: "/company/marketplace.json" });
      }
      if (method === "plugin/list") {
        return pluginList(listedPlugins, {
          name: marketplaceName,
          path: "/company/marketplace.json",
        });
      }
      throw new Error(`unexpected request ${method}`);
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          allow_all_plugins: true,
          plugins: {
            security: {
              marketplaceName,
              pluginName: "security-review",
            },
          },
        },
      },
      appCacheKey: "runtime",
      request,
    });

    expect(config.configPatch?.apps).not.toHaveProperty("admin-denied-app");
    expect(config.configPatch?.apps).not.toHaveProperty("unrelated-slack-app");
    expect(config.diagnostics).toContainEqual(
      expect.objectContaining({ code: "account_app_ownership_unavailable" }),
    );
    expect(request.mock.calls.map(([method]) => method)).not.toContain("plugin/install");
  });

  it("fails closed when the account app inventory cannot be read", async () => {
    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          allow_all_plugins: true,
          allow_destructive_actions: false,
        },
      },
      appCacheKey: "runtime",
      request: async (method) => {
        if (method === "config/read") {
          return { config: {}, layers: [] };
        }
        if (method === "app/installed") {
          throw new Error("inventory unavailable");
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
    expect(config.policyContext.apps).toStrictEqual({});
    expect(config.diagnostics).toContainEqual({
      code: "account_app_inventory_unavailable",
      message: "Codex account app inventory was unavailable; account apps were not exposed.",
    });
  });

  it("reads shared account app configuration once when ask mode needs no writes", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, [
          { ...appInfo("chatgpt-meetings", true), name: "ChatGPT Meetings" },
          { ...appInfo("slack", true), name: "Slack" },
        ]);
      }
      if (method === "config/read") {
        expect(params).toEqual({ includeLayers: true });
        return { config: {}, layers: [] };
      }
      throw new Error(`unexpected request ${method}`);
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          allow_all_plugins: true,
          allow_destructive_actions: "ask",
        },
      },
      appCacheKey: "runtime",
      request,
    });

    expect(config.provisionalAppIds).toEqual(["chatgpt-meetings", "slack"]);
    expect(Object.keys(config.policyContext.apps).toSorted()).toEqual([
      "chatgpt-meetings",
      "slack",
    ]);
    expect(request.mock.calls.filter(([method]) => method === "config/read")).toHaveLength(1);
    expect(request.mock.calls.map(([method]) => method)).not.toContain("config/batchWrite");
    expect(request.mock.calls.map(([method]) => method)).not.toContain("config/value/write");
    expect(config.diagnostics).toStrictEqual([]);
  });

  it("clears durable approval overrides for account apps in ask mode", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, [
          { ...appInfo("chatgpt-meetings", true), name: "ChatGPT Meetings" },
        ]);
      }
      if (method === "config/read") {
        const includeLayers =
          (params as { includeLayers?: boolean } | undefined)?.includeLayers === true;
        return {
          config: {
            apps: {
              "chatgpt-meetings": {
                tools: includeLayers ? { import_meeting: { approval_mode: "approve" } } : {},
              },
            },
          },
          ...(includeLayers ? { layers: [] } : {}),
        };
      }
      if (method === "config/batchWrite") {
        return {
          status: "ok",
          version: "version-1",
          filePath: "/home/test/.codex/config.toml",
          overriddenMetadata: null,
        };
      }
      throw new Error(`unexpected request ${method}`);
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          allow_all_plugins: true,
          allow_destructive_actions: "ask",
        },
      },
      appCacheKey: "runtime",
      request,
    });

    expect((config.configPatch?.apps as Record<string, unknown>)?.["chatgpt-meetings"]).toEqual({
      enabled: true,
      approvals_reviewer: "user",
      destructive_enabled: true,
      open_world_enabled: true,
      default_tools_approval_mode: "auto",
    });
    expect(request).toHaveBeenCalledWith("config/batchWrite", {
      edits: [
        {
          keyPath: 'apps."chatgpt-meetings".tools."import_meeting".approval_mode',
          value: null,
          mergeStrategy: "replace",
        },
      ],
    });
    expect(request.mock.calls.filter(([method]) => method === "config/read")).toHaveLength(2);
    expect(request.mock.calls.map(([method]) => method)).not.toContain("config/value/write");
  });

  it("does not re-admit an excluded plugin-owned app through account-wide policy", async () => {
    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          allow_all_plugins: true,
          allow_destructive_actions: "auto",
          plugins: {
            meetings: {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "meetings",
              allow_destructive_actions: "ask",
            },
          },
        },
      },
      appCacheKey: "runtime",
      request: async (method, params) => {
        if (method === "plugin/installed" || method === "plugin/list") {
          return pluginList([pluginSummary("meetings", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read") {
          return pluginDetail("meetings", [appSummary("chatgpt-meetings")]);
        }
        if (method === "app/installed" || method === "app/read") {
          return codexAppInventoryResponse(method, [
            { ...appInfo("chatgpt-meetings", true), name: "ChatGPT Meetings" },
          ]);
        }
        if (method === "config/read") {
          if ((params as { includeLayers?: boolean } | undefined)?.includeLayers === true) {
            return {
              config: {
                apps: {
                  "chatgpt-meetings": {
                    tools: { import_meeting: { approval_mode: "approve" } },
                  },
                },
              },
              layers: [],
            };
          }
        }
        if (method === "config/batchWrite") {
          throw new Error("approval policy unavailable");
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
    expect(config.policyContext.apps).toStrictEqual({});
    expect(config.provisionalAppIds).toBeUndefined();
    expect(config.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "approval_overrides_clear_failed",
        message:
          "Could not clear durable Codex app approval overrides for chatgpt-meetings: approval policy unavailable",
      }),
    );
  });

  it("does not let per-plugin enablement override disabled native plugin support", async () => {
    expect(
      shouldBuildCodexPluginThreadConfig({
        codexPlugins: {
          enabled: false,
          plugins: {
            "google-calendar": {
              enabled: true,
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      }),
    ).toBe(true);

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: false,
          plugins: {
            "google-calendar": {
              enabled: true,
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCacheKey: "runtime",
      request: async (method) => {
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.enabled).toBe(false);
    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
    expect(config.policyContext.apps).toStrictEqual({});
    expect(config.diagnostics).toStrictEqual([]);
  });

  it("waits for the initial app inventory before exposing plugin apps", async () => {
    const appCache = new CodexAppInventoryCache();
    const installedParams: CodexAppServerRequestParams<"app/installed">[] = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config/read") {
        expect(params).toEqual({ includeLayers: true });
        return { config: {}, layers: [] };
      }
      if (method === "app/installed" || method === "app/read") {
        if (method === "app/installed") {
          installedParams.push(params as CodexAppServerRequestParams<"app/installed">);
        }
        return codexAppInventoryResponse(method, [appInfo("google-calendar-app", true)]);
      }
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      request,
    });

    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
        "google-calendar-app": {
          enabled: true,
          destructive_enabled: true,
          open_world_enabled: true,
          default_tools_approval_mode: "auto",
        },
      },
    });
    expect(config.policyContext.apps["google-calendar-app"]).toEqual({
      configKey: "google-calendar",
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
      pluginName: "google-calendar",
      allowDestructiveActions: true,
      allowOpenWorld: true,
      destructiveApprovalMode: "allow",
      mcpServerNames: [],
    });
    expect(config.diagnostics).toStrictEqual([]);
    expect(
      request.mock.calls.reduce(
        (count, [method]) => count + (method === "app/installed" ? 1 : 0),
        0,
      ),
    ).toBe(1);
    expect(installedParams).toEqual([{ forceRefresh: true }]);
  });

  it("provisionally admits an authorized plugin app disabled by the Codex default", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) =>
        codexAppInventoryResponse(method, [appInfo("google-calendar-app", true, false)], params),
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method) => {
        if (method === "app/installed" || method === "app/read") {
          return codexAppInventoryResponse(method, [appInfo("google-calendar-app", true, false)]);
        }
        if (method === "config/read") {
          return {
            config: {},
            layers: [
              {
                name: "user",
                config: { apps: { _default: { enabled: false } } },
                disabledReason: null,
              },
            ],
          };
        }
        if (method === "plugin/installed" || method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read") {
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.inventory?.records[0]?.apps).toStrictEqual([
      {
        id: "google-calendar-app",
        name: "google-calendar-app",
        accessible: true,
        enabled: false,
        needsAuth: false,
      },
    ]);
    expect(config.configPatch?.apps).toMatchObject({
      "google-calendar-app": { enabled: true },
    });
    expect(config.provisionalAppIds).toEqual(["google-calendar-app"]);
    expect(config.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "app_not_ready" }),
    );
  });

  const appPolicyCases: Array<{
    name: string;
    layers?: Array<{ name: string; config: JsonObject; disabledReason: string | null }>;
    configUnavailable?: boolean;
    exposed: boolean;
  }> = [
    {
      name: "blocks an explicit app-specific Codex disable",
      layers: [
        {
          name: "project",
          config: { apps: { "google-calendar-app": { enabled: false } } },
          disabledReason: null,
        },
      ],
      exposed: false,
    },
    {
      name: "honors the highest-precedence explicit app enablement",
      layers: [
        {
          name: "project",
          config: { apps: { "google-calendar-app": { enabled: true } } },
          disabledReason: null,
        },
        {
          name: "user",
          config: { apps: { "google-calendar-app": { enabled: false } } },
          disabledReason: null,
        },
      ],
      exposed: true,
    },
    {
      name: "ignores disabled config layers when deciding plugin admission",
      layers: [
        {
          name: "untrusted-project",
          config: { apps: { "google-calendar-app": { enabled: false } } },
          disabledReason: "untrusted project",
        },
        {
          name: "user",
          config: { apps: { _default: { enabled: false } } },
          disabledReason: null,
        },
      ],
      exposed: true,
    },
    {
      name: "fails closed when Codex config layers cannot be inspected",
      configUnavailable: true,
      exposed: false,
    },
  ];

  it.each(
    appPolicyCases.flatMap((testCase) => [
      { ...testCase, appEnabled: false },
      {
        ...testCase,
        name: `${testCase.name} for a globally ready app`,
        appEnabled: true,
      },
    ]),
  )(
    "$name",
    async ({
      layers,
      configUnavailable,
      exposed,
      appEnabled,
    }: {
      layers?: Array<{ name: string; config: JsonObject; disabledReason: string | null }>;
      configUnavailable?: boolean;
      exposed: boolean;
      appEnabled: boolean;
    }) => {
      const appCache = new CodexAppInventoryCache();
      const app = appInfo("google-calendar-app", true, appEnabled);
      await appCache.refreshNow({
        key: "runtime",
        nowMs: 0,
        request: async (method, params) => codexAppInventoryResponse(method, [app], params),
      });

      const request = vi.fn(async (method: string) => {
        if (method === "app/installed" || method === "app/read") {
          return codexAppInventoryResponse(method, [app]);
        }
        if (method === "plugin/installed" || method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read") {
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        if (method === "config/read") {
          if (configUnavailable) {
            throw new Error("config unavailable");
          }
          return { config: {}, layers };
        }
        throw new Error(`unexpected request ${method}`);
      });

      const config = await buildCodexPluginThreadConfig({
        pluginConfig: {
          codexPlugins: {
            enabled: true,
            plugins: {
              "google-calendar": {
                marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
                pluginName: "google-calendar",
              },
            },
          },
        },
        appCache,
        appCacheKey: "runtime",
        nowMs: 1,
        request,
      });

      if (exposed) {
        expect(config.configPatch?.apps).toMatchObject({
          "google-calendar-app": { enabled: true },
        });
        expect(config.provisionalAppIds).toEqual(["google-calendar-app"]);
        expect(config.diagnostics).not.toContainEqual(
          expect.objectContaining({ code: "app_not_ready" }),
        );
      } else {
        expect(config.configPatch?.apps).not.toHaveProperty("google-calendar-app");
        expect(config.provisionalAppIds).toBeUndefined();
        expect(config.diagnostics).toContainEqual(
          expect.objectContaining({ code: "app_not_ready" }),
        );
      }
      expect(request).toHaveBeenCalledWith("config/read", { includeLayers: true });
    },
  );

  it("blocks an authorized enabled plugin app when no runtime tool is callable", async () => {
    const appCache = new CodexAppInventoryCache();
    const blockedApp = appInfo("google-calendar-app", true);
    const runtimeOptions = { callableByAppId: { "google-calendar-app": false } };
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) =>
        codexAppInventoryResponse(method, [blockedApp], params, runtimeOptions),
    });
    const request = vi.fn(async (method: string) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
      }
      throw new Error(`unexpected request ${method}`);
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request,
    });

    expect(config.configPatch?.apps).not.toHaveProperty("google-calendar-app");
    expect(config.provisionalAppIds).toBeUndefined();
    expect(config.diagnostics).toContainEqual(expect.objectContaining({ code: "app_not_ready" }));
    expect(request).not.toHaveBeenCalledWith("config/read", expect.anything());
  });

  it("refreshes missing app inventory when plugin activation becomes unnecessary", async () => {
    const appCache = new CodexAppInventoryCache();
    const installedParams: CodexAppServerRequestParams<"app/installed">[] = [];
    let pluginListCalls = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config/read") {
        expect(params).toEqual({ includeLayers: true });
        return { config: {}, layers: [] };
      }
      if (method === "plugin/installed" || method === "plugin/list") {
        pluginListCalls += 1;
        const active = pluginListCalls > 1;
        return pluginList([
          pluginSummary("google-calendar", { installed: active, enabled: active }),
        ]);
      }
      if (method === "plugin/read") {
        return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
      }
      if (method === "app/installed" || method === "app/read") {
        if (method === "app/installed") {
          installedParams.push(params as CodexAppServerRequestParams<"app/installed">);
        }
        return codexAppInventoryResponse(method, [appInfo("google-calendar-app", true)]);
      }
      throw new Error(`unexpected request ${method}`);
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      request,
    });

    expect(config.configPatch?.apps).toMatchObject({
      "google-calendar-app": {
        enabled: true,
      },
    });
    expect(request.mock.calls.map(([method]) => method)).not.toContain("plugin/install");
    expect(installedParams).toEqual([{ forceRefresh: true }]);
  });

  it("does not expose plugin apps missing from the app inventory snapshot", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) => codexAppInventoryResponse(method, [], params),
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method) => {
        if (method === "plugin/installed" || method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read") {
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
    expect(config.policyContext.apps).toStrictEqual({});
    expect(config.diagnostics).toStrictEqual([
      {
        code: "app_not_ready",
        plugin: {
          configKey: "google-calendar",
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "google-calendar",
          enabled: true,
          allowDestructiveActions: true,
          destructiveApprovalMode: "allow",
        },
        message: "google-calendar-app is not accessible for google-calendar.",
      },
    ]);
  });

  it("does not expose apps for plugins that OpenClaw policy leaves disabled", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) =>
        codexAppInventoryResponse(method, [appInfo("google-calendar-app", true)], params),
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              enabled: false,
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method) => {
        if (method === "plugin/installed" || method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
    expect(config.policyContext.apps).toStrictEqual({});
    expect(config.diagnostics).toStrictEqual([]);
  });

  it("force-refreshes app inventory when proven plugin apps are not ready", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) => codexAppInventoryResponse(method, [], params),
    });
    const installedParams: CodexAppServerRequestParams<"app/installed">[] = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config/read") {
        expect(params).toEqual({ includeLayers: true });
        return { config: {}, layers: [] };
      }
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
      }
      if (method === "app/installed" || method === "app/read") {
        if (method === "app/installed") {
          installedParams.push(params as CodexAppServerRequestParams<"app/installed">);
        }
        return codexAppInventoryResponse(method, [appInfo("google-calendar-app", true)]);
      }
      throw new Error(`unexpected request ${method}`);
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request,
    });

    expect(config.configPatch).not.toHaveProperty("approvals_reviewer");
    expect(config.configPatch?.apps).toEqual({
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
      "google-calendar-app": {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
      },
    });
    expect(config.policyContext.apps["google-calendar-app"]).toEqual({
      configKey: "google-calendar",
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
      pluginName: "google-calendar",
      allowDestructiveActions: true,
      allowOpenWorld: true,
      destructiveApprovalMode: "allow",
      mcpServerNames: [],
    });
    expect(config.diagnostics).toStrictEqual([]);
    expect(installedParams).toEqual([{ forceRefresh: true }]);
  });

  it("re-reads app readiness after re-enabling an installed plugin", async () => {
    const appCache = new CodexAppInventoryCache();
    const metadataCache = new CodexPluginMetadataCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) =>
        codexAppInventoryResponse(method, [appInfo("google-calendar-app", true, false)], params),
    });
    let enabled = false;
    const installedParams: CodexAppServerRequestParams<"app/installed">[] = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config/read") {
        expect(params).toEqual({ includeLayers: true });
        return { config: {}, layers: [] };
      }
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled })]);
      }
      if (method === "plugin/read") {
        return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
      }
      if (method === "plugin/install") {
        enabled = true;
        return { authPolicy: "ON_USE", appsNeedingAuth: [] } satisfies v2.PluginInstallResponse;
      }
      if (method === "skills/list") {
        return { data: [] } satisfies v2.SkillsListResponse;
      }
      if (method === "hooks/list") {
        return { data: [] } satisfies v2.HooksListResponse;
      }
      if (method === "config/mcpServer/reload") {
        return {};
      }
      if (method === "app/installed" || method === "app/read") {
        if (method === "app/installed") {
          installedParams.push(params as CodexAppServerRequestParams<"app/installed">);
        }
        return codexAppInventoryResponse(method, [appInfo("google-calendar-app", true, enabled)]);
      }
      throw new Error(`unexpected request ${method}`);
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      metadataCache,
      nowMs: 1,
      request,
    });

    expect(config.configPatch).not.toHaveProperty("approvals_reviewer");
    expect(config.configPatch?.apps).toEqual({
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
      "google-calendar-app": {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
      },
    });
    expect(config.policyContext.apps["google-calendar-app"]).toEqual({
      configKey: "google-calendar",
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
      pluginName: "google-calendar",
      allowDestructiveActions: true,
      allowOpenWorld: true,
      destructiveApprovalMode: "allow",
      mcpServerNames: [],
    });
    expect(config.diagnostics).toStrictEqual([]);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "plugin/installed",
      "plugin/read",
      "plugin/list",
      "plugin/install",
      "plugin/list",
      "skills/list",
      "hooks/list",
      "config/mcpServer/reload",
      "app/installed",
      "app/read",
      "plugin/installed",
      "plugin/read",
      "config/read",
    ]);
    expect(installedParams).toEqual([{ forceRefresh: true }]);
  });

  it("refreshes app inventory once for the union of all activated plugin apps", async () => {
    const appCache = new CodexAppInventoryCache();
    const metadataCache = new CodexPluginMetadataCache();
    const pluginNames = ["calendar", "meetings"] as const;
    const appInfos = pluginNames.map((name) => appInfo(`${name}-app`, true, false));
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) => codexAppInventoryResponse(method, appInfos, params),
    });

    const activatedPlugins = new Set<string>();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginList(
          pluginNames.map((name) =>
            pluginSummary(name, {
              installed: true,
              enabled: activatedPlugins.has(name),
            }),
          ),
        );
      }
      if (method === "plugin/read") {
        const pluginName = (params as v2.PluginReadParams).pluginName;
        return pluginDetail(pluginName, [appSummary(`${pluginName}-app`)]);
      }
      if (method === "plugin/install") {
        activatedPlugins.add((params as v2.PluginInstallParams).pluginName);
        return { authPolicy: "ON_USE", appsNeedingAuth: [] } satisfies v2.PluginInstallResponse;
      }
      if (method === "skills/list") {
        return { data: [] } satisfies v2.SkillsListResponse;
      }
      if (method === "hooks/list") {
        return { data: [] } satisfies v2.HooksListResponse;
      }
      if (method === "config/mcpServer/reload") {
        return {};
      }
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(
          method,
          pluginNames.map((name) => appInfo(`${name}-app`, true, activatedPlugins.has(name))),
        );
      }
      if (method === "config/read") {
        expect(params).toEqual({ includeLayers: true });
        return { config: {}, layers: [] };
      }
      throw new Error(`unexpected request ${method}`);
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            calendar: {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "calendar",
            },
            meetings: {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "meetings",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      metadataCache,
      nowMs: 1,
      request,
    });

    expect(config.configPatch?.apps).toMatchObject({
      "calendar-app": { enabled: true },
      "meetings-app": { enabled: true },
    });
    expect(config.provisionalAppIds).toEqual(["calendar-app", "meetings-app"]);
    expect(request.mock.calls.filter(([method]) => method === "plugin/install")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "app/installed")).toEqual([
      ["app/installed", { forceRefresh: true }],
    ]);
    expect(request.mock.calls.filter(([method]) => method === "app/read")).toEqual([
      ["app/read", { appIds: ["calendar-app", "meetings-app"], includeTools: true }],
    ]);
    expect(request.mock.calls.filter(([method]) => method === "config/read")).toHaveLength(1);
  });

  it("installs an unconfigured remote plugin before waiting for app inventory", async () => {
    const appCache = new CodexAppInventoryCache();
    let installed = false;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config/read") {
        expect(params).toEqual({ includeLayers: true });
        return { config: {}, layers: [] };
      }
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed, enabled: installed })]);
      }
      if (method === "plugin/read") {
        return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
      }
      if (method === "plugin/install") {
        installed = true;
        return { authPolicy: "ON_USE", appsNeedingAuth: [] } satisfies v2.PluginInstallResponse;
      }
      if (method === "skills/list") {
        return { data: [] } satisfies v2.SkillsListResponse;
      }
      if (method === "hooks/list") {
        return { data: [] } satisfies v2.HooksListResponse;
      }
      if (method === "config/mcpServer/reload") {
        return {};
      }
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, [appInfo("google-calendar-app", true, installed)]);
      }
      throw new Error(`unexpected request ${method}: ${JSON.stringify(params)}`);
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      request,
    });

    expect(config.configPatch?.apps).toMatchObject({
      "google-calendar-app": {
        enabled: true,
      },
    });
    const methods = request.mock.calls.map(([method]) => method);
    expect(methods.indexOf("plugin/install")).toBeGreaterThan(-1);
    expect(methods.indexOf("app/installed")).toBeGreaterThan(methods.indexOf("plugin/install"));
  });

  it("surfaces critical post-install refresh failures and keeps plugin apps disabled", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) =>
        codexAppInventoryResponse(method, [appInfo("google-calendar-app", true)], params),
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method) => {
        if (method === "plugin/installed" || method === "plugin/list") {
          return pluginList([
            pluginSummary("google-calendar", { installed: false, enabled: false }),
          ]);
        }
        if (method === "plugin/read") {
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        if (method === "plugin/install") {
          return { authPolicy: "ON_USE", appsNeedingAuth: [] } satisfies v2.PluginInstallResponse;
        }
        if (method === "skills/list") {
          throw new Error("skills/list unavailable");
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
    expect(config.policyContext.apps).toStrictEqual({});
    expect(config.diagnostics).toHaveLength(1);
    expect(config.diagnostics[0]?.code).toBe("plugin_activation_failed");
    expect(config.diagnostics[0]?.message).toBe(
      "Codex plugin runtime refresh failed after install: skills/list unavailable",
    );
  });

  it("isolates an admin-disabled remote plugin and keeps unaffected plugin apps available", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) =>
        codexAppInventoryResponse(
          method,
          [appInfo("calendar-app", true), appInfo("github-app", true)],
          params,
        ),
    });
    const calendar = pluginSummary("calendar@openai-curated-remote", {
      name: "calendar",
      remotePluginId: "plugins~Plugin_calendar",
      installed: false,
      enabled: false,
      availability: "DISABLED_BY_ADMIN",
    });
    const github = pluginSummary("github@openai-curated-remote", {
      name: "github",
      remotePluginId: "plugins~Plugin_github",
      installed: true,
      enabled: true,
    });
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "plugin/installed" || method === "plugin/list") {
        return method === "plugin/installed"
          ? pluginInstalled([calendar, github], { name: "openai-curated-remote", path: null })
          : pluginList([calendar, github], { name: "openai-curated-remote", path: null });
      }
      if (method === "plugin/read") {
        const pluginName = (params as v2.PluginReadParams).pluginName;
        return pluginName === "plugins~Plugin_calendar"
          ? pluginDetail("calendar", [appSummary("calendar-app")], [], {
              marketplaceName: "openai-curated-remote",
              marketplacePath: null,
            })
          : pluginDetail("github", [appSummary("github-app")], ["github"], {
              marketplaceName: "openai-curated-remote",
              marketplacePath: null,
            });
      }
      throw new Error(`unexpected request ${method}`);
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            calendar: {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "calendar",
              allow_destructive_actions: false,
            },
            github: {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "github",
              allow_destructive_actions: "ask",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request,
    });

    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
        "github-app": {
          enabled: true,
          destructive_enabled: true,
          open_world_enabled: true,
          default_tools_approval_mode: "auto",
          approvals_reviewer: "user",
        },
      },
    });
    expect(config.provisionalAppIds).toEqual(["github-app"]);
    expect(config.policyContext.pluginAppIds).toEqual({ github: ["github-app"] });
    expect(config.policyContext.apps).not.toHaveProperty("calendar-app");
    expect(config.diagnostics).toContainEqual({
      code: "plugin_disabled",
      plugin: expect.objectContaining({ configKey: "calendar", pluginName: "calendar" }),
      message: "calendar is unavailable in openai-curated.",
    });
    expect(request.mock.calls.map(([method]) => method)).not.toContain("plugin/install");
  });

  it("fails closed when the initial app inventory refresh fails", async () => {
    const appCache = new CodexAppInventoryCache();
    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      request: async (method) => {
        if (method === "app/installed") {
          throw new Error("app/installed unavailable");
        }
        if (method === "plugin/installed" || method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read") {
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
    expect(config.policyContext.apps).toStrictEqual({});
    expect(config.policyContext.pluginAppIds).toStrictEqual({
      "google-calendar": ["google-calendar-app"],
    });
    expect(config.diagnostics.map((diagnostic) => diagnostic.code)).toStrictEqual([
      "app_inventory_missing",
    ]);
  });

  it("fails closed when app inventory entries are malformed", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) =>
        codexAppInventoryResponse(
          method,
          [{ ...appInfo("google-calendar-app", true), id: "" }],
          params,
        ),
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method) => {
        if (method === "plugin/installed" || method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read") {
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
    expect(config.policyContext.apps).toStrictEqual({});
    expect(config.diagnostics).toStrictEqual([
      {
        code: "app_not_ready",
        plugin: {
          configKey: "google-calendar",
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "google-calendar",
          enabled: true,
          allowDestructiveActions: true,
          destructiveApprovalMode: "allow",
        },
        message: "google-calendar-app is not accessible for google-calendar.",
      },
    ]);
  });

  it("uses durable policy and app cache key in the cheap input fingerprint", async () => {
    const appCache = new CodexAppInventoryCache();
    const first = buildCodexPluginThreadConfigInputFingerprint({
      pluginConfig: { codexPlugins: { enabled: true } },
      appCacheKey: "runtime-a",
    });
    await appCache.refreshNow({
      key: "runtime-a",
      request: async (method, params) => codexAppInventoryResponse(method, [], params),
    });
    const second = buildCodexPluginThreadConfigInputFingerprint({
      pluginConfig: { codexPlugins: { enabled: true } },
      appCacheKey: "runtime-a",
    });
    const third = buildCodexPluginThreadConfigInputFingerprint({
      pluginConfig: { codexPlugins: { enabled: true } },
      appCacheKey: "runtime-b",
    });
    expect(second).toBe(first);
    expect(third).not.toBe(second);
  });

  it("uses app-level destructive policy for plugins without OpenClaw tool-name knowledge", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) =>
        codexAppInventoryResponse(method, [appInfo("github-app", true)], params),
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          allow_destructive_actions: false,
          plugins: {
            github: {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "github",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method) => {
        if (method === "config/read") {
          return { config: {}, layers: [] };
        }
        if (method === "plugin/installed" || method === "plugin/list") {
          return pluginList([pluginSummary("github", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read") {
          return pluginDetail("github", [appSummary("github-app")], ["github"]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    const apps = config.configPatch?.apps as Record<string, unknown> | undefined;
    expect(apps?.["github-app"]).toEqual({
      enabled: true,
      destructive_enabled: false,
      open_world_enabled: true,
      default_tools_approval_mode: "auto",
    });
    expect(apps?.["github-app"]).not.toHaveProperty("tools");
  });

  it("merges app config with native hook config", () => {
    expect(
      mergeCodexThreadConfigs(
        { "features.hooks": true, hooks: { PreToolUse: [] } },
        { apps: { _default: { enabled: false } } },
      ),
    ).toEqual({
      "features.hooks": true,
      hooks: { PreToolUse: [] },
      apps: { _default: { enabled: false } },
    });
  });

  it("builds a diagnostic deny-all fallback after plugin config timeout", () => {
    const fallback = buildCodexPluginThreadConfigTimeoutFallback({
      pluginConfig: { codexPlugins: { enabled: true } },
      appCacheKey: "runtime",
      message: "Plugin discovery timed out.",
    });

    expect(fallback.configPatch?.apps).toEqual({
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
    });
    expect(fallback.diagnostics).toEqual([
      { code: "plugin_config_timeout", message: "Plugin discovery timed out." },
    ]);
  });

  it("bounds a coalesced metadata wait by the caller's shared deadline", async () => {
    const metadataCache = new CodexPluginMetadataCache();
    let release: ((response: v2.PluginInstalledResponse) => void) | undefined;
    const pending = metadataCache.load({
      appCacheKey: "runtime",
      queryKind: "installed",
      requestParams: {},
      request: async () =>
        await new Promise<v2.PluginInstalledResponse>((resolve) => {
          release = resolve;
        }),
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const request = vi.fn(async () => pluginList([]));

    const config = await createCodexPluginThreadConfigStartupProvider({
      inputFingerprint: undefined,
      enabledPluginConfigKeys: undefined,
      policy: undefined,
      requestTimeoutMs: 100,
      signal: new AbortController().signal,
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            calendar: {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "calendar",
            },
          },
        },
      },
      appCache: new CodexAppInventoryCache(),
      appCacheKey: "runtime",
      metadataCache,
      client: { request },
    }).build();

    expect(config.diagnostics).toEqual([
      expect.objectContaining({ code: "plugin_config_timeout" }),
    ]);
    expect(request).not.toHaveBeenCalled();
    release?.(pluginInstalled([]));
    await pending;
  });

  it("allows a long-running app server to use its full plugin startup budget", async () => {
    const request = vi.fn(
      async (
        method: string,
        _params: unknown,
        _options: { timeoutMs: number; signal: AbortSignal },
      ) => (method === "plugin/installed" ? pluginInstalled([]) : pluginList([])),
    );

    await createCodexPluginThreadConfigStartupProvider({
      inputFingerprint: undefined,
      enabledPluginConfigKeys: undefined,
      policy: undefined,
      requestTimeoutMs: 240_000,
      signal: new AbortController().signal,
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            calendar: {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "calendar",
            },
          },
        },
      },
      appCache: new CodexAppInventoryCache(),
      appCacheKey: "runtime-long-startup",
      metadataCache: new CodexPluginMetadataCache(),
      client: { request },
    }).build();

    expect(request).toHaveBeenCalled();
    const timeoutMs = request.mock.calls[0]?.[2]?.timeoutMs;
    expect(timeoutMs).toBeGreaterThan(55_000);
    expect(timeoutMs).toBeLessThanOrEqual(60_000);
  });

  it("evaluates app metadata and effective config against the resumed thread", async () => {
    const installedStates: Array<{ threadId?: string; enabled: boolean; callable: boolean }> = [];
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "plugin/installed") {
        return pluginInstalled([
          pluginSummary("google-calendar", { installed: true, enabled: true }),
        ]);
      }
      if (method === "plugin/read") {
        return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
      }
      if (method === "app/installed" || method === "app/read") {
        const isResumedThread =
          (params as { threadId?: string } | undefined)?.threadId === "thread-149";
        if (method === "app/installed") {
          installedStates.push({
            ...((params as { threadId?: string } | undefined)?.threadId
              ? { threadId: (params as { threadId: string }).threadId }
              : {}),
            enabled: isResumedThread,
            callable: isResumedThread,
          });
        }
        return codexAppInventoryResponse(
          method,
          [appInfo("google-calendar-app", true, isResumedThread)],
          params as CodexAppServerRequestParams<typeof method>,
          {
            callableByAppId: {
              "google-calendar-app": isResumedThread,
            },
          },
        );
      }
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      throw new Error(`unexpected request ${method}`);
    });

    const buildConfig = (threadId?: string) =>
      createCodexPluginThreadConfigStartupProvider({
        inputFingerprint: undefined,
        enabledPluginConfigKeys: ["google-calendar"],
        policy: undefined,
        requestTimeoutMs: 1_000,
        signal: new AbortController().signal,
        pluginConfig: {
          codexPlugins: {
            enabled: true,
            plugins: {
              "google-calendar": {
                marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
                pluginName: "google-calendar",
              },
            },
          },
        },
        configCwd: "/workspace/project",
        appCache: new CodexAppInventoryCache(),
        appCacheKey: "runtime",
        metadataCache: new CodexPluginMetadataCache(),
        client: { request },
      }).build(threadId ? { threadId } : {});

    const resumedConfig = await buildConfig("thread-149");
    const defaultConfig = await buildConfig();

    expect(resumedConfig.configPatch?.apps).toHaveProperty("google-calendar-app");
    expect(defaultConfig.configPatch?.apps).toHaveProperty("google-calendar-app");
    expect(installedStates).toEqual([
      { threadId: "thread-149", enabled: true, callable: true },
      { enabled: false, callable: false },
    ]);
    expect(request.mock.calls.find(([method]) => method === "app/installed")?.[1]).toEqual({
      forceRefresh: true,
      threadId: "thread-149",
    });
    expect(request.mock.calls.find(([method]) => method === "app/read")?.[1]).toEqual({
      appIds: ["google-calendar-app"],
      includeTools: true,
      threadId: "thread-149",
    });
    expect(request.mock.calls.find(([method]) => method === "config/read")?.[1]).toEqual({
      includeLayers: true,
      cwd: "/workspace/project",
    });
  });

  it("propagates an outer abort while waiting on coalesced metadata", async () => {
    const metadataCache = new CodexPluginMetadataCache();
    let release: ((response: v2.PluginInstalledResponse) => void) | undefined;
    const pending = metadataCache.load({
      appCacheKey: "runtime",
      queryKind: "installed",
      requestParams: {},
      request: async () =>
        await new Promise<v2.PluginInstalledResponse>((resolve) => {
          release = resolve;
        }),
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const controller = new AbortController();
    const build = createCodexPluginThreadConfigStartupProvider({
      inputFingerprint: undefined,
      enabledPluginConfigKeys: undefined,
      policy: undefined,
      requestTimeoutMs: 1_000,
      signal: controller.signal,
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            calendar: {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "calendar",
            },
          },
        },
      },
      appCacheKey: "runtime",
      metadataCache,
      client: { request: vi.fn(async () => pluginList([])) },
    }).build();
    controller.abort(new Error("outer abort"));

    await expect(build).rejects.toThrow("outer abort");
    release?.(pluginInstalled([]));
    await pending;
  });

  it("does not start plugin discovery when the outer signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("outer abort"));
    const request = vi.fn(async () => pluginList([]));

    await expect(
      createCodexPluginThreadConfigStartupProvider({
        inputFingerprint: undefined,
        enabledPluginConfigKeys: undefined,
        policy: undefined,
        requestTimeoutMs: 1_000,
        signal: controller.signal,
        pluginConfig: { codexPlugins: { enabled: true } },
        appCacheKey: "runtime",
        client: { request },
      }).build(),
    ).rejects.toThrow("outer abort");
    expect(request).not.toHaveBeenCalled();
  });

  it("settles a missing plugin from one successful metadata snapshot", async () => {
    const appCache = new CodexAppInventoryCache();
    const metadataCache = new CodexPluginMetadataCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) => codexAppInventoryResponse(method, [], params),
    });
    const pluginConfig = {
      codexPlugins: {
        enabled: true,
        plugins: {
          calendar: {
            marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
            pluginName: "calendar",
          },
        },
      },
    };
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method !== "plugin/installed" && method !== "plugin/list") {
        throw new Error(`unexpected request ${method}`);
      }
      expect(params).toEqual({});
      return method === "plugin/installed"
        ? pluginInstalled([], { name: "openai-curated-remote", path: null })
        : pluginList([], { name: "openai-curated-remote", path: null });
    });
    const build = () =>
      buildCodexPluginThreadConfig({
        pluginConfig,
        appCache,
        appCacheKey: "runtime",
        metadataCache,
        nowMs: 1,
        request,
      });

    const first = await build();
    const second = await build();

    expect(first.diagnostics.map((diagnostic) => diagnostic.code)).toContain("plugin_missing");
    expect(second.diagnostics.map((diagnostic) => diagnostic.code)).toContain("plugin_missing");
    expect(request.mock.calls.filter(([method]) => method === "plugin/list")).toHaveLength(1);
    expect(
      resolveRecoverableCodexPluginConfigKeys({
        policy: first.inventory?.policy ?? second.inventory!.policy,
        metadataCache,
        appCacheKey: "runtime",
      }),
    ).toEqual([]);
    expect(second.configPatch?.apps).toEqual({
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
    });
  });

  it("marks missing and changed plugin app bindings stale only when relevant", () => {
    expect(
      isCodexPluginThreadBindingStale({
        codexPluginsEnabled: true,
        currentInputFingerprint: "input-2",
      }),
    ).toBe(true);
    expect(
      isCodexPluginThreadBindingStale({
        codexPluginsEnabled: true,
        bindingFingerprint: "config-1",
        bindingInputFingerprint: "input-1",
        currentInputFingerprint: "input-2",
        hasBindingPolicyContext: true,
      }),
    ).toBe(true);
    expect(
      isCodexPluginThreadBindingStale({
        codexPluginsEnabled: true,
        bindingFingerprint: "config-1",
        bindingInputFingerprint: "input-1",
        currentInputFingerprint: "input-1",
        hasBindingPolicyContext: true,
      }),
    ).toBe(false);
    expect(
      isCodexPluginThreadBindingStale({
        codexPluginsEnabled: false,
        bindingFingerprint: "config-1",
        bindingInputFingerprint: "input-1",
        hasBindingPolicyContext: true,
      }),
    ).toBe(true);
  });
});

function pluginInstalled(
  plugins: v2.PluginSummary[],
  marketplace: { name?: string; path?: string | null } = {},
): v2.PluginInstalledResponse {
  const { featuredPluginIds: _featuredPluginIds, ...installed } = pluginList(plugins, marketplace);
  return installed;
}

function pluginList(
  plugins: v2.PluginSummary[],
  marketplace: { name?: string; path?: string | null } = {},
): v2.PluginListResponse {
  return {
    marketplaces: [
      {
        name: marketplace.name ?? CODEX_PLUGINS_MARKETPLACE_NAME,
        path: marketplace.path === undefined ? "/marketplaces/openai-curated" : marketplace.path,
        interface: null,
        plugins,
      },
    ],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  };
}

function pluginSummary(id: string, overrides: Partial<v2.PluginSummary> = {}): v2.PluginSummary {
  return {
    id,
    name: id,
    source: { type: "remote" },
    installed: false,
    enabled: false,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_USE",
    availability: "AVAILABLE",
    interface: null,
    ...overrides,
  };
}

function pluginDetail(
  pluginName: string,
  apps: v2.AppSummary[],
  mcpServers: string[] = [],
  marketplace: { marketplaceName?: string; marketplacePath?: string | null } = {},
): v2.PluginReadResponse {
  return {
    plugin: {
      marketplaceName: marketplace.marketplaceName ?? CODEX_PLUGINS_MARKETPLACE_NAME,
      marketplacePath:
        marketplace.marketplacePath === undefined
          ? "/marketplaces/openai-curated"
          : marketplace.marketplacePath,
      summary: pluginSummary(pluginName, { installed: true, enabled: true }),
      description: null,
      skills: [],
      apps,
      mcpServers,
    },
  };
}

function appSummary(id: string): v2.AppSummary {
  return {
    id,
    name: id,
    description: null,
    installUrl: null,
    category: null,
  };
}

function appInfo(id: string, accessible: boolean, enabled = true): v2.AppInfo {
  return {
    id,
    name: id,
    description: null,
    logoUrl: null,
    logoUrlDark: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: null,
    isAccessible: accessible,
    isEnabled: enabled,
    pluginDisplayNames: [],
  };
}

async function buildReadyGoogleCalendarThreadConfig(
  pluginConfig: unknown,
): Promise<Awaited<ReturnType<typeof buildCodexPluginThreadConfig>>> {
  const appCache = new CodexAppInventoryCache();
  await appCache.refreshNow({
    key: "runtime",
    nowMs: 0,
    request: async (method, params) =>
      codexAppInventoryResponse(method, [appInfo("google-calendar-app", true)], params),
  });

  return buildCodexPluginThreadConfig({
    pluginConfig,
    appCache,
    appCacheKey: "runtime",
    nowMs: 1,
    request: async (method) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
      }
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      throw new Error(`unexpected request ${method}`);
    },
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
