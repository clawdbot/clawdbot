// Server models and voicewake tests cover model catalog routes, outbound
// delivery deps, voicewake triggers, config cache resets, and misc RPC behavior.
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.public.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import type { GatewayAgentRuntime } from "../shared/session-types.js";
import { createOutboundTestPlugin } from "../test-utils/channel-plugins.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTempHomeEnv } from "../test-utils/temp-home.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { resetPreparedModelCatalogStateForTest } from "./server-model-catalog.js";
import { testing as startupTesting } from "./server-startup-post-attach.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
import {
  connectOk,
  getGatewayTestPort,
  installGatewayTestHooks,
  onceMessage,
  agentDiscoveryMock,
  rpcReq,
  resetTestPluginRegistry,
  setTestPluginRegistry,
  startConnectedServerWithClient,
  startTestGatewayServer,
  startServerWithClient,
  trackConnectChallengeNonce,
} from "./test-helpers.js";
import { sendWhatsAppMock } from "./test-helpers.runtime-state.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: WebSocket;
let port: number;

afterAll(async () => {
  ws.close();
  await server.close();
});

beforeAll(async () => {
  const started = await startConnectedServerWithClient();
  server = started.server;
  ws = started.ws;
  port = started.port;
});

const whatsappOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ deps, to, text }) => {
    if (!deps?.["whatsapp"]) {
      throw new Error("Missing sendWhatsApp dep");
    }
    return {
      channel: "whatsapp",
      ...(await (deps["whatsapp"] as Function)(to, text, { verbose: false })),
    };
  },
  sendMedia: async ({ deps, to, text, mediaUrl }) => {
    if (!deps?.["whatsapp"]) {
      throw new Error("Missing sendWhatsApp dep");
    }
    return {
      channel: "whatsapp",
      ...(await (deps["whatsapp"] as Function)(to, text, { verbose: false, mediaUrl })),
    };
  },
};

const whatsappPlugin = createOutboundTestPlugin({
  id: "whatsapp",
  outbound: whatsappOutbound,
  label: "WhatsApp",
});

const whatsappRegistry = createRegistry([
  {
    pluginId: "whatsapp",
    source: "test",
    plugin: whatsappPlugin,
  },
]);

type ModelCatalogRpcEntry = {
  id: string;
  name: string;
  provider: string;
  alias?: string;
  available?: boolean;
  contextWindow?: number;
  input?: string[];
  reasoning?: boolean;
  supportsTools?: boolean;
  tags?: string[];
  agentRuntime?: GatewayAgentRuntime;
};

type AgentCatalogFixtureEntry = {
  id: string;
  provider: string;
  name?: string;
  contextWindow?: number;
};

const OPENCLAW_DEVICE_PLACEMENT: NonNullable<GatewayAgentRuntime["devicePlacement"]> = {
  requiredNodeCommands: [],
  consumesWorkerSlot: true,
};

const buildAgentCatalogFixture = (): AgentCatalogFixtureEntry[] => [
  { id: "gpt-test-z", provider: "openai", contextWindow: 0 },
  {
    id: "gpt-test-a",
    name: "A-Model",
    provider: "openai",
    contextWindow: 8000,
  },
  {
    id: "claude-test-b",
    name: "B-Model",
    provider: "anthropic",
    contextWindow: 1000,
  },
  {
    id: "claude-test-a",
    name: "A-Model",
    provider: "anthropic",
    contextWindow: 200_000,
  },
];

const expectedSortedCatalog = (gptTestZTags?: string[]): ModelCatalogRpcEntry[] => [
  {
    id: "claude-test-a",
    name: "A-Model",
    provider: "anthropic",
    available: false,
    contextWindow: 200_000,
  },
  {
    id: "claude-test-b",
    name: "B-Model",
    provider: "anthropic",
    available: false,
    contextWindow: 1000,
  },
  {
    id: "gpt-test-a",
    name: "A-Model",
    provider: "openai",
    agentRuntime: {
      id: "openclaw",
      cloudPlacementSupported: true,
      cloudPlacementExecutionMode: "worker-turn",
      devicePlacement: OPENCLAW_DEVICE_PLACEMENT,
      devicePlacementSupported: true,
      source: "implicit",
    },
    available: false,
    contextWindow: 8000,
  },
  {
    id: "gpt-test-z",
    name: "gpt-test-z",
    provider: "openai",
    agentRuntime: {
      id: "openclaw",
      cloudPlacementSupported: true,
      cloudPlacementExecutionMode: "worker-turn",
      devicePlacement: OPENCLAW_DEVICE_PLACEMENT,
      devicePlacementSupported: true,
      source: "implicit",
    },
    available: false,
    ...(gptTestZTags ? { tags: gptTestZTags } : {}),
  },
];

