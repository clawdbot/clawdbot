// Integration proof for tools.effective global sessions scoped to non-default agents.
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installGatewayTestHooks, testState, writeSessionStore } from "../test-helpers.js";
import { getGatewayConfigModule, sessionStoreEntry } from "../test/server-sessions.test-helpers.js";
import { testing, toolsEffectiveHandlers } from "./tools-effective.js";

const inventoryMocks = vi.hoisted(() => ({
  resolveEffectiveToolInventory: vi.fn(
    (params: { agentId: string; modelProvider?: string; modelId?: string }) => ({
      agentId: params.agentId,
      profile: "coding",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            {
              id: "exec",
              label: "Exec",
              description: "Run shell commands",
              source: "core",
            },
          ],
        },
      ],
      modelProvider: params.modelProvider,
      modelId: params.modelId,
    }),
  ),
  resolveEffectiveToolInventoryRuntimeModelContext: vi.fn(() => ({
    modelApi: "openai-responses",
    runtimeModel: {
      id: "work-model",
      name: "Work model",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    },
  })),
}));

vi.mock("./tools-effective.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools-effective.runtime.js")>();
  return {
    ...actual,
    resolveEffectiveToolInventory: inventoryMocks.resolveEffectiveToolInventory,
    resolveEffectiveToolInventoryRuntimeModelContext:
      inventoryMocks.resolveEffectiveToolInventoryRuntimeModelContext,
    peekSessionMcpRuntime: vi.fn(() => undefined),
    resolveSessionMcpConfigSummary: vi.fn(() => ({ fingerprint: "mcp:0", serverNames: [] })),
    buildBundleMcpToolsFromCatalog: vi.fn(() => []),
    applyFinalEffectiveToolPolicy: vi.fn(
      (params: { bundledTools: unknown[] }) => params.bundledTools,
    ),
    getActivePluginRegistryVersion: vi.fn(() => 1),
    getActivePluginChannelRegistryVersion: vi.fn(() => 1),
  };
});

installGatewayTestHooks();

