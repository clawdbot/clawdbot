import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
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

function fixture(
  options: {
    threadId?: string | null;
    appCount?: number;
    disabled?: boolean;
    blocked?: boolean;
    runtime?: v2.InstalledApp[];
    failMethod?: string;
    unsupported?: boolean;
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
        response = {
          apps:
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
