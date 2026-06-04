import { describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME, type ResolvedCodexPluginPolicy } from "./config.js";
import {
  ensureCodexAppsSubstrateConfig,
  ensureCodexPluginActivation,
  upsertTomlBoolean,
} from "./plugin-activation.js";
import type { v2 } from "./protocol.js";

describe("Codex plugin activation", () => {
  function expectActivationResult(
    result: Awaited<ReturnType<typeof ensureCodexPluginActivation>>,
    expected: { ok: boolean; reason: string; installAttempted: boolean },
  ) {
    expect(result.ok).toBe(expected.ok);
    expect(result.reason).toBe(expected.reason);
    expect(result.installAttempted).toBe(expected.installAttempted);
  }

  function expectBooleanParam(params: unknown, key: string, expected: boolean) {
    expect((params as Record<string, unknown> | undefined)?.[key]).toBe(expected);
  }

  it("skips plugin/install when the migrated plugin is already active", async () => {
    const calls: string[] = [];
    const result = await ensureCodexPluginActivation({
      identity: identity("google-calendar"),
      request: async (method) => {
        calls.push(method);
        if (method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expectActivationResult(result, {
      ok: true,
      reason: "already_active",
      installAttempted: false,
    });
    expect(calls).toEqual(["plugin/list"]);
  });

  it("can reinstall an already active plugin when migration explicitly applies it", async () => {
    const calls: string[] = [];
    const result = await ensureCodexPluginActivation({
      identity: identity("google-calendar"),
      installEvenIfActive: true,
      request: async (method, params) => {
        calls.push(method);
        if (method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/install") {
          expect(params).toEqual({
            marketplacePath: "/marketplaces/openai-curated",
            pluginName: "google-calendar",
          });
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
        throw new Error(`unexpected request ${method}`);
      },
    });

    expectActivationResult(result, {
      ok: true,
      reason: "already_active",
      installAttempted: true,
    });
    expect(calls).toEqual([
      "plugin/list",
      "plugin/install",
      "plugin/list",
      "skills/list",
      "hooks/list",
      "config/mcpServer/reload",
    ]);
  });

  it("installs a migration-authorized local curated plugin and refreshes runtime state", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const appCache = new CodexAppInventoryCache();
    const result = await ensureCodexPluginActivation({
      identity: identity("google-calendar"),
      appCache,
      appCacheKey: "runtime",
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "plugin/list") {
          return pluginList([
            pluginSummary("google-calendar", { installed: false, enabled: false }),
          ]);
        }
        if (method === "plugin/install") {
          expect(params).toEqual({
            marketplacePath: "/marketplaces/openai-curated",
            pluginName: "google-calendar",
          });
          return { authPolicy: "ON_USE", appsNeedingAuth: [] } satisfies v2.PluginInstallResponse;
        }
        if (method === "skills/list") {
          expectBooleanParam(params, "forceReload", true);
          return { data: [] } satisfies v2.SkillsListResponse;
        }
        if (method === "hooks/list") {
          return { data: [] } satisfies v2.HooksListResponse;
        }
        if (method === "config/mcpServer/reload") {
          return {};
        }
        if (method === "app/list") {
          expectBooleanParam(params, "forceRefetch", true);
          return { data: [], nextCursor: null } satisfies v2.AppsListResponse;
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expectActivationResult(result, {
      ok: true,
      reason: "installed",
      installAttempted: true,
    });
    expect(calls.map((call) => call.method)).toEqual([
      "plugin/list",
      "plugin/install",
      "plugin/list",
      "skills/list",
      "hooks/list",
      "config/mcpServer/reload",
      "app/list",
    ]);
    expect(appCache.getRevision()).toBeGreaterThan(0);
  });

  it("keeps activation fail-closed when post-install app inventory refresh fails", async () => {
    const appCache = new CodexAppInventoryCache();
    const result = await ensureCodexPluginActivation({
      identity: identity("google-calendar"),
      appCache,
      appCacheKey: "runtime",
      request: async (method) => {
        if (method === "plugin/list") {
          return pluginList([
            pluginSummary("google-calendar", { installed: false, enabled: false }),
          ]);
        }
        if (method === "plugin/install") {
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
          throw new Error("app/list unavailable");
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expectActivationResult(result, {
      ok: true,
      reason: "installed",
      installAttempted: true,
    });
    expect(result.diagnostics).toEqual([
      {
        message: "Codex app inventory refresh skipped: app/list unavailable",
      },
    ]);
    expect(appCache.getRevision()).toBeGreaterThan(0);
  });

  it("reports post-install runtime refresh failures without hiding the install attempt", async () => {
    const result = await ensureCodexPluginActivation({
      identity: identity("google-calendar"),
      request: async (method) => {
        if (method === "plugin/list") {
          return pluginList([
            pluginSummary("google-calendar", { installed: false, enabled: false }),
          ]);
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

    expectActivationResult(result, {
      ok: false,
      reason: "refresh_failed",
      installAttempted: true,
    });
    expect(result.diagnostics).toEqual([
      {
        message: "Codex plugin runtime refresh failed after install: skills/list unavailable",
      },
    ]);
  });

  it("installs from a remote curated marketplace when no local marketplace path is present", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const result = await ensureCodexPluginActivation({
      identity: identity("google-calendar"),
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "plugin/list") {
          return {
            ...pluginList([pluginSummary("google-calendar", { installed: false, enabled: false })]),
            marketplaces: [
              {
                name: CODEX_PLUGINS_MARKETPLACE_NAME,
                path: null,
                interface: null,
                plugins: [pluginSummary("google-calendar", { installed: false, enabled: false })],
              },
            ],
          } satisfies v2.PluginListResponse;
        }
        if (method === "plugin/install") {
          expect(params).toEqual({
            remoteMarketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
            pluginName: "google-calendar",
          });
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
        throw new Error(`unexpected request ${method}`);
      },
    });

    expectActivationResult(result, {
      ok: true,
      reason: "installed",
      installAttempted: true,
    });
    expect(calls.map((call) => call.method)).toEqual([
      "plugin/list",
      "plugin/install",
      "plugin/list",
      "skills/list",
      "hooks/list",
      "config/mcpServer/reload",
    ]);
  });

  it("upserts native apps substrate config without clobbering other toml", async () => {
    const existing = 'model = "gpt-5.5"\n\n[features]\nother = true\n';
    expect(upsertTomlBoolean(existing, "features", "apps", true)).toBe(
      'model = "gpt-5.5"\n\n[features]\nother = true\napps = true\n',
    );

    const writes: Array<{ path: string; content: string }> = [];
    const result = await ensureCodexAppsSubstrateConfig({
      codexHome: "/codex-home",
      readFile: vi.fn(async () => existing),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (filePath, content) => {
        writes.push({ path: String(filePath), content: String(content) });
      }),
    });

    expect(result).toEqual({ changed: true, configPath: "/codex-home/config.toml" });
    expect(writes[0]?.content).toContain("[features]\nother = true\napps = true");
    expect(writes[0]?.content).toContain("[apps._default]\nenabled = true");
  });
});

function identity(pluginName: string): ResolvedCodexPluginPolicy {
  return {
    configKey: pluginName,
    marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
    pluginName,
    enabled: true,
    allowDestructiveActions: false,
  };
}

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
