import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCodexAppInventoryCache } from "./app-server/app-inventory-cache.js";
import type { CodexAppsInstalledParams } from "./app-server/protocol-control-plane.js";
import type { v2 } from "./app-server/protocol.js";
import { CodexAppServerRpcError } from "./app-server/rpc-error.js";
import {
  handleCodexPluginsSubcommand,
  type CodexPluginsManagementIO,
} from "./command-plugins-management.js";
import type { CodexPluginCommandContext } from "./command-plugins-runtime.js";

const ctx: PluginCommandContext = {
  config: {},
  channel: "test",
  isAuthorizedSender: true,
  senderIsOwner: true,
  commandBody: "/codex plugins status notes",
  args: "",
  getCurrentConversationBinding: async () => null,
  requestConversationBinding: async () => ({ status: "error", message: "unused" }),
  detachConversationBinding: async () => ({ removed: false }),
};

afterEach(() => defaultCodexAppInventoryCache.clear());

function fixture(
  options: {
    threadId?: string | null;
    appCount?: number;
    disabled?: boolean;
    blocked?: boolean;
    runtime?: v2.InstalledApp[];
    failMethod?: string;
    unsupported?: boolean;
    refreshError?: Error;
    refreshedRuntime?: v2.InstalledApp[];
    catalog?: { marketplace: string; kind: string };
  } = {},
) {
  const current = {
    enabled: true,
    plugins: {
      notes: {
        marketplaceName: options.catalog?.marketplace ?? "company-tools",
        pluginName: options.catalog ? `notes@${options.catalog.marketplace}` : "notes",
        enabled: !options.disabled,
      },
    },
  };
  const summary: v2.PluginSummary = {
    id: `notes@${options.catalog?.marketplace ?? "company-tools"}`,
    name: "Notes",
    installed: true,
    enabled: true,
    ...(options.catalog ? { remotePluginId: "plugins~Plugin_test_notes" } : {}),
    ...(options.blocked ? { availability: "DISABLED_BY_ADMIN" } : {}),
  };
  const apps: v2.AppSummary[] = Array.from({ length: options.appCount ?? 1 }, (_, index) => ({
    id: `app-${index}`,
    name: `App ${index}`,
    description: null,
    category: null,
    installUrl: `https://chatgpt.com/apps/app-${index}`,
  }));
  const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    if (method === options.failMethod) {
      if (options.unsupported) {
        throw new CodexAppServerRpcError(
          { code: -32601, message: "private upstream response" },
          method,
        );
      }
      throw new Error("private upstream response");
    }
    let response: unknown;
    switch (method) {
      case "account/read":
        response = {
          account: { type: "chatgpt", email: "operator@example.test", planType: "team" },
        };
        break;
      case "plugin/installed":
        response = {
          marketplaces: options.catalog
            ? []
            : [{ name: "company-tools", path: "/test/catalog", plugins: [summary] }],
          marketplaceLoadErrors: [],
        };
        break;
      case "plugin/list": {
        const requested = params as v2.PluginListParams;
        const includesCatalog = requested.marketplaceKinds?.some(
          (kind) => kind === options.catalog?.kind,
        );
        response = {
          marketplaces: includesCatalog
            ? [{ name: options.catalog?.marketplace, plugins: [summary] }]
            : [],
          marketplaceLoadErrors: [],
          featuredPluginIds: [],
        };
        break;
      }
      case "plugin/read":
        response = { plugin: { summary, apps, mcpServers: [] } };
        break;
      case "app/installed":
        if ((params as CodexAppsInstalledParams).forceRefresh && options.refreshError) {
          throw options.refreshError;
        }
        response = {
          apps:
            ((params as CodexAppsInstalledParams).forceRefresh
              ? options.refreshedRuntime
              : undefined) ??
            options.runtime ??
            apps.map((app) => ({
              id: app.id,
              runtimeName: app.name,
              enabled: true,
              callable: true,
            })),
        };
        break;
      case "app/read":
        response = {
          apps: apps.map((app) =>
            Object.assign({}, app, { pluginDisplayNames: ["Notes"], toolSummaries: null }),
          ),
          missingAppIds: [],
        };
        break;
      default:
        throw new Error(`Unexpected method: ${method}`);
    }
    return response;
  });
  const io: CodexPluginsManagementIO = {
    readConfig: vi.fn(async () => structuredClone(current)),
    mutate: vi.fn(),
  };
  const context: CodexPluginCommandContext = {
    request: async <T>(method: string, params?: unknown): Promise<T> =>
      (await request(method, params)) as T,
    workspaceDir: "/workspace/agent-a",
    agentId: "agent-a",
    profileId: "openai:work",
    ...(options.threadId !== null ? { threadId: options.threadId ?? "thread-a" } : {}),
    appCacheKey: "agent-a-only",
    current,
    validateCurrent: vi.fn(async () => {}),
  };
  const runtime = {
    workspaceDir: vi.fn(async () => context.workspaceDir),
    list: vi.fn(),
    install: vi.fn(),
    refresh: vi.fn(),
    withContext: async <T>(run: (value: CodexPluginCommandContext) => Promise<T>): Promise<T> =>
      run(context),
  };
  return { io, context, runtime, request };
}

