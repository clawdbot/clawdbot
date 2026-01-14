import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { rawDataToString } from "../infra/ws.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-channel.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";

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
    const port = await getFreePort();
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

async function connectClient(params: { url: string; token?: string }) {
  const { GatewayClient } = await import("./client.js");
  return await new Promise<InstanceType<typeof GatewayClient>>(
    (resolve, reject) => {
      let settled = false;
      const stop = (
        err?: Error,
        client?: InstanceType<typeof GatewayClient>,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(client as InstanceType<typeof GatewayClient>);
      };
      const client = new GatewayClient({
        url: params.url,
        token: params.token,
        clientName: GATEWAY_CLIENT_NAMES.TEST,
        clientDisplayName: "vitest-wizard",
        clientVersion: "dev",
        mode: GATEWAY_CLIENT_MODES.TEST,
        onHelloOk: () => stop(undefined, client),
        onConnectError: (err) => stop(err),
        onClose: (code, reason) =>
          stop(new Error(`gateway closed during connect (${code}): ${reason}`)),
      });
      const timer = setTimeout(
        () => stop(new Error("gateway connect timeout")),
        10_000,
      );
      timer.unref();
      client.start();
    },
  );
}

type WizardStep = {
  id: string;
  type: "note" | "select" | "text" | "confirm" | "multiselect" | "progress";
};

type WizardNextPayload = {
  sessionId?: string;
  done: boolean;
  status: "running" | "done" | "cancelled" | "error";
  step?: WizardStep;
  error?: string;
};

describe("gateway wizard (e2e)", () => {
  it("runs wizard over ws and writes auth token config", async () => {
    const prev = {
      home: process.env.HOME,
      stateDir: process.env.CLAWDBOT_STATE_DIR,
      configPath: process.env.CLAWDBOT_CONFIG_PATH,
      token: process.env.CLAWDBOT_GATEWAY_TOKEN,
      skipChannels: process.env.CLAWDBOT_SKIP_CHANNELS,
      skipGmail: process.env.CLAWDBOT_SKIP_GMAIL_WATCHER,
      skipCron: process.env.CLAWDBOT_SKIP_CRON,
      skipCanvas: process.env.CLAWDBOT_SKIP_CANVAS_HOST,
    };

    process.env.CLAWDBOT_SKIP_CHANNELS = "1";
    process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = "1";
    process.env.CLAWDBOT_SKIP_CRON = "1";
    process.env.CLAWDBOT_SKIP_CANVAS_HOST = "1";
    delete process.env.CLAWDBOT_GATEWAY_TOKEN;

    const tempHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-wizard-home-"),
    );
    process.env.HOME = tempHome;
    delete process.env.CLAWDBOT_STATE_DIR;
    delete process.env.CLAWDBOT_CONFIG_PATH;

    const wizardToken = `wiz-${randomUUID()}`;
    const port = await getFreeGatewayPort();
    const { startGatewayServer } = await import("./server.js");
    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "none" },
      controlUiEnabled: false,
      wizardRunner: async (_opts, _runtime, prompter) => {
        await prompter.intro("Wizard E2E");
        await prompter.note("write token");
        const token = await prompter.text({ message: "token" });
        const { writeConfigFile } = await import("../config/config.js");
        await writeConfigFile({
          gateway: { auth: { mode: "token", token: String(token) } },
        });
        await prompter.outro("ok");
      },
    });

    const client = await connectClient({ url: `ws://127.0.0.1:${port}` });

    try {
      const start = await client.request<WizardNextPayload>("wizard.start", {
        mode: "local",
      });
      const sessionId = start.sessionId;
      expect(typeof sessionId).toBe("string");

      let next: WizardNextPayload = start;
      let didSendToken = false;
      while (!next.done) {
        const step = next.step;
        if (!step) throw new Error("wizard missing step");
        const value = step.type === "text" ? wizardToken : null;
        if (step.type === "text") didSendToken = true;
        next = await client.request<WizardNextPayload>("wizard.next", {
          sessionId,
          answer: { stepId: step.id, value },
        });
      }

      expect(didSendToken).toBe(true);
      expect(next.status).toBe("done");

      const { CONFIG_PATH_CLAWDBOT } = await import("../config/config.js");
      const parsed = JSON.parse(
        await fs.readFile(CONFIG_PATH_CLAWDBOT, "utf8"),
      );
      const token = (parsed as Record<string, unknown>)?.gateway as
        | Record<string, unknown>
        | undefined;
      expect((token?.auth as { token?: string } | undefined)?.token).toBe(
        wizardToken,
      );
    } finally {
      client.stop();
      await server.close({ reason: "wizard e2e complete" });
    }

    const port2 = await getFreeGatewayPort();
    const { startGatewayServer: startGatewayServer2 } = await import(
      "./server.js"
    );
    const server2 = await startGatewayServer2(port2, {
      bind: "loopback",
      controlUiEnabled: false,
    });
    try {
      const resNoToken = await connectReq({
        url: `ws://127.0.0.1:${port2}`,
      });
      expect(resNoToken.ok).toBe(false);
      expect(resNoToken.error?.message ?? "").toContain("unauthorized");

      const resToken = await connectReq({
        url: `ws://127.0.0.1:${port2}`,
        token: wizardToken,
      });
      expect(resToken.ok).toBe(true);
    } finally {
      await server2.close({ reason: "wizard auth verify" });
      await fs.rm(tempHome, { recursive: true, force: true });
      process.env.HOME = prev.home;
      process.env.CLAWDBOT_STATE_DIR = prev.stateDir;
      process.env.CLAWDBOT_CONFIG_PATH = prev.configPath;
      process.env.CLAWDBOT_GATEWAY_TOKEN = prev.token;
      process.env.CLAWDBOT_SKIP_CHANNELS = prev.skipChannels;
      process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = prev.skipGmail;
      process.env.CLAWDBOT_SKIP_CRON = prev.skipCron;
      process.env.CLAWDBOT_SKIP_CANVAS_HOST = prev.skipCanvas;
    }
  }, 60_000);
});
