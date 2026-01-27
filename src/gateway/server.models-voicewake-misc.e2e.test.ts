import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";

import { getChannelPlugin } from "../channels/plugins/index.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.js";
import { resolveCanvasHostUrl } from "../infra/canvas-host-url.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin } from "../test-utils/channel-plugins.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  occupyPort,
  onceMessage,
  piSdkMock,
  rpcReq,
  startGatewayServer,
  startServerWithClient,
  testState,
  testTailnetIPv4,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: WebSocket;
let port: number;

beforeAll(async () => {
  const started = await startServerWithClient();
  server = started.server;
  ws = started.ws;
  port = started.port;
  await connectOk(ws);
});

afterAll(async () => {
  ws.close();
  await server.close();
});

const whatsappOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ deps, to, text }) => {
    if (!deps?.sendWhatsApp) {
      throw new Error("Missing sendWhatsApp dep");
    }
    return { channel: "whatsapp", ...(await deps.sendWhatsApp(to, text, {})) };
  },
  sendMedia: async ({ deps, to, text, mediaUrl }) => {
    if (!deps?.sendWhatsApp) {
      throw new Error("Missing sendWhatsApp dep");
    }
    return { channel: "whatsapp", ...(await deps.sendWhatsApp(to, text, { mediaUrl })) };
  },
};

const whatsappPlugin = createOutboundTestPlugin({
  id: "whatsapp",
  outbound: whatsappOutbound,
  label: "WhatsApp",
});

const createRegistry = (channels: PluginRegistry["channels"]): PluginRegistry => ({
  plugins: [],
  tools: [],
  channels,
  providers: [],
  gatewayHandlers: {},
  httpHandlers: [],
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  diagnostics: [],
});

const whatsappRegistry = createRegistry([
  {
    pluginId: "whatsapp",
    source: "test",
    plugin: whatsappPlugin,
  },
]);
const emptyRegistry = createRegistry([]);

