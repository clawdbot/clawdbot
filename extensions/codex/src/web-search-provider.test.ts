import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createCodexWebSearchProvider as createContractCodexWebSearchProvider } from "../web-search-contract-api.js";
import type { CodexAppServerClient } from "./app-server/client.js";
import type { CodexAppServerStartOptions } from "./app-server/config.js";
import type { CodexServerNotification, JsonValue } from "./app-server/protocol.js";
import { createCodexWebSearchProvider } from "./web-search-provider.js";

function codexModel(
  options: {
    id?: string;
    model?: string;
    inputModalities?: string[];
    isDefault?: boolean;
  } = {},
) {
  const id = options.id ?? "gpt-5.5";
  return {
    id,
    model: options.model ?? id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: "gpt-5.5",
    description: "GPT-5.5",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "fast" }],
    defaultReasoningEffort: "low",
    inputModalities: options.inputModalities ?? ["text", "image"],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    isDefault: options.isDefault ?? true,
  };
}

function threadStartResult() {
  return {
    thread: {
      id: "thread-1",
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: true,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: "/tmp/openclaw-agent",
      cliVersion: "0.125.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.5",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/tmp/openclaw-agent",
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

function turnStartResult(status = "inProgress") {
  return {
    turn: {
      id: "turn-1",
      status,
      items: [],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  };
}

function createFakeClient(options?: {
  emitWebSearch?: boolean;
  models?: ReturnType<typeof codexModel>[];
}) {
  const notifications = new Set<(notification: CodexServerNotification) => void>();
  const requests: Array<{ method: string; params?: JsonValue }> = [];
  const request = vi.fn(async (method: string, params?: JsonValue) => {
    requests.push({ method, params });
    if (method === "model/list") {
      return { data: options?.models ?? [codexModel()], nextCursor: null };
    }
    if (method === "thread/start") {
      return threadStartResult();
    }
    if (method === "turn/start") {
      for (const notify of notifications) {
        if (options?.emitWebSearch !== false) {
          notify({
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: {
                id: "search-1",
                type: "webSearch",
                query: "plumbers in Edmonton Alberta",
                action: {
                  type: "search",
                  query: "plumbers in Edmonton Alberta",
                  queries: ["plumbers in Edmonton Alberta"],
                },
              },
            },
          });
        }
        notify({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "msg-1",
            delta: "Two current providers: Example One and Example Two.",
          },
        });
        notify({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: turnStartResult("completed").turn,
          },
        });
      }
      return turnStartResult();
    }
    return {};
  });

  const client = {
    request,
    addNotificationHandler(handler: (notification: CodexServerNotification) => void) {
      notifications.add(handler);
      return () => notifications.delete(handler);
    },
    addRequestHandler() {
      return () => {};
    },
  } as unknown as CodexAppServerClient;

  return { client, requests };
}

function createConfig(): OpenClawConfig {
  return {
    tools: {
      web: {
        search: {
          provider: "codex",
          timeoutSeconds: 30,
          openaiCodex: {
            enabled: true,
            mode: "live",
            allowedDomains: ["example.com"],
            contextSize: "high",
            userLocation: {
              country: "CA",
              region: "Alberta",
              city: "Edmonton",
              timezone: "America/Edmonton",
            },
          },
        },
      },
    },
  };
}

beforeAll(async () => {
  // Execution cases share this lazy runtime. Import it once so the first case
  // does not absorb module initialization that every later case reuses.
  await import("./web-search-provider.runtime.js");
});

describe("codex web search provider", () => {
  it("registers a selectable keyless provider contract", () => {
    const provider = createContractCodexWebSearchProvider();

    expect(provider.id).toBe("codex");
    expect(provider.label).toBe("Codex Hosted Search");
    expect(provider.requiresCredential).toBe(false);
    expect(provider.envVars).toEqual([]);
    expect(provider.autoDetectOrder).toBe(900);
    expect(provider.applySelectionConfig?.({}).plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("honors the explicit Codex hosted-search opt-out", () => {
    const provider = createCodexWebSearchProvider();

    expect(
      provider.createTool({
        searchConfig: { provider: "codex", openaiCodex: { enabled: false } },
      }),
    ).toBeNull();
  });

  it("fails closed when configured app-server transport cannot be isolated", async () => {
    const { client } = createFakeClient();
    const provider = createCodexWebSearchProvider({
      resolvePluginConfig: () => ({
        appServer: {
          transport: "websocket",
          url: "ws://127.0.0.1:4501",
        },
      }),
      clientFactory: async () => client,
    });
    const config = createConfig();
    const tool = provider.createTool({
      config,
      searchConfig: config.tools?.web?.search,
      agentDir: "/tmp/openclaw-agent",
    });

    await expect(tool?.execute({ query: "plumbers in Edmonton Alberta" })).rejects.toThrow(
      "Bounded Codex turns require stdio transport so native tools can be isolated.",
    );
  });

  it("runs an isolated grounded Codex search with configured restrictions", async () => {
    const { client, requests } = createFakeClient();
    let isolatedStartOptions: CodexAppServerStartOptions | undefined;
    const provider = createCodexWebSearchProvider({
      resolvePluginConfig: () => ({
        appServer: {
          args: [
            "app-server",
            "--listen",
            "stdio://",
            "-c",
            "mcp_servers.external.command='unsafe'",
          ],
          clearEnv: ["CODEX_HOME", "KEEP_CLEARED"],
        },
      }),
      clientFactory: async (options) => {
        isolatedStartOptions = options?.startOptions;
        return client;
      },
    });
    const config = createConfig();
    const tool = provider.createTool({
      config,
      searchConfig: config.tools?.web?.search,
      agentDir: "/tmp/openclaw-agent",
    });

    const result = await tool?.execute({ query: "plumbers in Edmonton Alberta" });

    expect(result).toMatchObject({
      query: "plumbers in Edmonton Alberta",
      provider: "codex",
      model: "gpt-5.5",
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: "codex",
        wrapped: true,
      },
      searches: [
        {
          query: "plumbers in Edmonton Alberta",
          queries: ["plumbers in Edmonton Alberta"],
        },
      ],
    });
    expect(result?.content).toContain("Two current providers");
    expect(requests.map((entry) => entry.method)).toEqual([
      "model/list",
      "thread/start",
      "turn/start",
    ]);
    expect(requests[1]?.params).toMatchObject({
      model: "gpt-5.5",
      modelProvider: "openai",
      cwd: expect.any(String),
      approvalPolicy: "on-request",
      sandbox: "read-only",
      environments: [],
      dynamicTools: [],
      ephemeral: true,
      config: {
        "features.code_mode": false,
        "features.code_mode_only": false,
        "features.hooks": false,
        "features.standalone_web_search": false,
        notify: [],
        web_search: "live",
        "tools.web_search.allowed_domains": ["example.com"],
        "tools.web_search.context_size": "high",
        "tools.web_search.location.country": "CA",
        "tools.web_search.location.region": "Alberta",
        "tools.web_search.location.city": "Edmonton",
        "tools.web_search.location.timezone": "America/Edmonton",
      },
    });
    const threadStartCwd = (requests[1]?.params as { cwd?: string } | undefined)?.cwd;
    const isolatedCodexHome = isolatedStartOptions?.env?.CODEX_HOME;
    expect(threadStartCwd).not.toBe("/tmp/openclaw-agent");
    expect(isolatedStartOptions?.args).toEqual(["app-server", "--listen", "stdio://"]);
    expect(isolatedStartOptions?.clearEnv).toEqual([
      "KEEP_CLEARED",
      "OPENCLAW_CODEX_APP_SERVER_ARGS",
    ]);
    expect(isolatedCodexHome).toEqual(expect.any(String));
    if (!threadStartCwd || !isolatedCodexHome) {
      throw new Error("expected isolated Codex home and workspace");
    }
    expect(path.dirname(threadStartCwd)).toBe(path.dirname(isolatedCodexHome));
  });

  it("selects the live default text-capable model", async () => {
    const { client, requests } = createFakeClient({
      models: [
        codexModel({ id: "available-first", isDefault: false }),
        codexModel({ id: "available-default", model: "available-default-wire" }),
      ],
    });
    const provider = createCodexWebSearchProvider({
      clientFactory: async () => client,
    });
    const config = createConfig();
    const tool = provider.createTool({
      config,
      searchConfig: config.tools?.web?.search,
      agentDir: "/tmp/openclaw-agent",
    });

    const result = await tool?.execute({ query: "plumbers in Edmonton Alberta" });

    expect(result?.model).toBe("available-default-wire");
    expect(requests[1]?.params).toEqual(
      expect.objectContaining({ model: "available-default-wire" }),
    );
    expect(requests[2]?.params).toEqual(
      expect.objectContaining({ model: "available-default-wire" }),
    );
  });

  it("fails closed when the live catalog has no text-capable model", async () => {
    const { client, requests } = createFakeClient({
      models: [codexModel({ id: "image-only", inputModalities: ["image"] })],
    });
    const provider = createCodexWebSearchProvider({
      clientFactory: async () => client,
    });
    const config = createConfig();
    const tool = provider.createTool({
      config,
      searchConfig: config.tools?.web?.search,
      agentDir: "/tmp/openclaw-agent",
    });

    await expect(tool?.execute({ query: "plumbers in Edmonton Alberta" })).rejects.toThrow(
      "Codex app-server has no model supporting text input.",
    );
    expect(requests.map((entry) => entry.method)).toEqual(["model/list"]);
  });

  it("fails closed when Codex returns an ungrounded answer", async () => {
    const { client } = createFakeClient({ emitWebSearch: false });
    const provider = createCodexWebSearchProvider({
      clientFactory: async () => client,
    });
    const config = createConfig();
    const tool = provider.createTool({
      config,
      searchConfig: config.tools?.web?.search,
      agentDir: "/tmp/openclaw-agent",
    });

    await expect(tool?.execute({ query: "plumbers in Edmonton Alberta" })).rejects.toThrow(
      "Codex hosted search completed without invoking web search.",
    );
  });
});