const NODE_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.NODE_HOST,
  version: "1.0.0",
  platform: "ios",
  mode: GATEWAY_CLIENT_MODES.NODE,
};

const remoteUnauthModels = (): AgentCatalogFixtureEntry[] => [
  { id: "remote-a", provider: "unauth-a", name: "Remote A" },
  { id: "remote-b", provider: "unauth-b", name: "Remote B" },
];

const minimaxProviderConfig = () => ({
  baseUrl: "https://minimax.example.com/v1",
  models: [{ id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed" }],
});

const fullCatalogProviderConfig = () => ({
  models: {
    providers: Object.fromEntries(
      ["anthropic", "openai"].map((provider) => [
        provider,
        {
          baseUrl: `https://${provider}.example.com/v1`,
          apiKey: {
            source: "env",
            provider: "default",
            id: "MODEL_CATALOG_TEST_MISSING_KEY",
          },
          models: buildAgentCatalogFixture()
            .filter((entry) => entry.provider === provider)
            .map(({ provider: _provider, ...model }) => model),
        },
      ]),
    ),
  },
});

type ConfiguredProviderModelFixture = {
  provider: string;
  modelId: string;
  name: string;
  alias: string;
  contextWindow: number;
  supportsTools?: boolean;
};

const configuredProviderModelConfig = (params: ConfiguredProviderModelFixture) => ({
  agents: {
    defaults: {
      model: { primary: `${params.provider}/${params.modelId}` },
      models: {
        [`${params.provider}/${params.modelId}`]: { alias: params.alias },
      },
      modelPolicy: { allow: [`${params.provider}/${params.modelId}`] },
    },
  },
  models: {
    providers: {
      [params.provider]: {
        baseUrl: `https://${params.provider}.example.com`,
        models: [
          {
            id: params.modelId,
            name: params.name,
            contextWindow: params.contextWindow,
            ...(params.supportsTools === undefined
              ? {}
              : { compat: { supportsTools: params.supportsTools } }),
          },
        ],
      },
    },
  },
});

const expectedConfiguredProviderModel = (params: ConfiguredProviderModelFixture) => ({
  id: params.modelId,
  name: params.name,
  alias: params.alias,
  provider: params.provider,
  contextWindow: params.contextWindow,
  ...(params.supportsTools === undefined ? {} : { supportsTools: params.supportsTools }),
  tags: ["default", "configured"],
});

describe("gateway server models + voicewake", () => {
  const listModels = async (params?: {
    view?: "default" | "configured" | "all";
    preparedOnly?: boolean;
  }) =>
    withEnvAsync(
      {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        CODEX_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        OPENAI_OAUTH_TOKEN: undefined,
        CHATGPT_OAUTH_TOKEN: undefined,
      },
      async () =>
        params
          ? await rpcReq<{ models: ModelCatalogRpcEntry[] }>(ws, "models.list", params)
          : await rpcReq<{ models: ModelCatalogRpcEntry[] }>(ws, "models.list"),
    );

  const setAgentCatalog = async (entries: AgentCatalogFixtureEntry[]) => {
    agentDiscoveryMock.enabled = true;
    agentDiscoveryMock.models = entries;
    await resetPreparedModelCatalogStateForTest();
    const [
      { refreshPreparedModelRuntimeSnapshots },
      { clearRuntimeConfigSnapshot: clearIoRuntimeConfigSnapshot, getRuntimeConfig },
    ] = await Promise.all([
      import("../agents/prepared-model-runtime.js"),
      import("../config/io.js"),
    ]);
    clearIoRuntimeConfigSnapshot();
    const publishedConfig = getRuntimeConfig();
    await refreshPreparedModelRuntimeSnapshots(publishedConfig, { gatewayLifecycle: true });
  };

  const seedAgentModelCatalog = async () => {
    await setAgentCatalog(buildAgentCatalogFixture());
  };

  const withModelsConfig = async <T>(config: unknown, run: () => Promise<T>): Promise<T> => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("Missing OPENCLAW_CONFIG_PATH");
    }
    let previousConfig: string | undefined;
    try {
      previousConfig = await fs.readFile(configPath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        throw err;
      }
    }

    try {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      return await run();
    } finally {
      if (previousConfig === undefined) {
        await fs.rm(configPath, { force: true });
      } else {
        await fs.writeFile(configPath, previousConfig, "utf-8");
      }
      clearRuntimeConfigSnapshot();
      clearConfigCache();
    }
  };

  const withTempHome = async <T>(fn: (homeDir: string) => Promise<T>): Promise<T> => {
    const tempHome = await createTempHomeEnv("openclaw-home-");
    try {
      return await fn(tempHome.home);
    } finally {
      await tempHome.restore();
    }
  };

  const expectAllowlistedModels = async (options: {
    primary: string;
    models: Record<string, object>;
    expected: ModelCatalogRpcEntry[];
  }): Promise<void> => {
    await withModelsConfig(
      {
        ...fullCatalogProviderConfig(),
        agents: {
          defaults: {
            model: { primary: options.primary },
            models: options.models,
            modelPolicy: { allow: Object.keys(options.models) },
          },
        },
      },
      async () => {
        await seedAgentModelCatalog();
        const res = await listModels();
        expect(res.ok).toBe(true);
        expect(res.payload?.models).toEqual(options.expected);
      },
    );
  };

  type NodeGatewayEvent = {
    type: "event";
    event: string;
    payload?: Record<string, unknown> | null;
  };

  const withConnectedNodeEvent = async <T>(
    eventName: string,
    run: (nodeWs: WebSocket, firstEvent: NodeGatewayEvent) => Promise<T>,
  ): Promise<T> =>
    withTempHome(async () => {
      const nodeWs = new WebSocket(`ws://127.0.0.1:${port}`);
      trackConnectChallengeNonce(nodeWs);
      try {
        await new Promise<void>((resolve) => {
          nodeWs.once("open", resolve);
        });
        const firstEventP = onceMessage<NodeGatewayEvent>(
          nodeWs,
          (o) => o.type === "event" && o.event === eventName,
        );
        await connectOk(nodeWs, {
          role: "node",
          client: NODE_CLIENT,
        });
        return await run(nodeWs, await firstEventP);
      } finally {
        nodeWs.close();
      }
    });

  const expectSingleModel = (
    models: ModelCatalogRpcEntry[],
    expected: Partial<ModelCatalogRpcEntry> &
      Pick<ModelCatalogRpcEntry, "id" | "name" | "provider">,
  ) => {
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe(expected.id);
    expect(models[0]?.name).toBe(expected.name);
    expect(models[0]?.provider).toBe(expected.provider);
    if (expected.alias !== undefined) {
      expect(models[0]?.alias).toBe(expected.alias);
    }
    if (expected.contextWindow !== undefined) {
      expect(models[0]?.contextWindow).toBe(expected.contextWindow);
    }
    if (expected.supportsTools !== undefined) {
      expect(models[0]?.supportsTools).toBe(expected.supportsTools);
    }
    if (expected.tags !== undefined) {
      expect(models[0]?.tags).toEqual(expected.tags);
    }
  };

  test(
    "voicewake.get returns defaults and voicewake.set broadcasts",
    { timeout: 20_000 },
    async () => {
      await withTempHome(async (homeDir) => {
        const initial = await rpcReq<{ triggers: string[] }>(ws, "voicewake.get");
        expect(initial.ok).toBe(true);
        expect(initial.payload?.triggers).toEqual(["openclaw", "claude", "computer"]);

        const changedP = onceMessage(
          ws,
          (o) => o.type === "event" && o.event === "voicewake.changed",
        );

        const setRes = await rpcReq(ws, "voicewake.set", {
          triggers: ["  hi  ", "", "there"],
        });
        expect(setRes.ok).toBe(true);
        expect(setRes.payload?.triggers).toEqual(["hi", "there"]);

        const changed = (await changedP) as { event?: string; payload?: unknown };
        expect(changed.event).toBe("voicewake.changed");
        expect((changed.payload as { triggers?: unknown } | undefined)?.triggers).toEqual([
          "hi",
          "there",
        ]);

        const after = await rpcReq<{ triggers: string[] }>(ws, "voicewake.get");
        expect(after.ok).toBe(true);
        expect(after.payload?.triggers).toEqual(["hi", "there"]);

        await expect(
          fs.readFile(path.join(homeDir, ".openclaw", "settings", "voicewake.json"), "utf8"),
        ).rejects.toThrow(/ENOENT/u);
      });
    },
  );

  test("pushes voicewake.changed to nodes on connect and on updates", async () => {
    await withConnectedNodeEvent("voicewake.changed", async (nodeWs, first) => {
      expect(first.event).toBe("voicewake.changed");
      expect((first.payload as { triggers?: unknown } | undefined)?.triggers).toEqual([
        "openclaw",
        "claude",
        "computer",
      ]);

      const broadcastP = onceMessage(
        nodeWs,
        (o) => o.type === "event" && o.event === "voicewake.changed",
      );
      const setRes = await rpcReq(ws, "voicewake.set", {
        triggers: ["openclaw", "computer"],
      });
      expect(setRes.ok).toBe(true);

      const broadcast = (await broadcastP) as { event?: string; payload?: unknown };
      expect(broadcast.event).toBe("voicewake.changed");
      expect((broadcast.payload as { triggers?: unknown } | undefined)?.triggers).toEqual([
        "openclaw",
        "computer",
      ]);
    });
  });

  test("voicewake.routing.get returns the default routing", async () => {
    const result = await rpcReq<{
      config?: { version?: number; defaultTarget?: unknown; routes?: unknown[] };
    }>(ws, "voicewake.routing.get");

    expect(result.ok).toBe(true);
    expect(result.payload?.config).toMatchObject({
      version: 1,
      defaultTarget: { mode: "current" },
      routes: [],
    });
  });

  test("pushes voicewake.routing.changed to nodes on connect", async () => {
    await withConnectedNodeEvent("voicewake.routing.changed", async (_nodeWs, first) => {
      expect(first.event).toBe("voicewake.routing.changed");
      expect(
        (first.payload as { config?: { routes?: unknown[] } } | undefined)?.config?.routes,
      ).toStrictEqual([]);
    });
  });

  test("models.list all view returns model catalog", async () => {
    await withModelsConfig(fullCatalogProviderConfig(), async () => {
      await seedAgentModelCatalog();

      const res1 = await listModels({ view: "all", preparedOnly: true });
      const res2 = await listModels({ view: "all", preparedOnly: true });

      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);

      const models = res1.payload?.models ?? [];
      expect(models).toEqual(expectedSortedCatalog());

      expect(agentDiscoveryMock.discoverCalls).toBe(0);
    });
  });

  test("models.list default view uses configured providers instead of the full catalog", async () => {
    await withModelsConfig(
      {
        models: {
          providers: {
            minimax: minimaxProviderConfig(),
          },
        },
      },
      async () => {
        await setAgentCatalog(remoteUnauthModels());
        const res = await listModels();
        expect(res.ok, JSON.stringify(res)).toBe(true);
        expectSingleModel(res.payload?.models ?? [], {
          id: "MiniMax-M2.7-highspeed",
          name: "MiniMax M2.7 Highspeed",
          provider: "minimax",
        });
      },
    );
  });

  test("models.list configured view reuses the prepared generation", async () => {
    await withEnvAsync(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_OAUTH_TOKEN: undefined,
        OPENAI_API_KEY: "test-openai-key",
      },
      async () => {
        await withModelsConfig({}, async () => {
          await seedAgentModelCatalog();
          const discoverCallsBefore = agentDiscoveryMock.discoverCalls;
          const res = await listModels({ view: "configured" });
          expect(res.ok).toBe(true);
          expect(res.payload?.models).toStrictEqual([]);
          expect(agentDiscoveryMock.discoverCalls).toBe(discoverCallsBefore);
        });
      },
    );
  });

  test("prepared agent read RPCs preserve explicit and system owners without live fallback", async () => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("Missing OPENCLAW_CONFIG_PATH");
    }
    const workspaceRoot = path.dirname(configPath);
    const startupModels = [
      { id: "ops-model", name: "Ops Model", provider: "fixture" },
      { id: "research-model", name: "Research Model", provider: "fixture" },
    ];
    const modelConfig = {
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            apiKey: "test-fixture-key",
            baseUrl: "https://fixture.example.com/v1",
            models: [
              { id: "ops-model", name: "Ops Model" },
              { id: "research-model", name: "Research Model" },
            ],
          },
        },
      },
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "ops" } },
        entries: {
          ops: {
            workspace: path.join(workspaceRoot, "ops-workspace"),
            model: { primary: "fixture/ops-model" },
            modelPolicy: { allow: ["fixture/ops-model"] },
          },
          research: {
            workspace: path.join(workspaceRoot, "research-workspace"),
            model: { primary: "fixture/research-model" },
            modelPolicy: { allow: ["fixture/research-model"] },
          },
        },
      },
    };
    const publishPreparedOwners = async () => {
      await resetPreparedModelCatalogStateForTest();
      agentDiscoveryMock.enabled = true;
      agentDiscoveryMock.models = startupModels;
      const { getRuntimeConfig } = await import("../config/io.js");
      await startupTesting.publishStartupModelRuntime({
        cfg: getRuntimeConfig(),
        log: { warn: () => {} },
      });
    };
    const readMethods = [
      "models.list",
      "models.authStatus",
      "skills.status",
      "doctor.memory.status",
    ] as const;

    await withModelsConfig(modelConfig, async () => {
      await publishPreparedOwners();
      const discoveryCallsAfterStartup = agentDiscoveryMock.discoverCalls;

      let blockedRequestFallback = false;
      agentDiscoveryMock.models = [
        {
          id: "request-time-fallback",
          name: "Request-time fallback",
          get provider() {
            if (!blockedRequestFallback) {
              blockedRequestFallback = true;
              // A prepared-only miss used to run synchronous catalog discovery on the Gateway
              // thread. Make that operator-visible as event-loop starvation, not only a call count.
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
            }
            return "fixture";
          },
        },
      ];
      try {
        const [
          opsModels,
          researchModels,
          opsAuth,
          researchAuth,
          models,
          auth,
          emptyAuth,
          skills,
          memory,
          health,
        ] = await Promise.all([
          rpcReq<{ models: ModelCatalogRpcEntry[] }>(ws, "models.list", {
            agentId: "ops",
            view: "configured",
            preparedOnly: true,
          }),
          rpcReq<{ models: ModelCatalogRpcEntry[] }>(ws, "models.list", {
            agentId: "research",
            view: "configured",
            preparedOnly: true,
          }),
          rpcReq<{ providers: Array<{ provider: string }> }>(ws, "models.authStatus", {
            agentId: "ops",
          }),
          rpcReq<{ providers: Array<{ provider: string }> }>(ws, "models.authStatus", {
            agentId: "research",
          }),
          rpcReq<{ models: ModelCatalogRpcEntry[] }>(ws, "models.list", {
            view: "configured",
            preparedOnly: true,
          }),
          rpcReq(ws, "models.authStatus", {}),
          rpcReq(ws, "models.authStatus", { agentId: "" }),
          rpcReq<{ agentId: string; workspaceDir: string }>(ws, "skills.status", {}),
          rpcReq<{ agentId: string }>(ws, "doctor.memory.status", {}),
          rpcReq<Record<string, unknown>>(ws, "health", { probe: true }),
        ]);

        expect(opsModels.ok, JSON.stringify(opsModels)).toBe(true);
        expect(researchModels.ok, JSON.stringify(researchModels)).toBe(true);
        expect(opsModels.payload?.models).toContainEqual(
          expect.objectContaining({ id: "ops-model", provider: "fixture" }),
        );
        expect(researchModels.payload?.models).toContainEqual(
          expect.objectContaining({ id: "research-model", provider: "fixture" }),
        );
        expect(opsAuth.ok, JSON.stringify(opsAuth)).toBe(true);
        expect(researchAuth.ok, JSON.stringify(researchAuth)).toBe(true);
        expect(opsAuth.payload?.providers).toContainEqual(
          expect.objectContaining({ provider: "fixture" }),
        );
        expect(researchAuth.payload?.providers).toContainEqual(
          expect.objectContaining({ provider: "fixture" }),
        );
        expect(models.payload?.models).toEqual([
          expect.objectContaining({ id: "ops-model", provider: "fixture" }),
        ]);
        expect(auth.ok, JSON.stringify(auth)).toBe(true);
        expect(emptyAuth.ok, JSON.stringify(emptyAuth)).toBe(true);
        expect(skills.payload, JSON.stringify(skills.error)).toMatchObject({
          agentId: "ops",
          workspaceDir: path.join(workspaceRoot, "ops-workspace"),
        });
        expect(memory.payload).toMatchObject({ agentId: "ops" });
        expect(health.ok, JSON.stringify(health)).toBe(true);
      } finally {
        agentDiscoveryMock.models = startupModels;
      }

      expect(agentDiscoveryMock.discoverCalls).toBe(discoveryCallsAfterStartup);
      expect(blockedRequestFallback).toBe(false);
      for (const method of readMethods) {
        const response = await rpcReq(ws, method, { agentId: "missing" });
        expect(response.ok, method).toBe(false);
        expect(response.error).toMatchObject({ code: "INVALID_REQUEST" });
      }
    });

    const noSystemAgentConfig = {
      ...modelConfig,
      agents: { ownership: modelConfig.agents.ownership, entries: modelConfig.agents.entries },
    };
    await withModelsConfig(noSystemAgentConfig, async () => {
      await publishPreparedOwners();

      for (const method of readMethods) {
        const response = await rpcReq(ws, method, {});
        expect(response.ok, method).toBe(false);
        expect(response.error).toMatchObject({ code: "INVALID_REQUEST" });
      }
    });
  });

  test("models.list configured view uses models.providers when no allowlist is configured", async () => {
    await withModelsConfig(
      {
        models: {
          providers: {
            zhipu: {
              baseUrl: "https://zhipu.example.com/v1",
              models: [{ id: "glm-4.5-air", name: "GLM 4.5 Air", reasoning: true }],
            },
            minimax: minimaxProviderConfig(),
          },
        },
      },
      async () => {
        await setAgentCatalog(remoteUnauthModels());
        const res = await listModels({ view: "configured" });
        expect(res.ok).toBe(true);
        const models = res.payload?.models ?? [];
        expect(models).toHaveLength(2);
        expect(models[0]?.id).toBe("MiniMax-M2.7-highspeed");
        expect(models[0]?.name).toBe("MiniMax M2.7 Highspeed");
        expect(models[0]?.provider).toBe("minimax");
        expect(models[1]?.id).toBe("glm-4.5-air");
        expect(models[1]?.name).toBe("GLM 4.5 Air");
        expect(models[1]?.provider).toBe("zhipu");
        expect(models[1]?.reasoning).toBe(true);
      },
    );
  });

  test("models.list configured view prefers the explicit model policy", async () => {
    await withModelsConfig(
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-test-z" },
            models: {
              "openai/gpt-test-z": {},
            },
            modelPolicy: { allow: ["openai/gpt-test-z"] },
          },
        },
        models: {
          providers: {
            minimax: minimaxProviderConfig(),
          },
        },
      },
      async () => {
        await seedAgentModelCatalog();
        const res = await listModels({ view: "configured" });
        expect(res.ok).toBe(true);
        expect(res.payload?.models).toEqual([
          {
            id: "gpt-test-z",
            name: "gpt-test-z",
            provider: "openai",
            agentRuntime: {
              id: "openclaw",
              cloudPlacementSupported: true,
              cloudPlacementExecutionMode: "worker-turn",
              devicePlacement: OPENCLAW_DEVICE_PLACEMENT,
              devicePlacementSupported: true,
              source: "implicit",
            },
            available: false,
            tags: ["default", "configured"],
          },
        ]);
      },
    );
  });

  test("models.list all view bypasses the explicit model policy", async () => {
    await withModelsConfig(
      {
        ...fullCatalogProviderConfig(),
        agents: {
          defaults: {
            model: { primary: "openai/gpt-test-z" },
            models: {
              "openai/gpt-test-z": {},
            },
            modelPolicy: { allow: ["openai/gpt-test-z"] },
          },
        },
      },
      async () => {
        await seedAgentModelCatalog();
        const res = await listModels({ view: "all", preparedOnly: true });
        expect(res.ok).toBe(true);
        expect(res.payload?.models).toEqual(expectedSortedCatalog(["default", "configured"]));
      },
    );
  });

  test("models.list filters to allowlisted configured models by default", async () => {
    await expectAllowlistedModels({
      primary: "openai/gpt-test-z",
      models: {
        "openai/gpt-test-z": {},
        "anthropic/claude-test-a": {},
      },
      expected: [
        {
          id: "claude-test-a",
          name: "A-Model",
          provider: "anthropic",
          available: false,
          contextWindow: 200_000,
          tags: ["configured"],
        },
        {
          id: "gpt-test-z",
          name: "gpt-test-z",
          provider: "openai",
          agentRuntime: {
            id: "openclaw",
            cloudPlacementSupported: true,
            cloudPlacementExecutionMode: "worker-turn",
            devicePlacement: OPENCLAW_DEVICE_PLACEMENT,
            devicePlacementSupported: true,
            source: "implicit",
          },
          available: false,
          tags: ["default", "configured"],
        },
      ],
    });
  });

  test("models.list includes synthetic entries for allowlist models absent from catalog", async () => {
    await expectAllowlistedModels({
      primary: "openai/not-in-catalog",
      models: {
        "openai/not-in-catalog": {},
      },
      expected: [
        {
          id: "not-in-catalog",
          name: "not-in-catalog",
          provider: "openai",
          agentRuntime: {
            id: "openclaw",
            cloudPlacementSupported: true,
            cloudPlacementExecutionMode: "worker-turn",
            devicePlacement: OPENCLAW_DEVICE_PLACEMENT,
            devicePlacementSupported: true,
            source: "implicit",
          },
          available: false,
          tags: ["default", "configured"],
        },
      ],
    });
  });

  test.each([
    {
      name: "applies configured metadata and alias to synthetic allowlist entries",
      fixture: {
        provider: "nvidia",
        modelId: "moonshotai/kimi-k2.5",
        name: "Kimi K2.5 (Configured)",
        alias: "Kimi K2.5 (NVIDIA)",
        contextWindow: 32_000,
        supportsTools: false,
      },
    },
    {
      name: "prefers configured provider metadata over discovered entries",
      fixture: {
        provider: "openai",
        modelId: "gpt-test-z",
        name: "Configured GPT Test Z",
        alias: "GPT Test Z Alias",
        contextWindow: 64_000,
      },
    },
  ])("models.list $name", async ({ fixture }) => {
    await withModelsConfig(configuredProviderModelConfig(fixture), async () => {
      await seedAgentModelCatalog();
      const res = await listModels();
      expect(res.ok).toBe(true);
      expectSingleModel(res.payload?.models ?? [], expectedConfiguredProviderModel(fixture));
    });
  });

  test("models.list rejects unknown params", async () => {
    agentDiscoveryMock.enabled = true;
    agentDiscoveryMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];

    const res = await rpcReq(ws, "models.list", { extra: true });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toMatch(/invalid models\.list params/i);
  });
});