describe("gateway server models + voicewake", () => {
  const setTempHome = (homeDir: string) => {
    const prevHome = process.env.HOME;
    const prevStateDir = process.env.CLAWDBOT_STATE_DIR;
    const prevUserProfile = process.env.USERPROFILE;
    const prevHomeDrive = process.env.HOMEDRIVE;
    const prevHomePath = process.env.HOMEPATH;
    process.env.HOME = homeDir;
    process.env.CLAWDBOT_STATE_DIR = path.join(homeDir, ".clawdbot");
    process.env.USERPROFILE = homeDir;
    if (process.platform === "win32") {
      const parsed = path.parse(homeDir);
      process.env.HOMEDRIVE = parsed.root.replace(/\\$/, "");
      process.env.HOMEPATH = homeDir.slice(Math.max(parsed.root.length - 1, 0));
    }
    return () => {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
      if (prevStateDir === undefined) {
        delete process.env.CLAWDBOT_STATE_DIR;
      } else {
        process.env.CLAWDBOT_STATE_DIR = prevStateDir;
      }
      if (prevUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = prevUserProfile;
      }
      if (process.platform === "win32") {
        if (prevHomeDrive === undefined) {
          delete process.env.HOMEDRIVE;
        } else {
          process.env.HOMEDRIVE = prevHomeDrive;
        }
        if (prevHomePath === undefined) {
          delete process.env.HOMEPATH;
        } else {
          process.env.HOMEPATH = prevHomePath;
        }
      }
    };
  };

  test(
    "voicewake.get returns defaults and voicewake.set broadcasts",
    { timeout: 60_000 },
    async () => {
      const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-home-"));
      const restoreHome = setTempHome(homeDir);

      const initial = await rpcReq<{ triggers: string[] }>(ws, "voicewake.get");
      expect(initial.ok).toBe(true);
      expect(initial.payload?.triggers).toEqual(["clawd", "claude", "computer"]);

      const changedP = onceMessage<{
        type: "event";
        event: string;
        payload?: unknown;
      }>(ws, (o) => o.type === "event" && o.event === "voicewake.changed");

      const setRes = await rpcReq<{ triggers: string[] }>(ws, "voicewake.set", {
        triggers: ["  hi  ", "", "there"],
      });
      expect(setRes.ok).toBe(true);
      expect(setRes.payload?.triggers).toEqual(["hi", "there"]);

      const changed = await changedP;
      expect(changed.event).toBe("voicewake.changed");
      expect((changed.payload as { triggers?: unknown } | undefined)?.triggers).toEqual([
        "hi",
        "there",
      ]);

      const after = await rpcReq<{ triggers: string[] }>(ws, "voicewake.get");
      expect(after.ok).toBe(true);
      expect(after.payload?.triggers).toEqual(["hi", "there"]);

      const onDisk = JSON.parse(
        await fs.readFile(path.join(homeDir, ".clawdbot", "settings", "voicewake.json"), "utf8"),
      ) as { triggers?: unknown; updatedAtMs?: unknown };
      expect(onDisk.triggers).toEqual(["hi", "there"]);
      expect(typeof onDisk.updatedAtMs).toBe("number");

      restoreHome();
    },
  );

  test("pushes voicewake.changed to nodes on connect and on updates", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-home-"));
    const restoreHome = setTempHome(homeDir);

    const nodeWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => nodeWs.once("open", resolve));
    const firstEventP = onceMessage<{ type: "event"; event: string; payload?: unknown }>(
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

    const first = await firstEventP;
    expect(first.event).toBe("voicewake.changed");
    expect((first.payload as { triggers?: unknown } | undefined)?.triggers).toEqual([
      "clawd",
      "claude",
      "computer",
    ]);

    const broadcastP = onceMessage<{ type: "event"; event: string; payload?: unknown }>(
      nodeWs,
      (o) => o.type === "event" && o.event === "voicewake.changed",
    );
    const setRes = await rpcReq<{ triggers: string[] }>(ws, "voicewake.set", {
      triggers: ["clawd", "computer"],
    });
    expect(setRes.ok).toBe(true);

    const broadcast = await broadcastP;
    expect(broadcast.event).toBe("voicewake.changed");
    expect((broadcast.payload as { triggers?: unknown } | undefined)?.triggers).toEqual([
      "clawd",
      "computer",
    ]);

    nodeWs.close();
    restoreHome();
  });

  test("models.list returns model catalog", async () => {
    piSdkMock.enabled = true;
    piSdkMock.models = [
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

    const res1 = await rpcReq<{
      models: Array<{
        id: string;
        name: string;
        provider: string;
        contextWindow?: number;
      }>;
    }>(ws, "models.list");

    const res2 = await rpcReq<{
      models: Array<{
        id: string;
        name: string;
        provider: string;
        contextWindow?: number;
      }>;
    }>(ws, "models.list");

    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);

    const models = res1.payload?.models ?? [];
    expect(models).toEqual([
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
    ]);

    expect(piSdkMock.discoverCalls).toBe(1);
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
    const prevToken = process.env.CLAWDBOT_GATEWAY_TOKEN;
    const prevCanvasPort = process.env.CLAWDBOT_CANVAS_HOST_PORT;
    process.env.CLAWDBOT_GATEWAY_TOKEN = "secret";
    testTailnetIPv4.value = "100.64.0.1";
    testState.gatewayBind = "lan";
    const canvasPort = await getFreePort();
    testState.canvasHostPort = canvasPort;
    process.env.CLAWDBOT_CANVAS_HOST_PORT = String(canvasPort);

    const testPort = await getFreePort();
    const canvasHostUrl = resolveCanvasHostUrl({
      canvasPort,
      requestHost: `100.64.0.1:${testPort}`,
      localAddress: "127.0.0.1",
    });
    expect(canvasHostUrl).toBe(`http://100.64.0.1:${canvasPort}`);
    if (prevToken === undefined) {
      delete process.env.CLAWDBOT_GATEWAY_TOKEN;
    } else {
      process.env.CLAWDBOT_GATEWAY_TOKEN = prevToken;
    }
    if (prevCanvasPort === undefined) {
      delete process.env.CLAWDBOT_CANVAS_HOST_PORT;
    } else {
      process.env.CLAWDBOT_CANVAS_HOST_PORT = prevCanvasPort;
    }
  });

  test("send dedupes by idempotencyKey", { timeout: 60_000 }, async () => {
    const prevRegistry = getActivePluginRegistry() ?? emptyRegistry;
    try {
      setActivePluginRegistry(whatsappRegistry);
      expect(getChannelPlugin("whatsapp")).toBeDefined();

      const idem = "same-key";
      const res1P = onceMessage(ws, (o) => o.type === "res" && o.id === "a1");
      const res2P = onceMessage(ws, (o) => o.type === "res" && o.id === "a2");
      const sendReq = (id: string) =>
        ws.send(
          JSON.stringify({
            type: "req",
            id,
            method: "send",
            params: { to: "+15550000000", message: "hi", idempotencyKey: idem },
          }),
        );
      sendReq("a1");
      sendReq("a2");

      const res1 = await res1P;
      const res2 = await res2P;
      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);
      expect(res1.payload).toEqual(res2.payload);
    } finally {
      setActivePluginRegistry(prevRegistry);
    }
  });

  test("auto-enables configured channel plugins on startup", async () => {
    const configPath = process.env.CLAWDBOT_CONFIG_PATH;
    if (!configPath) throw new Error("Missing CLAWDBOT_CONFIG_PATH");
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

    const autoPort = await getFreePort();
    const autoServer = await startGatewayServer(autoPort);
    await autoServer.close();

    const updated = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    const plugins = updated.plugins as Record<string, unknown> | undefined;
    const entries = plugins?.entries as Record<string, unknown> | undefined;
    const discord = entries?.discord as Record<string, unknown> | undefined;
    expect(discord?.enabled).toBe(true);
    expect((updated.channels as Record<string, unknown> | undefined)?.discord).toMatchObject({
      token: "token-123",
    });
  });

  test("refuses to start when port already bound", async () => {
    const { server: blocker, port: blockedPort } = await occupyPort();
    await expect(startGatewayServer(blockedPort)).rejects.toBeInstanceOf(GatewayLockError);
    await expect(startGatewayServer(blockedPort)).rejects.toThrow(/already listening/i);
    blocker.close();
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
