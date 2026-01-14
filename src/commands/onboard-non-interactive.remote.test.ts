import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

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

describe("onboard (non-interactive): remote gateway config", () => {
  it("writes gateway.remote url/token and callGateway uses them", async () => {
    const prev = {
      home: process.env.HOME,
      stateDir: process.env.CLAWDBOT_STATE_DIR,
      configPath: process.env.CLAWDBOT_CONFIG_PATH,
      skipChannels: process.env.CLAWDBOT_SKIP_CHANNELS,
      skipGmail: process.env.CLAWDBOT_SKIP_GMAIL_WATCHER,
      skipCron: process.env.CLAWDBOT_SKIP_CRON,
      skipCanvas: process.env.CLAWDBOT_SKIP_CANVAS_HOST,
      token: process.env.CLAWDBOT_GATEWAY_TOKEN,
      password: process.env.CLAWDBOT_GATEWAY_PASSWORD,
    };

    process.env.CLAWDBOT_SKIP_CHANNELS = "1";
    process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = "1";
    process.env.CLAWDBOT_SKIP_CRON = "1";
    process.env.CLAWDBOT_SKIP_CANVAS_HOST = "1";
    delete process.env.CLAWDBOT_GATEWAY_TOKEN;
    delete process.env.CLAWDBOT_GATEWAY_PASSWORD;

    const tempHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-onboard-remote-"),
    );
    process.env.HOME = tempHome;
    delete process.env.CLAWDBOT_STATE_DIR;
    delete process.env.CLAWDBOT_CONFIG_PATH;

    const port = await getFreePort();
    const token = "tok_remote_123";
    const { startGatewayServer } = await import("../gateway/server.js");
    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
    });

    const runtime = {
      log: () => {},
      error: (msg: string) => {
        throw new Error(msg);
      },
      exit: (code: number) => {
        throw new Error(`exit:${code}`);
      },
    };

    try {
      const { runNonInteractiveOnboarding } = await import(
        "./onboard-non-interactive.js"
      );
      await runNonInteractiveOnboarding(
        {
          nonInteractive: true,
          mode: "remote",
          remoteUrl: `ws://127.0.0.1:${port}`,
          remoteToken: token,
          authChoice: "skip",
          json: true,
        },
        runtime,
      );

      const { CONFIG_PATH_CLAWDBOT } = await import("../config/config.js");
      const cfg = JSON.parse(
        await fs.readFile(CONFIG_PATH_CLAWDBOT, "utf8"),
      ) as {
        gateway?: { mode?: string; remote?: { url?: string; token?: string } };
      };

      expect(cfg.gateway?.mode).toBe("remote");
      expect(cfg.gateway?.remote?.url).toBe(`ws://127.0.0.1:${port}`);
      expect(cfg.gateway?.remote?.token).toBe(token);

      const { callGateway } = await import("../gateway/call.js");
      const health = await callGateway<{ ok?: boolean }>({ method: "health" });
      expect(health?.ok).toBe(true);
    } finally {
      await server.close({ reason: "non-interactive remote test complete" });
      await fs.rm(tempHome, { recursive: true, force: true });
      process.env.HOME = prev.home;
      process.env.CLAWDBOT_STATE_DIR = prev.stateDir;
      process.env.CLAWDBOT_CONFIG_PATH = prev.configPath;
      process.env.CLAWDBOT_SKIP_CHANNELS = prev.skipChannels;
      process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = prev.skipGmail;
      process.env.CLAWDBOT_SKIP_CRON = prev.skipCron;
      process.env.CLAWDBOT_SKIP_CANVAS_HOST = prev.skipCanvas;
      process.env.CLAWDBOT_GATEWAY_TOKEN = prev.token;
      process.env.CLAWDBOT_GATEWAY_PASSWORD = prev.password;
    }
  }, 60_000);
});