describe("gateway server misc", () => {
  test("send dedupes by idempotencyKey", { timeout: 15_000 }, async () => {
    const idem = "same-key";
    try {
      setTestPluginRegistry(whatsappRegistry);
      const res1P = onceMessage(ws, (o) => o.type === "res" && o.id === "a1");
      const res2P = onceMessage(ws, (o) => o.type === "res" && o.id === "a2");
      const sendReq = (id: string) =>
        ws.send(
          JSON.stringify({
            type: "req",
            id,
            method: "send",
            params: {
              to: "+15550000000",
              channel: "whatsapp",
              message: "hi",
              idempotencyKey: idem,
            },
          }),
        );
      sendReq("a1");
      sendReq("a2");

      const res1 = await res1P;
      const res2 = await res2P;
      expect(res1.ok, JSON.stringify(res1)).toBe(true);
      expect(res2.ok, JSON.stringify(res2)).toBe(true);
      expect(res2.payload).toEqual(res1.payload);
      expect(sendWhatsAppMock).toHaveBeenCalledTimes(1);
    } finally {
      resetTestPluginRegistry();
    }
  });

  test("releases port after close", async () => {
    const releasePort = await getGatewayTestPort();
    const releaseServer = await startTestGatewayServer(releasePort);
    await releaseServer.close();

    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(releasePort, "127.0.0.1", () => resolve());
    });
    expect(probe.listening).toBe(true);
    await new Promise<void>((resolve, reject) => {
      probe.close((err) => (err ? reject(err) : resolve()));
    });
  });
});
