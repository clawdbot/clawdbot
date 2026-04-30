import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { resetModelCatalogCacheForTest } from "../agents/model-catalog.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resolveCanvasHostUrl } from "../infra/canvas-host-url.js";
import { createOutboundTestPlugin } from "../test-utils/channel-plugins.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTempHomeEnv } from "../test-utils/temp-home.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
import {
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  onceMessage,
  piSdkMock,
  rpcReq,
  resetTestPluginRegistry,
  setTestPluginRegistry,
  startConnectedServerWithClient,
  startGatewayServer,
  startServerWithClient,
  testState,
  testTailnetIPv4,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

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
  contextWindow?: number;
};

type PiCatalogFixtureEntry = {
  id: string;
  provider: string;
  name?: string;
  contextWindow?: number;
};

const buildPiCatalogFixture = (): PiCatalogFixtureEntry[] => [
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

const expectedSortedCatalog = (): ModelCatalogRpcEntry[] => [
  {
    id: "claude-test-a",
    name: "A-Model",
    provider: "anthropic",
    contextWindow: 200_000,
  },
  {
    id: "claude-test-b",
    name: "B-Model",
    provider: "anthropic",
    contextWindow: 1000,
  },
  {
    id: "gpt-test-a",
    name: "A-Model",
    provider: "openai",
    contextWindow: 8000,
  },
  {
    id: "gpt-test-z",
    name: "gpt-test-z",
    provider: "openai",
  },
];

describe("gateway server models + voicewake", () => {
  const listModels = async (params?: { view?: "default" | "configured" | "all" }) =>
    withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () =>
      params
        ? await rpcReq<{ models: ModelCatalogRpcEntry[] }>(ws, "models.list", params)
        : await rpcReq<{ models: ModelCatalogRpcEntry[] }>(ws, "models.list"),
    );

  const setPiCatalog = (entries: PiCatalogFixtureEntry[]) => {
    piSdkMock.enabled = true;
    piSdkMock.models = entries;
    resetModelCatalogCacheForTest();
  };

  const seedPiCatalog = () => {
    setPiCatalog(buildPiCatalogFixture());
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
        agents: {
          defaults: {
            model: { primary: options.primary },
            models: options.models,
          },
        },
      },
      async () => {
        seedPiCatalog();
        const res = await listModels();
        expect(res.ok).toBe(true);
        expect(res.payload?.models).toEqual(options.expected);
      },
    );
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

        const onDisk = JSON.parse(
          await fs.readFile(path.join(homeDir, ".openclaw", "settings", "voicewake.json"), "utf8"),
        ) as { triggers?: unknown; updatedAtMs?: unknown };
        expect(onDisk.triggers).toEqual(["hi", "there"]);
        expect(typeof onDisk.updatedAtMs).toBe("number");
      });
    },
  );

  test("pushes voicewake.changed to nodes on connect and on updates", async () => {
    await withTempHome(async () => {
      const nodeWs = new WebSocket(`ws://127.0.0.1:${port}`);
      trackConnectChallengeNonce(nodeWs);
      await new Promise<void>((resolve) => nodeWs.once("open", resolve));
      const firstEventP = onceMessage(
        nodeWs,
        (o) => o.type === "event" && o.event === "voicewake.changed",
      );
      await connectOk(nodeWs, {
        role: "node",
        client: {
          id: GATEWAY_CLIENT_NAMES.NODE_HOST,
          version: "1.0.0",
          platform: "ios",
          mode: GATEWAY_CLIENT_MODES.NODE,
        },
      });

      const first = (await firstEventP) as { event?: string; payload?: unknown };
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

      nodeWs.close();
    });
  });

  test("voicewake.routing.get/set persists and broadcasts", { timeout: 60_000 }, async () => {
    await withTempHome(async (homeDir) => {
      const initial = await rpcReq<{
        config?: { version?: number; defaultTarget?: unknown; routes?: unknown[] };
      }>(ws, "voicewake.routing.get");
      expect(initial.ok).toBe(true);
      expect(initial.payload?.config?.version).toBe(1);
      expect(initial.payload?.config?.defaultTarget).toEqual({ mode: "current" });
      expect(initial.payload?.config?.routes).toEqual([]);

      const changedP = onceMessage<{
        type: "event";
        event: string;
        payload?: Record<string, unknown> | null;
      }>(ws, (o) => o.type === "event" && o.event === "voicewake.routing.changed");

      const setRes = await rpcReq<{
        config?: { routes?: Array<{ trigger?: string; target?: unknown }>; updatedAtMs?: number };
      }>(ws, "voicewake.routing.set", {
        config: {
          defaultTarget: { mode: "current" },
          routes: [{ trigger: "  Robot   Wake ", target: { agentId: "main" } }],
        },
      });
      expect(setRes.ok).toBe(true);
      expect(setRes.payload?.config?.routes).toEqual([
        { trigger: "robot wake", target: { agentId: "main" } },
      ]);
      expect(typeof setRes.payload?.config?.updatedAtMs).toBe("number");

      const changed = await changedP;
      expect(changed.event).toBe("voicewake.routing.changed");
      expect(
        (changed.payload as { config?: { routes?: unknown } } | undefined)?.config?.routes,
      ).toEqual([{ trigger: "robot wake", target: { agentId: "main" } }]);

      const after = await rpcReq<{
        config?: { routes?: Array<{ trigger?: string; target?: unknown }> };
      }>(ws, "voicewake.routing.get");
      expect(after.ok).toBe(true);
      expect(after.payload?.config?.routes).toEqual([
        { trigger: "robot wake", target: { agentId: "main" } },
      ]);

      const onDisk = JSON.parse(
        await fs.readFile(
          path.join(homeDir, ".openclaw", "settings", "voicewake-routing.json"),
          "utf8",
        ),
      ) as { routes?: unknown };
      expect(onDisk.routes).toEqual([{ trigger: "robot wake", target: { agentId: "main" } }]);

      const invalid = await rpcReq(ws, "voicewake.routing.set", { config: null });
      expect(invalid.ok).toBe(false);
      expect(invalid.error?.message ?? "").toMatch(
        /voicewake\.routing\.set requires config: object/i,
      );

      const badRoutes = await rpcReq(ws, "voicewake.routing.set", {
        config: { routes: "oops" },
      });
      expect(badRoutes.ok).toBe(false);
      expect(badRoutes.error?.message ?? "").toMatch(/config\.routes must be an array/i);

      const badTarget = await rpcReq(ws, "voicewake.routing.set", {
        config: {
          routes: [
            { trigger: "robot wake", target: { agentId: "main", sessionKey: "agent:main:main" } },
          ],
        },
      });
      expect(badTarget.ok).toBe(false);
      expect(badTarget.error?.message ?? "").toMatch(
        /config\.routes\[0\]\.target cannot include both agentId and sessionKey/i,
      );

      const badAgentId = await rpcReq(ws, "voicewake.routing.set", {
        config: {
          routes: [{ trigger: "robot wake", target: { agentId: "!!!" } }],
        },
      });
      expect(badAgentId.ok).toBe(false);
      expect(badAgentId.error?.message ?? "").toMatch(
        /config\.routes\[0\]\.target\.agentId must be a valid agent id/i,
      );

      const badSessionKey = await rpcReq(ws, "voicewake.routing.set", {
        config: {
          routes: [{ trigger: "robot wake", target: { sessionKey: "agent::main" } }],
        },
      });
      expect(badSessionKey.ok).toBe(false);
      expect(badSessionKey.error?.message ?? "").toMatch(
        /config\.routes\[0\]\.target\.sessionKey must be a canonical agent session key/i,
      );

      const stillStored = await rpcReq<{
        config?: { routes?: Array<{ trigger?: string; target?: unknown }> };
      }>(ws, "voicewake.routing.get");
      expect(stillStored.ok).toBe(true);
      expect(stillStored.payload?.config?.routes).toEqual([
        { trigger: "robot wake", target: { agentId: "main" } },
      ]);
    });
  });

  test("pushes voicewake.routing.changed to nodes on connect and on updates", async () => {
    await withTempHome(async () => {
      const nodeWs = new WebSocket(`ws://127.0.0.1:${port}`);
      trackConnectChallengeNonce(nodeWs);
      await new Promise<void>((resolve) => nodeWs.once("open", resolve));
      const firstEventP = onceMessage<{
        type: "event";
        event: string;
        payload?: Record<string, unknown> | null;
      }>(nodeWs, (o) => o.type === "event" && o.event === "voicewake.routing.changed");
      await connectOk(nodeWs, {
        role: "node",
        client: {
          id: GATEWAY_CLIENT_NAMES.NODE_HOST,
          version: "1.0.0",
          platform: "ios",
          mode: GATEWAY_CLIENT_MODES.NODE,
        },
      });

      const first = await firstEventP;
      expect(first.event).toBe("voicewake.routing.changed");
      expect(
        (first.payload as { config?: { routes?: unknown[] } } | undefined)?.config?.routes,
      ).toEqual([]);

      const broadcastP = onceMessage<{
        type: "event";
        event: string;
        payload?: Record<string, unknown> | null;
      }>(nodeWs, (o) => o.type === "event" && o.event === "voicewake.routing.changed");

      const setRes = await rpcReq(ws, "voicewake.routing.set", {
        config: {
          defaultTarget: { mode: "current" },
          routes: [{ trigger: "hello", target: { sessionKey: "agent:main:main" } }],
        },
      });
      expect(setRes.ok).toBe(true);

      const broadcast = await broadcastP;
      expect(broadcast.event).toBe("voicewake.routing.changed");
      expect(
        (broadcast.payload as { config?: { routes?: unknown } } | undefined)?.config?.routes,
      ).toEqual([{ trigger: "hello", target: { sessionKey: "agent:main:main" } }]);

      nodeWs.close();
    });
  });

  test("models.list all view returns model catalog", async () => {
    seedPiCatalog();

    const res1 = await listModels({ view: "all" });
    const res2 = await listModels({ view: "all" });

    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);

    const models = res1.payload?.models ?? [];
    expect(models).toEqual(expectedSortedCatalog());

    expect(piSdkMock.discoverCalls).toBe(1);
  });

  test("models.list default view uses configured providers instead of the full catalog", async () => {
    await withModelsConfig(
      {
        models: {
          providers: {
            minimax: {
              baseUrl: "https://minimax.example.com/v1",
              models: [{ id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed" }],
            },
          },
        },
      },
      async () => {
        setPiCatalog([
          { id: "remote-a", provider: "unauth-a", name: "Remote A" },
          { id: "remote-b", provider: "unauth-b", name: "Remote B" },
        ]);
        const res = await listModels();
        expect(res.ok).toBe(true);
        expect(res.payload?.models).toEqual([
          {
            id: "MiniMax-M2.7-highspeed",
            name: "MiniMax M2.7 Highspeed",
            provider: "minimax",
          },
        ]);
      },
    );
  });

  test("models.list configured view includes auth-backed provider catalog entries", async () => {
    await withEnvAsync(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_OAUTH_TOKEN: undefined,
        OPENAI_API_KEY: "test-openai-key",
      },
      async () => {
        await withModelsConfig({}, async () => {
          seedPiCatalog();
          const res = await listModels({ view: "configured" });
          expect(res.ok).toBe(true);
          expect(res.payload?.models).toEqual([
            {
              id: "gpt-test-a",
              name: "A-Model",
              provider: "openai",
              contextWindow: 8000,
            },
            {
              id: "gpt-test-z",
              name: "gpt-test-z",
              provider: "openai",
            },
          ]);
        });
      },
    );
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
            minimax: {
              baseUrl: "https://minimax.example.com/v1",
              models: [{ id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed" }],
            },
          },
        },
      },
      async () => {
        setPiCatalog([
          { id: "remote-a", provider: "unauth-a", name: "Remote A" },
          { id: "remote-b", provider: "unauth-b", name: "Remote B" },
        ]);
        const res = await listModels({ view: "configured" });
        expect(res.ok).toBe(true);
        expect(res.payload?.models).toEqual([
          {
            id: "MiniMax-M2.7-highspeed",
            name: "MiniMax M2.7 Highspeed",
            provider: "minimax",
          },
          {
            id: "glm-4.5-air",
            name: "GLM 4.5 Air",
            provider: "zhipu",
            reasoning: true,
          },
        ]);
      },
    );
  });

  test("models.list configured view still prefers agents.defaults.models allowlist", async () => {
    await withModelsConfig(
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-test-z" },
            models: {
              "openai/gpt-test-z": {},
            },
          },
        },
        models: {
          providers: {
            minimax: {
              baseUrl: "https://minimax.example.com/v1",
              models: [{ id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed" }],
            },
          },
        },
      },
      async () => {
        seedPiCatalog();
        const res = await listModels({ view: "configured" });
        expect(res.ok).toBe(true);
        expect(res.payload?.models).toEqual([
          {
            id: "gpt-test-z",
            name: "gpt-test-z",
            provider: "openai",
          },
        ]);
      },
    );
  });

  test("models.list all view bypasses agents.defaults.models allowlist", async () => {
    await withModelsConfig(
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-test-z" },
            models: {
              "openai/gpt-test-z": {},
            },
          },
        },
      },
      async () => {
        seedPiCatalog();
        const res = await listModels({ view: "all" });
        expect(res.ok).toBe(true);
        expect(res.payload?.models).toEqual(expectedSortedCatalog());
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
          contextWindow: 200_000,
        },
        {
          id: "gpt-test-z",
          name: "gpt-test-z",
          provider: "openai",
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
        },
      ],
    });
  });

  test("models.list applies configured metadata and alias to synthetic allowlist entries", async () => {
    await withModelsConfig(
      {
        agents: {
          defaults: {
            model: { primary: "nvidia/moonshotai/kimi-k2.5" },
            models: {
              "nvidia/moonshotai/kimi-k2.5": { alias: "Kimi K2.5 (NVIDIA)" },
            },
          },
        },
        models: {
          providers: {
            nvidia: {
              baseUrl: "https://nvidia.example.com",
              models: [
                {
                  id: "moonshotai/kimi-k2.5",
                  name: "Kimi K2.5 (Configured)",
                  contextWindow: 32_000,
                },
              ],
            },
          },
        },
      },
      async () => {
        seedPiCatalog();
        const res = await listModels();
        expect(res.ok).toBe(true);
        expect(res.payload?.models).toEqual([
          {
            id: "moonshotai/kimi-k2.5",
            name: "Kimi K2.5 (Configured)",
            alias: "Kimi K2.5 (NVIDIA)",
            provider: "nvidia",
            contextWindow: 32_000,
          },
        ]);
      },
    );
  });

  test("models.list prefers configured provider metadata over discovered entries", async () => {
    await withModelsConfig(
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-test-z" },
            models: {
              "openai/gpt-test-z": { alias: "GPT Test Z Alias" },
            },
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com",
              models: [
                {
                  id: "gpt-test-z",
                  name: "Configured GPT Test Z",
                  contextWindow: 64_000,
                },
              ],
            },
          },
        },
      },
      async () => {
        seedPiCatalog();
        const res = await listModels();
        expect(res.ok).toBe(true);
        expect(res.payload?.models).toEqual([
          {
            id: "gpt-test-z",
            name: "Configured GPT Test Z",
            alias: "GPT Test Z Alias",
            provider: "openai",
            contextWindow: 64_000,
          },
        ]);
      },
    );
  });

  test("models.list rejects unknown params", async () => {
    piSdkMock.enabled = true;
    piSdkMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];

    const res = await rpcReq(ws, "models.list", { extra: true });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toMatch(/invalid models\.list params/i);
  });
});