describe("Codex plugin status command", () => {
  it.each([
    { marketplace: "workspace-directory", kind: "workspace-directory" },
    { marketplace: "workspace-shared-with-me-team", kind: "shared-with-me" },
    { marketplace: "created-by-me-remote", kind: "created-by-me-remote" },
    { marketplace: "custom-vertical", kind: "vertical" },
  ])("discovers configured $marketplace through its catalog kind", async (catalog) => {
    const test = fixture({ catalog });
    const result = await handleCodexPluginsSubcommand(
      ctx,
      ["status", "notes"],
      test.io,
      test.runtime,
    );
    expect(result.text).toContain("callable in this thread's runtime snapshot");
    expect(test.request).toHaveBeenCalledWith("plugin/read", {
      remoteMarketplaceName: catalog.marketplace,
      pluginName: "plugins~Plugin_test_notes",
    });
  });

  it("gives a version-specific action for an unsupported runtime method without exposing its error body", async () => {
    const test = fixture({ failMethod: "app/installed", unsupported: true });
    const result = await handleCodexPluginsSubcommand(
      ctx,
      ["status", "notes"],
      test.io,
      test.runtime,
    );
    expect(result.text).toContain("does not support the required status method");
    expect(result.text).toContain("supported Codex version");
    expect(result.text).not.toContain("private upstream response");
  });

  it("reports exact-thread runtime callability while preserving unknown connection and freshness", async () => {
    const test = fixture();
    const result = await handleCodexPluginsSubcommand(
      ctx,
      ["status", "notes"],
      test.io,
      test.runtime,
    );
    expect(result.text).toContain("callable in this thread's runtime snapshot");
    expect(result.text).toContain("Connection: unknown");
    expect(result.text).toContain("Snapshot freshness is unknown");
    expect(result.text).toContain("Profile: openai:work");
    expect(result.text).toContain("operator@example.test");
    expect(result.text).toContain("https://chatgpt.com/apps/app-0");
    expect(test.request).toHaveBeenCalledWith("app/installed", {
      threadId: "thread-a",
      forceRefresh: false,
    });
    expect(test.request.mock.calls.map(([method]) => method)).toEqual([
      "account/read",
      "plugin/installed",
      "plugin/read",
      "app/installed",
      "app/read",
    ]);
    expect(test.io.mutate).not.toHaveBeenCalled();
    expect(test.runtime.install).not.toHaveBeenCalled();
    expect(test.runtime.refresh).not.toHaveBeenCalled();
  });

  it.each([
    { options: { threadId: null }, expected: "current-thread callability unknown" },
    { options: { runtime: [] }, expected: "unknown: absent or unavailable runtime snapshot" },
    {
      options: { failMethod: "app/installed" },
      expected: "unknown: absent or unavailable runtime snapshot",
    },
    {
      options: {
        runtime: [{ id: "app-0", runtimeName: "App 0", enabled: false, callable: false }],
      },
      expected: "disabled by effective Codex app policy",
    },
    {
      options: { runtime: [{ id: "app-0", runtimeName: "App 0", enabled: true, callable: false }] },
      expected: "not callable in the runtime snapshot",
    },
  ])("keeps $expected distinct from installation", async ({ options, expected }) => {
    const test = fixture(options);
    const result = await handleCodexPluginsSubcommand(
      ctx,
      ["status", "notes"],
      test.io,
      test.runtime,
    );
    expect(result.text).toContain(expected);
    expect(result.text).toContain("Bundle: installed");
    expect(result.text).not.toContain("private upstream response");
  });

  it.each([
    {
      options: { disabled: true },
      expected: "disabled for new conversations",
      next: "/codex plugins enable notes@company-tools",
    },
    {
      options: { blocked: true },
      expected: "blocked by marketplace policy",
      next: "marketplace administrator",
    },
  ])("explains $expected with a next action", async ({ options, expected, next }) => {
    const test = fixture(options);
    const result = await handleCodexPluginsSubcommand(
      ctx,
      ["status", "notes"],
      test.io,
      test.runtime,
    );
    expect(result.text).toContain(expected);
    expect(result.text).toContain(next);
    expect(test.io.mutate).not.toHaveBeenCalled();
  });

  it("paginates every owned app through the real command without exposing unrelated inventory", async () => {
    const test = fixture({
      appCount: 7,
      runtime: [
        { id: "another-agent-app", runtimeName: "Private app", enabled: true, callable: true },
      ],
    });
    const first = await handleCodexPluginsSubcommand(
      ctx,
      ["status", "notes"],
      test.io,
      test.runtime,
    );
    const next = await handleCodexPluginsSubcommand(
      ctx,
      ["status", "notes@company-tools", "2"],
      test.io,
      test.runtime,
    );
    expect(first.text).toContain("page 1/2");
    expect(first.text).not.toContain("Set up / manage App 5");
    expect(first.presentation?.blocks).toContainEqual({
      type: "buttons",
      buttons: [
        {
          label: "More apps",
          action: { type: "command", command: "/codex plugins status notes@company-tools 2" },
        },
      ],
    });
    expect(next.text).toContain("Set up / manage App 6");
    expect(next.text).not.toContain("Private app");
    expect(first.text).not.toContain("another-agent-app");
  });

  it("checks owner authority before reading profile-scoped inventory", async () => {
    const test = fixture();
    const result = await handleCodexPluginsSubcommand(
      { ...ctx, senderIsOwner: false },
      ["status", "notes"],
      test.io,
      test.runtime,
    );
    expect(result.text).toContain("Only an owner or operator.admin");
    expect(test.io.readConfig).not.toHaveBeenCalled();
    expect(test.request).not.toHaveBeenCalled();
  });
});

