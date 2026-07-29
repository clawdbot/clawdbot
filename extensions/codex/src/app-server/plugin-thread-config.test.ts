// Codex tests cover plugin thread config plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import type { CodexAppsInstalledParams } from "./app-inventory-protocol.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import { CodexAppServerRpcError } from "./client.js";
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
import type { v2 } from "./protocol.js";

describe("Codex plugin thread config", () => {
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
        if (method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
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
        if (method === "plugin/list") {
          return (params as v2.PluginListParams).marketplaceKinds
            ? pluginList(
                [
                  pluginSummary("workspace-data@workspace-directory", {
                    remotePluginId: "plugin_workspace_data",
                    installed: true,
                    enabled: true,
                  }),
                ],
                { name: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME, path: null },
              )
            : pluginList([]);
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

    expect(methods).toStrictEqual(["plugin/list", "plugin/list", "plugin/read"]);
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
    const request = vi.fn(async (method: string) => {
      if (method === "plugin/list") {
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
        if (configReadCount > 1) {
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
                    approvalMode: "approve",
                  },
                },
              },
            },
          },
        };
      }
      if (method === "config/value/write") {
        return {};
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
    expect(request).toHaveBeenCalledWith("config/value/write", {
      keyPath: 'apps."google-calendar-app".tools."calendar/create".approval_mode',
      value: null,
      mergeStrategy: "replace",
    });
    expect(request).toHaveBeenCalledWith("config/value/write", {
      keyPath: 'apps."google-calendar-app".tools."calendar/update".approval_mode',
      value: null,
      mergeStrategy: "replace",
    });
    expect(request).not.toHaveBeenCalledWith("config/value/write", {
      keyPath: 'apps."google-calendar-app".tools',
      value: null,
      mergeStrategy: "replace",
    });
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

  it("omits ask policy apps when cwd effective approval overrides remain after cleanup", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) =>
        codexAppInventoryResponse(method, [appInfo("google-calendar-app", true)], params),
    });
    let configReadCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "plugin/list") {
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
        return {
          config: {
            apps: {
              "google-calendar-app": {
                tools: {
                  "calendar/create": {
                    approval_mode: "approve",
                    source: configReadCount === 1 ? "user" : "project",
                  },
                },
              },
            },
          },
        };
      }
      if (method === "config/value/write") {
        return { status: "ok" };
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
        codexAppInventoryResponse(method, [appInfo("google-calendar-app", true, false)], params),
    });
    const request = vi.fn(async (method: string) => {
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, [appInfo("google-calendar-app", true, false)]);
      }
      if (method === "plugin/list") {
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
        return {
          config: {
            apps: {
              "google-calendar-app": {
                tools: {
                  "calendar/create": {
                    approval_mode: "approve",
                  },
                },
              },
            },
          },
        };
      }
      if (method === "config/value/write") {
        return { status: "okOverridden" };
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
      request: async (method) => {
        if (method === "plugin/list") {
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

  it("exposes only ready account apps while preserving callable-tool denies", async () => {
    const pluginConfig = {
      codexPlugins: {
        enabled: true,
        allow_all_plugins: true,
        allow_destructive_actions: false,
      },
    };
    expect(shouldBuildCodexPluginThreadConfig(pluginConfig)).toBe(true);
    const installedParams: CodexAppsInstalledParams[] = [];
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
        if (method !== "app/installed" && method !== "app/read") {
          throw new Error(`unexpected request ${method}`);
        }
        if (method === "app/installed") {
          installedParams.push(rawParams as CodexAppsInstalledParams);
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
        destructiveApprovalMode: "deny",
        mcpServerNames: [],
      },
      slack: {
        source: "account",
        appName: "Slack",
        allowDestructiveActions: false,
        destructiveApprovalMode: "deny",
        mcpServerNames: [],
      },
    });
    expect(config.provisionalAppIds).toBeUndefined();
    expect(config.diagnostics).toStrictEqual([]);
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

  it("clears durable approval overrides for account apps in ask mode", async () => {
    let configReadCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, [
          { ...appInfo("chatgpt-meetings", true), name: "ChatGPT Meetings" },
        ]);
      }
      if (method === "config/read") {
        configReadCount += 1;
        return {
          config: {
            apps: {
              "chatgpt-meetings": {
                tools:
                  configReadCount === 1 ? { import_meeting: { approval_mode: "approve" } } : {},
              },
            },
          },
        };
      }
      if (method === "config/value/write") {
        return { status: "ok" };
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
    expect(request).toHaveBeenCalledWith("config/value/write", {
      keyPath: 'apps."chatgpt-meetings".tools."import_meeting".approval_mode',
      value: null,
      mergeStrategy: "replace",
    });
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
      request: async (method) => {
        if (method === "plugin/list") {
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
    const installedParams: CodexAppsInstalledParams[] = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "app/installed" || method === "app/read") {
        if (method === "app/installed") {
          installedParams.push(params as CodexAppsInstalledParams);
        }
        return codexAppInventoryResponse(method, [appInfo("google-calendar-app", true)]);
      }
      if (method === "plugin/list") {
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

  it("provisionally exposes a base-disabled installed plugin app", async () => {
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
      request: async (method, params) => {
        if (method === "app/installed" || method === "app/read") {
          return codexAppInventoryResponse(method, [appInfo("google-calendar-app", true, false)]);
        }
        if (method === "config/read") {
          expect(params).toEqual({ includeLayers: true });
          return {
            config: {},
            layers: [
              {
                name: "user",
                config: {
                  apps: {
                    _default: {
                      enabled: false,
                    },
                  },
                },
                disabledReason: null,
              },
            ],
          };
        }
        if (method === "plugin/list") {
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
        accessible: false,
        enabled: false,
        needsAuth: true,
      },
    ]);
    expect(config.configPatch?.apps).toMatchObject({
      "google-calendar-app": {
        enabled: true,
      },
    });
    expect(config.provisionalAppIds).toEqual(["google-calendar-app"]);
    expect(config.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "app_not_ready" }),
    );
  });

  it("does not override an explicit app-specific disable from Codex config", async () => {
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
                name: "project",
                config: {
                  apps: {
                    "google-calendar-app": {
                      enabled: false,
                    },
                  },
                },
                disabledReason: null,
              },
            ],
          };
        }
        if (method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read") {
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.configPatch?.apps).not.toHaveProperty("google-calendar-app");
    expect(config.provisionalAppIds).toBeUndefined();
    expect(config.diagnostics).toContainEqual(expect.objectContaining({ code: "app_not_ready" }));
  });

  it("uses the highest-precedence app-specific Codex config value", async () => {
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
                name: "project",
                config: {
                  apps: {
                    "google-calendar-app": {
                      enabled: true,
                    },
                  },
                },
                disabledReason: null,
              },
              {
                name: "user",
                config: {
                  apps: {
                    "google-calendar-app": {
                      enabled: false,
                    },
                  },
                },
                disabledReason: null,
              },
            ],
          };
        }
        if (method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read") {
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.configPatch?.apps).toMatchObject({
      "google-calendar-app": {
        enabled: true,
      },
    });
    expect(config.provisionalAppIds).toEqual(["google-calendar-app"]);
  });

  it("fails closed when Codex config layers cannot be inspected", async () => {
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
          throw new Error("config unavailable");
        }
        if (method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read") {
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.configPatch?.apps).not.toHaveProperty("google-calendar-app");
    expect(config.provisionalAppIds).toBeUndefined();
    expect(config.diagnostics).toContainEqual(expect.objectContaining({ code: "app_not_ready" }));
  });

  it("does not expose an enabled installed plugin app without callable tools", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) =>
        codexAppInventoryResponse(method, [appInfo("google-calendar-app", false)], params),
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
          return codexAppInventoryResponse(method, [appInfo("google-calendar-app", false)]);
        }
        if (method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read") {
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.configPatch?.apps).not.toHaveProperty("google-calendar-app");
    expect(config.provisionalAppIds).toBeUndefined();
    expect(config.diagnostics).toContainEqual(expect.objectContaining({ code: "app_not_ready" }));
  });

  it("does not provisionally expose a disabled app from the legacy inventory fallback", async () => {
    const appCache = new CodexAppInventoryCache();
    const disabledApp = appInfo("google-calendar-app", true, false);
    const request = vi.fn(async (method: string) => {
      if (method === "app/installed") {
        throw new CodexAppServerRpcError({ code: -32601, message: "Method not found" }, method);
      }
      if (method === "app/list") {
        return codexAppInventoryResponse("app/list", [disabledApp]);
      }
      if (method === "plugin/list") {
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
      nowMs: 0,
      request,
    });

    expect(config.configPatch?.apps).not.toHaveProperty("google-calendar-app");
    expect(config.provisionalAppIds).toBeUndefined();
    expect(config.diagnostics).toContainEqual(expect.objectContaining({ code: "app_not_ready" }));
  });

  it("refreshes missing app inventory when plugin activation becomes unnecessary", async () => {
    const appCache = new CodexAppInventoryCache();
    const installedParams: CodexAppsInstalledParams[] = [];
    let pluginListCalls = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "plugin/list") {
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
          installedParams.push(params as CodexAppsInstalledParams);
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
        if (method === "plugin/list") {
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
        if (method === "plugin/list") {
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
    const installedParams: CodexAppsInstalledParams[] = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
      }
      if (method === "app/installed" || method === "app/read") {
        if (method === "app/installed") {
          installedParams.push(params as CodexAppsInstalledParams);
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
    const installedParams: CodexAppsInstalledParams[] = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "plugin/list") {
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
          installedParams.push(params as CodexAppsInstalledParams);
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
      destructiveApprovalMode: "allow",
      mcpServerNames: [],
    });
    expect(config.diagnostics).toStrictEqual([]);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "plugin/list",
      "plugin/read",
      "plugin/install",
      "plugin/list",
      "skills/list",
      "hooks/list",
      "config/mcpServer/reload",
      "app/installed",
      "app/read",
      "app/installed",
      "app/read",
      "plugin/read",
    ]);
    expect(installedParams).toEqual([{ forceRefresh: true }, { forceRefresh: true }]);
  });

  it("installs an unconfigured remote plugin before waiting for app inventory", async () => {
    const appCache = new CodexAppInventoryCache();
    let installed = false;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "plugin/list") {
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
        if (method === "plugin/list") {
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
        if (method === "plugin/list") {
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
        if (method === "plugin/list") {
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
        if (method === "plugin/list") {
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
    let release: ((response: v2.PluginListResponse) => void) | undefined;
    const pending = metadataCache.load({
      appCacheKey: "runtime",
      queryKind: "curated-global",
      requestParams: {},
      request: async () =>
        await new Promise<v2.PluginListResponse>((resolve) => {
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
    release?.(pluginList([]));
    await pending;
  });

  it("allows a long-running app server to use its full plugin startup budget", async () => {
    const request = vi.fn(
      async (
        _method: string,
        _params: unknown,
        _options: { timeoutMs: number; signal: AbortSignal },
      ) => pluginList([]),
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

  it("propagates an outer abort while waiting on coalesced metadata", async () => {
    const metadataCache = new CodexPluginMetadataCache();
    let release: ((response: v2.PluginListResponse) => void) | undefined;
    const pending = metadataCache.load({
      appCacheKey: "runtime",
      queryKind: "curated-global",
      requestParams: {},
      request: async () =>
        await new Promise<v2.PluginListResponse>((resolve) => {
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
    release?.(pluginList([]));
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
      if (method !== "plugin/list") {
        throw new Error(`unexpected request ${method}`);
      }
      expect(params).toEqual({});
      return pluginList([], { name: "openai-curated-remote", path: null });
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
    expect(request).toHaveBeenCalledTimes(1);
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
    needsAuth: false,
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
      if (method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
      }
      if (method === "config/read") {
        return { config: {} };
      }
      throw new Error(`unexpected request ${method}`);
    },
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
