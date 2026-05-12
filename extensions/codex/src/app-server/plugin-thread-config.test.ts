import { describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "./config.js";
import {
  buildCodexPluginThreadConfig,
  buildCodexPluginThreadConfigInputFingerprint,
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
      request: async () => ({
        data: [appInfo("google-calendar-app", true)],
        nextCursor: null,
      }),
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
    expect(config.policyContext.apps["google-calendar-app"]).toEqual({
      configKey: "google-calendar",
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
      pluginName: "google-calendar",
      allowDestructiveActions: true,
      mcpServerNames: ["google-calendar"],
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
    expect(disabledApps?.["google-calendar-app"]).not.toHaveProperty("tools");
    expect(
      pluginOverrideDisabled.policyContext.apps["google-calendar-app"]?.allowDestructiveActions,
    ).toBe(false);

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
    expect(
      pluginOverrideEnabled.policyContext.apps["google-calendar-app"]?.allowDestructiveActions,
    ).toBe(true);
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
    const request = vi.fn(async (method: string) => {
      if (method === "app/list") {
        return { data: [appInfo("google-calendar-app", true)], nextCursor: null };
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
      mcpServerNames: [],
    });
    expect(config.diagnostics).toStrictEqual([]);
    expect(
      request.mock.calls.reduce((count, [method]) => count + (method === "app/list" ? 1 : 0), 0),
    ).toBe(1);
  });

  it("does not expose plugin apps missing from the app inventory snapshot", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async () => ({
        data: [],
        nextCursor: null,
      }),
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
        },
        message: "google-calendar-app is not accessible or enabled for google-calendar.",
      },
    ]);
  });

  it("re-reads app readiness after re-enabling an installed plugin", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async () => ({
        data: [appInfo("google-calendar-app", true, false)],
        nextCursor: null,
      }),
    });
    let enabled = false;
    const appListParams: v2.AppsListParams[] = [];
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
      if (method === "app/list") {
        appListParams.push(params as v2.AppsListParams);
        return {
          data: [appInfo("google-calendar-app", true, enabled)],
          nextCursor: null,
        } satisfies v2.AppsListResponse;
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
      mcpServerNames: [],
    });
    expect(config.diagnostics).toStrictEqual([]);
    expect(request.mock.calls.map(([method]) => method)).toContain("plugin/install");
    expect(request.mock.calls.some(([method]) => method === "app/list")).toBe(true);
    expect(appListParams.map((params) => params.forceRefetch)).toContain(true);
  });

  it("surfaces critical post-install refresh failures and keeps plugin apps disabled", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async () => ({
        data: [appInfo("google-calendar-app", true)],
        nextCursor: null,
      }),
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
        if (method === "app/list") {
          throw new Error("app/list unavailable");
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
    expect(config.diagnostics.map((diagnostic) => diagnostic.code)).toStrictEqual([
      "app_inventory_missing",
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
      request: async () => ({ data: [], nextCursor: null }),
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
      request: async () => ({
        data: [appInfo("github-app", true)],
        nextCursor: null,
      }),
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
        { "features.codex_hooks": true, hooks: { PreToolUse: [] } },
        { apps: { _default: { enabled: false } } },
      ),
    ).toEqual({
      "features.codex_hooks": true,
      hooks: { PreToolUse: [] },
      apps: { _default: { enabled: false } },
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

function pluginList(plugins: v2.PluginSummary[]): v2.PluginListResponse {
  return {
    marketplaces: [
      {
        name: CODEX_PLUGINS_MARKETPLACE_NAME,
        path: "/marketplaces/openai-curated",
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
): v2.PluginReadResponse {
  return {
    plugin: {
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
      marketplacePath: "/marketplaces/openai-curated",
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
    request: async () => ({
      data: [appInfo("google-calendar-app", true)],
      nextCursor: null,
    }),
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
      throw new Error(`unexpected request ${method}`);
    },
  });
}