describe("Codex plugin recheck command", () => {
  it("refreshes account inventory once while retaining the current thread's restricted policy", async () => {
    const test = fixture({
      runtime: [{ id: "app-0", runtimeName: "App 0", enabled: false, callable: false }],
      refreshedRuntime: [{ id: "app-0", runtimeName: "App 0", enabled: true, callable: true }],
    });
    const result = await handleCodexPluginsSubcommand(
      ctx,
      ["recheck", "notes"],
      test.io,
      test.runtime,
    );
    expect(result.text).toContain("App inventory recheck completed");
    expect(result.text).toContain("disabled by effective Codex app policy");
    expect(result.text).toContain("/new or /reset");
    expect(result.text).toContain("Snapshot freshness is unknown");
    expect(result.text).not.toContain("callable in this thread's runtime snapshot");
    expect(test.request.mock.calls.filter(([method]) => method === "app/installed")).toEqual([
      ["app/installed", { threadId: "thread-a", forceRefresh: false }],
      ["app/installed", { forceRefresh: true }],
      ["app/installed", { threadId: "thread-a", forceRefresh: false }],
    ]);
    expect(test.request).toHaveBeenCalledWith("app/read", { appIds: ["app-0"] });
    expect(test.runtime.refresh).not.toHaveBeenCalled();
    expect(test.runtime.install).not.toHaveBeenCalled();
    expect(test.io.mutate).not.toHaveBeenCalled();
  });

  it.each([
    { options: { disabled: true }, expected: "disabled for new conversations" },
    { options: { blocked: true }, expected: "blocked by marketplace policy" },
    { options: { appCount: 0 }, expected: "No hosted apps declared" },
  ])("does not refresh when $expected", async ({ options, expected }) => {
    const test = fixture(options);
    const result = await handleCodexPluginsSubcommand(
      ctx,
      ["recheck", "notes"],
      test.io,
      test.runtime,
    );
    expect(result.text).toContain(expected);
    expect(result.text).not.toContain("recheck completed");
    expect(test.request).not.toHaveBeenCalledWith("app/installed", { forceRefresh: true });
    expect(test.io.mutate).not.toHaveBeenCalled();
  });

  it.each([
    {
      error: new Error("private upstream response"),
      expected: "Hosted app tools could not be refreshed",
    },
    {
      error: new CodexAppServerRpcError(
        { code: -32601, message: "private upstream response" },
        "app/installed",
      ),
      expected: "does not support the required app inventory methods",
    },
    {
      error: Object.assign(new Error("private upstream response"), {
        code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED",
        reason: "aborted",
        mayHaveWritten: true,
      }),
      expected: "The recheck was cancelled",
    },
  ])(
    "reports $expected without claiming success or exposing provider data",
    async ({ error, expected }) => {
      const test = fixture({ refreshError: error });
      const result = await handleCodexPluginsSubcommand(
        ctx,
        ["recheck", "notes"],
        test.io,
        test.runtime,
      );
      expect(result.text).toContain(expected);
      expect(result.text).toContain("/codex plugins recheck notes@company-tools");
      expect(result.text).toContain("Previous inventory was not confirmed");
      expect(result.text).not.toContain("recheck completed");
      expect(result.text).not.toContain("private upstream response");
      expect(test.io.mutate).not.toHaveBeenCalled();
    },
  );

  it("requires owner authority and a configured target before refreshing", async () => {
    const test = fixture();
    const denied = await handleCodexPluginsSubcommand(
      { ...ctx, senderIsOwner: false },
      ["recheck", "notes"],
      test.io,
      test.runtime,
    );
    const missing = await handleCodexPluginsSubcommand(
      ctx,
      ["recheck", "unconfigured"],
      test.io,
      test.runtime,
    );
    const extra = await handleCodexPluginsSubcommand(
      ctx,
      ["recheck", "notes", "2"],
      test.io,
      test.runtime,
    );
    expect(denied.text).toContain("Only an owner or operator.admin");
    expect(missing.text).toContain("not explicitly configured");
    expect(extra.text).toContain("Usage: /codex plugins recheck <configured-plugin>");
    expect(test.request).not.toHaveBeenCalled();
  });
});
