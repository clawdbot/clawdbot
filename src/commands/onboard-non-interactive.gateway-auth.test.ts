import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { PROTOCOL_VERSION } from "../gateway/protocol/index.js";
import { rawDataToString } from "../infra/ws.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-channel.js";

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("failed to acquire free port"));
        return;
      }
      const port = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function onceMessage<T = unknown>(
  ws: WebSocket,
  filter: (obj: unknown) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const closeHandler = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      ws.off("message", handler);
      reject(new Error(`closed ${code}: ${rawDataToString(reason)}`));
    };
    const handler = (data: WebSocket.RawData) => {
      const obj = JSON.parse(rawDataToString(data));
      if (!filter(obj)) return;
      clearTimeout(timer);
      ws.off("message", handler);
      ws.off("close", closeHandler);
      resolve(obj as T);
    };
    ws.on("message", handler);
    ws.once("close", closeHandler);
  });
}

async function connectReq(params: { url: string; token?: string }) {
  const ws = new WebSocket(params.url);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  ws.send(
    JSON.stringify({
      type: "req",
      id: "c1",
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: GATEWAY_CLIENT_NAMES.TEST,
          displayName: "vitest",
          version: "dev",
          platform: process.platform,
          mode: GATEWAY_CLIENT_MODES.TEST,
        },
        caps: [],
        auth: params.token ? { token: params.token } : undefined,
      },
    }),
  );
  const res = await onceMessage<{
    type: "res";
    id: string;
    ok: boolean;
    error?: { message?: string };
  }>(ws, (o) => {
    const obj = o as { type?: unknown; id?: unknown } | undefined;
    return obj?.type === "res" && obj?.id === "c1";
  });
  ws.close();
  return res;
}

describe("onboard (non-interactive): gateway auth", () => {
  it("writes gateway token auth into config and gateway enforces it", async () => {
    const prev = {
      home: process.env.HOME,
      stateDir: process.env.CLAWDBOT_STATE_DIR,
      configPath: process.env.CLAWDBOT_CONFIG_PATH,
      skipChannels: process.env.CLAWDBOT_SKIP_CHANNELS,
      skipGmail: process.env.CLAWDBOT_SKIP_GMAIL_WATCHER,
      skipCron: process.env.CLAWDBOT_SKIP_CRON,
      skipCanvas: process.env.CLAWDBOT_SKIP_CANVAS_HOST,
      token: process.env.CLAWDBOT_GATEWAY_TOKEN,
    };

    process.env.CLAWDBOT_SKIP_CHANNELS = "1";
    process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = "1";
    process.env.CLAWDBOT_SKIP_CRON = "1";
    process.env.CLAWDBOT_SKIP_CANVAS_HOST = "1";
    delete process.env.CLAWDBOT_GATEWAY_TOKEN;

    const tempHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-onboard-noninteractive-"),
    );
    process.env.HOME = tempHome;
    delete process.env.CLAWDBOT_STATE_DIR;
    delete process.env.CLAWDBOT_CONFIG_PATH;

    const token = "tok_test_123";
    const workspace = path.join(tempHome, "clawd");

    const runtime = {
      log: () => {},
      error: (msg: string) => {
        throw new Error(msg);
      },
      exit: (code: number) => {
        throw new Error(`exit:${code}`);
      },
    };

    const { runNonInteractiveOnboarding } = await import(
      "./onboard-non-interactive.js"
    );
    await runNonInteractiveOnboarding(
      {
        nonInteractive: true,
        mode: "local",
        workspace,
        authChoice: "skip",
        skipSkills: true,
        skipHealth: true,
        installDaemon: false,
        gatewayBind: "loopback",
        gatewayAuth: "token",
        gatewayToken: token,
      },
      runtime,
    );

    const { CONFIG_PATH_CLAWDBOT } = await import("../config/config.js");
    const cfg = JSON.parse(await fs.readFile(CONFIG_PATH_CLAWDBOT, "utf8")) as {
      gateway?: { auth?: { mode?: string; token?: string } };
      agents?: { defaults?: { workspace?: string } };
    };

    expect(cfg?.agents?.defaults?.workspace).toBe(workspace);
    expect(cfg?.gateway?.auth?.mode).toBe("token");
    expect(cfg?.gateway?.auth?.token).toBe(token);

    const { startGatewayServer } = await import("../gateway/server.js");
    const port = await getFreePort();
    const server = await startGatewayServer(port, {
      bind: "loopback",
      controlUiEnabled: false,
    });
    try {
      const resNoToken = await connectReq({ url: `ws://127.0.0.1:${port}` });
      expect(resNoToken.ok).toBe(false);
      expect(resNoToken.error?.message ?? "").toContain("unauthorized");

      const resToken = await connectReq({
        url: `ws://127.0.0.1:${port}`,
        token,
      });
      expect(resToken.ok).toBe(true);
    } finally {
      await server.close({ reason: "non-interactive onboard auth test" });
    }

    await fs.rm(tempHome, { recursive: true, force: true });
    process.env.HOME = prev.home;
    process.env.CLAWDBOT_STATE_DIR = prev.stateDir;
    process.env.CLAWDBOT_CONFIG_PATH = prev.configPath;
    process.env.CLAWDBOT_SKIP_CHANNELS = prev.skipChannels;
    process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = prev.skipGmail;
    process.env.CLAWDBOT_SKIP_CRON = prev.skipCron;
    process.env.CLAWDBOT_SKIP_CANVAS_HOST = prev.skipCanvas;
    process.env.CLAWDBOT_GATEWAY_TOKEN = prev.token;
  }, 60_000);
});
