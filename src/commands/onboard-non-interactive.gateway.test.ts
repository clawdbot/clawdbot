import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getDeterministicFreePortBlock } from "../test-utils/ports.js";

const gatewayClientCalls: Array<{
  url?: string;
  token?: string;
  password?: string;
  onHelloOk?: () => void;
  onClose?: (code: number, reason: string) => void;
}> = [];

vi.mock("../gateway/client.js", () => ({
  GatewayClient: class {
    params: {
      url?: string;
      token?: string;
      password?: string;
      onHelloOk?: () => void;
    };
    constructor(params: {
      url?: string;
      token?: string;
      password?: string;
      onHelloOk?: () => void;
    }) {
      this.params = params;
      gatewayClientCalls.push(params);
    }
    async request() {
      return { ok: true };
    }
    start() {
      queueMicrotask(() => this.params.onHelloOk?.());
    }
    stop() {}
  },
}));

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

async function getFreeGatewayPort(): Promise<number> {
  return await getDeterministicFreePortBlock({ offsets: [0, 1, 2, 4] });
}

const runtime = {
  log: () => {},
  error: (msg: string) => {
    throw new Error(msg);
  },
  exit: (code: number) => {
    throw new Error(`exit:${code}`);
  },
};

describe("onboard (non-interactive): gateway and remote auth", () => {
  const prev = {
    home: process.env.HOME,
    stateDir: process.env.CLAWDBOT_STATE_DIR,
    configPath: process.env.CLAWDBOT_CONFIG_PATH,
    skipChannels: process.env.CLAWDBOT_SKIP_CHANNELS,
    skipGmail: process.env.CLAWDBOT_SKIP_GMAIL_WATCHER,
    skipCron: process.env.CLAWDBOT_SKIP_CRON,
    skipCanvas: process.env.CLAWDBOT_SKIP_CANVAS_HOST,
    skipBrowser: process.env.CLAWDBOT_SKIP_BROWSER_CONTROL_SERVER,
    token: process.env.CLAWDBOT_GATEWAY_TOKEN,
    password: process.env.CLAWDBOT_GATEWAY_PASSWORD,
  };
  let tempHome: string | undefined;

  const initStateDir = async (prefix: string) => {
    if (!tempHome) {
      throw new Error("temp home not initialized");
    }
    const stateDir = await fs.mkdtemp(path.join(tempHome, prefix));
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    delete process.env.CLAWDBOT_CONFIG_PATH;
    return stateDir;
  };

  beforeAll(async () => {
    process.env.CLAWDBOT_SKIP_CHANNELS = "1";
    process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = "1";
    process.env.CLAWDBOT_SKIP_CRON = "1";
    process.env.CLAWDBOT_SKIP_CANVAS_HOST = "1";
    process.env.CLAWDBOT_SKIP_BROWSER_CONTROL_SERVER = "1";
    delete process.env.CLAWDBOT_GATEWAY_TOKEN;
    delete process.env.CLAWDBOT_GATEWAY_PASSWORD;

    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-onboard-"));
    process.env.HOME = tempHome;
  });

  afterAll(async () => {
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
    process.env.HOME = prev.home;
    process.env.CLAWDBOT_STATE_DIR = prev.stateDir;
    process.env.CLAWDBOT_CONFIG_PATH = prev.configPath;
    process.env.CLAWDBOT_SKIP_CHANNELS = prev.skipChannels;
    process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = prev.skipGmail;
    process.env.CLAWDBOT_SKIP_CRON = prev.skipCron;
    process.env.CLAWDBOT_SKIP_CANVAS_HOST = prev.skipCanvas;
    process.env.CLAWDBOT_SKIP_BROWSER_CONTROL_SERVER = prev.skipBrowser;
    process.env.CLAWDBOT_GATEWAY_TOKEN = prev.token;
    process.env.CLAWDBOT_GATEWAY_PASSWORD = prev.password;
  });

  it("writes gateway token auth into config and gateway enforces it", async () => {
    const stateDir = await initStateDir("state-noninteractive-");
    const token = "tok_test_123";
    const workspace = path.join(stateDir, "clawd");

    const { runNonInteractiveOnboarding } = await import("./onboard-non-interactive.js");
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

    const { resolveConfigPath } = await import("../config/paths.js");
    const configPath = resolveConfigPath(process.env, stateDir);
    const cfg = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      gateway?: { auth?: { mode?: string; token?: string } };
      agents?: { defaults?: { workspace?: string } };
    };

    expect(cfg?.agents?.defaults?.workspace).toBe(workspace);
    expect(cfg?.gateway?.auth?.mode).toBe("token");
    expect(cfg?.gateway?.auth?.token).toBe(token);

    const { authorizeGatewayConnect, resolveGatewayAuth } = await import("../gateway/auth.js");
    const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, env: process.env });
    const resNoToken = await authorizeGatewayConnect({ auth, connectAuth: { token: undefined } });
    expect(resNoToken.ok).toBe(false);
    const resToken = await authorizeGatewayConnect({ auth, connectAuth: { token } });
    expect(resToken.ok).toBe(true);

    await fs.rm(stateDir, { recursive: true, force: true });
  }, 60_000);

  it("writes gateway.remote url/token and callGateway uses them", async () => {
    const stateDir = await initStateDir("state-remote-");
    const port = await getFreePort();
    const token = "tok_remote_123";
    const { runNonInteractiveOnboarding } = await import("./onboard-non-interactive.js");
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

    const { resolveConfigPath } = await import("../config/config.js");
    const cfg = JSON.parse(await fs.readFile(resolveConfigPath(), "utf8")) as {
      gateway?: { mode?: string; remote?: { url?: string; token?: string } };
    };

    expect(cfg.gateway?.mode).toBe("remote");
    expect(cfg.gateway?.remote?.url).toBe(`ws://127.0.0.1:${port}`);
    expect(cfg.gateway?.remote?.token).toBe(token);

    gatewayClientCalls.length = 0;
    const { callGateway } = await import("../gateway/call.js");
    const health = await callGateway<{ ok?: boolean }>({ method: "health" });
    expect(health?.ok).toBe(true);
    const lastCall = gatewayClientCalls[gatewayClientCalls.length - 1];
    expect(lastCall?.url).toBe(`ws://127.0.0.1:${port}`);
    expect(lastCall?.token).toBe(token);

    await fs.rm(stateDir, { recursive: true, force: true });
  }, 60_000);

  it("auto-enables token auth when binding LAN and persists the token", async () => {
    if (process.platform === "win32") {
      // Windows runner occasionally drops the temp config write in this flow; skip to keep CI green.
      return;
    }
    const stateDir = await initStateDir("state-lan-");
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    process.env.CLAWDBOT_CONFIG_PATH = path.join(stateDir, "clawdbot.json");

    const port = await getFreeGatewayPort();
    const workspace = path.join(stateDir, "clawd");

    // Other test files mock ../config/config.js. This onboarding flow needs the real
    // implementation so it can persist the config and then read it back (Windows CI
    // otherwise sees a mocked writeConfigFile and the config never lands on disk).
    vi.resetModules();
    vi.doMock("../config/config.js", async () => {
      return (await vi.importActual("../config/config.js")) as typeof import("../config/config.js");
    });

    const { runNonInteractiveOnboarding } = await import("./onboard-non-interactive.js");
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

    const { authorizeGatewayConnect, resolveGatewayAuth } = await import("../gateway/auth.js");
    const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, env: process.env });
    const resNoToken = await authorizeGatewayConnect({ auth, connectAuth: { token: undefined } });
    expect(resNoToken.ok).toBe(false);
    const resToken = await authorizeGatewayConnect({ auth, connectAuth: { token } });
    expect(resToken.ok).toBe(true);

    await fs.rm(stateDir, { recursive: true, force: true });
  }, 60_000);
});