describe("gateway server misc", () => {
  test("hello-ok advertises the gateway port for canvas host", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "secret" }, async () => {
      testTailnetIPv4.value = "100.64.0.1";
      testState.gatewayBind = "lan";
      const canvasPort = await getFreePort();
      testState.canvasHostPort = canvasPort;
      await withEnvAsync({ OPENCLAW_CANVAS_HOST_PORT: String(canvasPort) }, async () => {
        const testPort = await getFreePort();
        const canvasHostUrl = resolveCanvasHostUrl({
          canvasPort,
          requestHost: `100.64.0.1:${testPort}`,
          localAddress: "127.0.0.1",
        });
        expect(canvasHostUrl).toBe(`http://100.64.0.1:${canvasPort}`);
      });
    });
  });

  test("send dedupes by idempotencyKey", { timeout: 15_000 }, async () => {
    let dedicatedServer: Awaited<ReturnType<typeof startServerWithClient>>["server"] | undefined;
    let dedicatedWs: WebSocket | undefined;
    const idem = "same-key";
    try {
      setTestPluginRegistry(whatsappRegistry);
      const started = await startConnectedServerWithClient();
      dedicatedServer = started.server;
      dedicatedWs = started.ws;
      const socket = dedicatedWs;
      if (!socket) {
        throw new Error("Missing test websocket");
      }
      const res1P = onceMessage(socket, (o) => o.type === "res" && o.id === "a1");
      const res2P = onceMessage(socket, (o) => o.type === "res" && o.id === "a2");
      const sendReq = (id: string) =>
        socket.send(
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
      expect(res2.ok).toBe(res1.ok);
      if (res1.ok) {
        expect(res2.payload).toEqual(res1.payload);
      } else {
        expect(res2.error).toEqual(res1.error);
      }
    } finally {
      dedicatedWs?.close();
      await dedicatedServer?.close();
      resetTestPluginRegistry();
    }
  });

  test("auto-enables configured channel plugins on startup", async () => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("Missing OPENCLAW_CONFIG_PATH");
    }
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          channels: {
            discord: {
              token: "token-123",
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await withEnvAsync(
      {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
      },
      async () => {
        const autoPort = await getFreePort();
        const autoServer = await startGatewayServer(autoPort);
        await autoServer.close();
      },
    );

    const updated = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    const channels = updated.channels as Record<string, unknown> | undefined;
    const discord = channels?.discord as Record<string, unknown> | undefined;
    expect(discord).toMatchObject({
      token: "token-123",
      enabled: true,
    });
  });

  test("releases port after close", async () => {
    const releasePort = await getFreePort();
    const releaseServer = await startGatewayServer(releasePort);
    await releaseServer.close();

    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(releasePort, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve, reject) =>
      probe.close((err) => (err ? reject(err) : resolve())),
    );
  });
});
