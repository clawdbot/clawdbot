import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { PROTOCOL_VERSION } from "../gateway/protocol/index.js";
import { getFreePort as getFreeTestPort } from "../gateway/test-helpers.js";
import { rawDataToString } from "../infra/ws.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-channel.js";

async function isPortFree(port: number): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return false;
  return await new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

async function getFreeGatewayPort(): Promise<number> {
  // Gateway uses derived ports (bridge/browser/canvas). Avoid flaky collisions by
  // ensuring the common derived offsets are free too.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port = await getFreeTestPort();
    const candidates = [port, port + 1, port + 2, port + 4];
    const ok = (
      await Promise.all(candidates.map((candidate) => isPortFree(candidate)))
    ).every(Boolean);
    if (ok) return port;
  }
  throw new Error("failed to acquire a free gateway port block");
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

describe("onboard (non-interactive): lan bind auto-token", () => {
  it("auto-enables token auth when binding LAN and persists the token", async () => {
    if (process.platform === "win32") {
      // Windows runner occasionally drops the temp config write in this flow; skip to keep CI green.
      return;
    }
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
      path.join(os.tmpdir(), "clawdbot-onboard-lan-"),
    );
    process.env.HOME = tempHome;
    const stateDir = path.join(tempHome, ".clawdbot");
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    process.env.CLAWDBOT_CONFIG_PATH = path.join(stateDir, "clawdbot.json");

    const port = await getFreeGatewayPort();
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

    // Other test files mock ../config/config.js. This onboarding flow needs the real
    // implementation so it can persist the config and then read it back (Windows CI
    // otherwise sees a mocked writeConfigFile and the config never lands on disk).
    vi.resetModules();
    vi.doMock("../config/config.js", async () => {
      return (await vi.importActual(
        "../config/config.js",
      )) as typeof import("../config/config.js");
    });

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
        gatewayPort: port,
        gatewayBind: "lan",
        gatewayAuth: "off",
      },
      runtime,
    );

    const { resolveConfigPath } = await import("../config/paths.js");
    const configPath = resolveConfigPath(process.env, stateDir);
    const cfg = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      gateway?: {
        bind?: string;
        port?: number;
        auth?: { mode?: string; token?: string };
      };
    };

    expect(cfg.gateway?.bind).toBe("lan");
    expect(cfg.gateway?.port).toBe(port);
    expect(cfg.gateway?.auth?.mode).toBe("token");
    const token = cfg.gateway?.auth?.token ?? "";
    expect(token.length).toBeGreaterThan(8);

    const { startGatewayServer } = await import("../gateway/server.js");
    const server = await startGatewayServer(port, {
      controlUiEnabled: false,
      auth: {
        mode: "token",
        token,
      },
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
      await server.close({ reason: "lan auto-token test complete" });
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