describe("tools.effective global agent integration", () => {
  let mainStorePath = "";
  let workStorePath = "";
  let getRuntimeConfig: Awaited<ReturnType<typeof getGatewayConfigModule>>["getRuntimeConfig"];

  async function seedSelectedGlobalStores() {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required");
    }
    const dir = path.join(stateDir, "session-stores", `tools-effective-${Date.now()}`);
    const storeTemplate = path.join(dir, "{agentId}", "sessions.json");
    testState.sessionStorePath = storeTemplate;
    testState.sessionConfig = { scope: "global" };
    testState.agentConfig = undefined;
    testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };
    mainStorePath = storeTemplate.replace("{agentId}", "main");
    workStorePath = storeTemplate.replace("{agentId}", "work");
    const configModule = await getGatewayConfigModule();
    configModule.clearRuntimeConfigSnapshot();
    configModule.clearConfigCache();
    getRuntimeConfig = configModule.getRuntimeConfig;
  }

  beforeEach(async () => {
    testing.resetToolsEffectiveCacheForTest();
    vi.clearAllMocks();
    await seedSelectedGlobalStores();
  });

  it("resolves tools.effective for global session scoped to a non-default agent store", async () => {
    await writeSessionStore({
      storePath: mainStorePath,
      entries: {
        global: sessionStoreEntry("sess-main-global", {
          modelProvider: "openai",
          model: "main-model",
        }),
      },
    });
    await writeSessionStore({
      storePath: workStorePath,
      agentId: "work",
      entries: {
        global: sessionStoreEntry("sess-work-global", {
          modelProvider: "openai",
          model: "work-model",
          providerOverride: "openai",
          modelOverride: "work-model",
        }),
      },
    });

    const respond = vi.fn();
    await toolsEffectiveHandlers["tools.effective"]({
      params: { sessionKey: "global", agentId: "work" },
      respond: respond as never,
      context: { getRuntimeConfig } as never,
      client: null,
      req: { type: "req", id: "req-tools-effective-global", method: "tools.effective" },
      isWebchatConnect: () => false,
    });

    const call = respond.mock.calls[0] as [boolean, { agentId?: string }?, unknown?] | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]?.agentId).toBe("work");
    expect(inventoryMocks.resolveEffectiveToolInventory).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "work",
        sessionKey: "global",
        modelProvider: "openai",
        modelId: "work-model",
      }),
    );
  });

  it("uses the hot-reloaded agent default instead of stale runtime identity", async () => {
    const configModule = await getGatewayConfigModule();
    testState.agentConfig = { model: { primary: "openai/stale-model" } };
    configModule.clearRuntimeConfigSnapshot();
    configModule.clearConfigCache();
    getRuntimeConfig = configModule.getRuntimeConfig;
    await writeSessionStore({
      storePath: workStorePath,
      agentId: "work",
      entries: {
        global: sessionStoreEntry("sess-work-global", {
          modelProvider: "openai",
          model: "stale-model",
        }),
      },
    });

    const requestTools = async (id: string) => {
      const respond = vi.fn();
      await toolsEffectiveHandlers["tools.effective"]({
        params: { sessionKey: "global", agentId: "work" },
        respond: respond as never,
        context: { getRuntimeConfig } as never,
        client: null,
        req: { type: "req", id, method: "tools.effective" },
        isWebchatConnect: () => false,
      });
      expect(respond.mock.calls[0]?.[0]).toBe(true);
    };

    await requestTools("req-tools-effective-before-reload");
    expect(inventoryMocks.resolveEffectiveToolInventory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        modelProvider: "openai",
        modelId: "stale-model",
      }),
    );

    testState.agentConfig = { model: { primary: "anthropic/current-model" } };
    configModule.clearRuntimeConfigSnapshot();
    configModule.clearConfigCache();
    await requestTools("req-tools-effective-after-reload");

    expect(inventoryMocks.resolveEffectiveToolInventory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentId: "work",
        sessionKey: "global",
        modelProvider: "anthropic",
        modelId: "current-model",
      }),
    );
  });

  // Negative control on the real session-resolution path: a non-global key owned
  // by `main` must keep rejecting a mismatched configured agent. Before the
  // ownership-narrowing fix the requested agent overrode session-agent resolution
  // here, so this request would have succeeded under `work`.
  it("rejects a mismatched configured agent for a non-global session key", async () => {
    await seedNonGlobalMainStore();

    await writeSessionStore({
      storePath: mainStorePath,
      entries: {
        "agent:main:abc": sessionStoreEntry("sess-main-agent", {
          modelProvider: "openai",
          model: "main-model",
        }),
      },
    });

    const respond = vi.fn();
    await toolsEffectiveHandlers["tools.effective"]({
      params: { sessionKey: "agent:main:abc", agentId: "work" },
      respond: respond as never,
      context: { getRuntimeConfig } as never,
      client: null,
      req: { type: "req", id: "req-tools-effective-mismatch", method: "tools.effective" },
      isWebchatConnect: () => false,
    });

    const call = respond.mock.calls[0] as
      | [boolean, unknown?, { code: number; message: string }?]
      | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.message).toBe('agent id "work" does not match session agent "main"');
    expect(inventoryMocks.resolveEffectiveToolInventory).not.toHaveBeenCalled();
  });

  async function seedNonGlobalMainStore() {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required");
    }
    const dir = path.join(stateDir, "session-stores", `tools-effective-nonglobal-${Date.now()}`);
    const storeTemplate = path.join(dir, "{agentId}", "sessions.json");
    testState.sessionStorePath = storeTemplate;
    testState.sessionConfig = undefined;
    testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };
    mainStorePath = storeTemplate.replace("{agentId}", "main");
    const configModule = await getGatewayConfigModule();
    configModule.clearRuntimeConfigSnapshot();
    configModule.clearConfigCache();
    getRuntimeConfig = configModule.getRuntimeConfig;
  }
});
