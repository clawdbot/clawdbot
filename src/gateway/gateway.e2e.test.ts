import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  connectDeviceAuthReq,
  connectGatewayClient,
  getFreeGatewayPort,
} from "./test-helpers.e2e.js";
import { installOpenAiResponsesMock } from "./test-helpers.openai-mock.js";
import { startGatewayServer } from "./server.js";

function extractPayloadText(result: unknown): string {
  const record = result as Record<string, unknown>;
  const payloads = Array.isArray(record.payloads) ? record.payloads : [];
  const texts = payloads
    .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>).text : undefined))
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  return texts.join("\n").trim();
}

describe("gateway e2e", () => {
  it(
    "runs a mock OpenAI tool call end-to-end via gateway agent loop",
    { timeout: 90_000 },
    async () => {
      const prev = {
        home: process.env.HOME,
        configPath: process.env.CLAWDBOT_CONFIG_PATH,
        token: process.env.CLAWDBOT_GATEWAY_TOKEN,
        skipChannels: process.env.CLAWDBOT_SKIP_CHANNELS,
        skipGmail: process.env.CLAWDBOT_SKIP_GMAIL_WATCHER,
        skipCron: process.env.CLAWDBOT_SKIP_CRON,
        skipCanvas: process.env.CLAWDBOT_SKIP_CANVAS_HOST,
        skipBrowser: process.env.CLAWDBOT_SKIP_BROWSER_CONTROL_SERVER,
      };

      const { baseUrl: openaiBaseUrl, restore } = installOpenAiResponsesMock();

      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gw-mock-home-"));
      process.env.HOME = tempHome;
      process.env.CLAWDBOT_SKIP_CHANNELS = "1";
      process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = "1";
      process.env.CLAWDBOT_SKIP_CRON = "1";
      process.env.CLAWDBOT_SKIP_CANVAS_HOST = "1";
      process.env.CLAWDBOT_SKIP_BROWSER_CONTROL_SERVER = "1";

      const token = `test-${randomUUID()}`;
      process.env.CLAWDBOT_GATEWAY_TOKEN = token;

      const workspaceDir = path.join(tempHome, "clawd");
      await fs.mkdir(workspaceDir, { recursive: true });

      const nonceA = randomUUID();
      const nonceB = randomUUID();
      const toolProbePath = path.join(workspaceDir, `.clawdbot-tool-probe.${nonceA}.txt`);
      await fs.writeFile(toolProbePath, `nonceA=${nonceA}\nnonceB=${nonceB}\n`);

      const configDir = path.join(tempHome, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, "moltbot.json");

      const cfg = {
        agents: { defaults: { workspace: workspaceDir } },
        models: {
          mode: "replace",
          providers: {
            openai: {
              baseUrl: openaiBaseUrl,
              apiKey: "test",
              api: "openai-responses",
              models: [
                {
                  id: "gpt-5.2",
                  name: "gpt-5.2",
                  api: "openai-responses",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
        gateway: { auth: { token } },
      };

      await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
      process.env.CLAWDBOT_CONFIG_PATH = configPath;

      const port = await getFreeGatewayPort();
      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });

      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        clientDisplayName: "vitest-mock-openai",
      });

      try {
        const sessionKey = "agent:dev:mock-openai";

        await client.request<Record<string, unknown>>("sessions.patch", {
          key: sessionKey,
          model: "openai/gpt-5.2",
        });

        const runId = randomUUID();
        const payload = await client.request<{
          status?: unknown;
          result?: unknown;
        }>(
          "agent",
          {
            sessionKey,
            idempotencyKey: `idem-${runId}`,
            message:
              `Call the read tool on "${toolProbePath}". ` +
              `Then reply with exactly: ${nonceA} ${nonceB}. No extra text.`,
            deliver: false,
          },
          { expectFinal: true },
        );

        expect(payload?.status).toBe("ok");
        const text = extractPayloadText(payload?.result);
        expect(text).toContain(nonceA);
        expect(text).toContain(nonceB);
      } finally {
        client.stop();
        await server.close({ reason: "mock openai test complete" });
        await fs.rm(tempHome, { recursive: true, force: true });
        restore();
        process.env.HOME = prev.home;
        process.env.CLAWDBOT_CONFIG_PATH = prev.configPath;
        process.env.CLAWDBOT_GATEWAY_TOKEN = prev.token;
        process.env.CLAWDBOT_SKIP_CHANNELS = prev.skipChannels;
        process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = prev.skipGmail;
        process.env.CLAWDBOT_SKIP_CRON = prev.skipCron;
        process.env.CLAWDBOT_SKIP_CANVAS_HOST = prev.skipCanvas;
        process.env.CLAWDBOT_SKIP_BROWSER_CONTROL_SERVER = prev.skipBrowser;
      }
    },
  );

  it("runs wizard over ws and writes auth token config", { timeout: 90_000 }, async () => {
    const prev = {
      home: process.env.HOME,
      stateDir: process.env.CLAWDBOT_STATE_DIR,
      configPath: process.env.CLAWDBOT_CONFIG_PATH,
      token: process.env.CLAWDBOT_GATEWAY_TOKEN,
      skipChannels: process.env.CLAWDBOT_SKIP_CHANNELS,
      skipGmail: process.env.CLAWDBOT_SKIP_GMAIL_WATCHER,
      skipCron: process.env.CLAWDBOT_SKIP_CRON,
      skipCanvas: process.env.CLAWDBOT_SKIP_CANVAS_HOST,
      skipBrowser: process.env.CLAWDBOT_SKIP_BROWSER_CONTROL_SERVER,
    };

    process.env.CLAWDBOT_SKIP_CHANNELS = "1";
    process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = "1";
    process.env.CLAWDBOT_SKIP_CRON = "1";
    process.env.CLAWDBOT_SKIP_CANVAS_HOST = "1";
    process.env.CLAWDBOT_SKIP_BROWSER_CONTROL_SERVER = "1";
    delete process.env.CLAWDBOT_GATEWAY_TOKEN;

    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-wizard-home-"));
    process.env.HOME = tempHome;
    delete process.env.CLAWDBOT_STATE_DIR;
    delete process.env.CLAWDBOT_CONFIG_PATH;

    const wizardToken = `wiz-${randomUUID()}`;
    const port = await getFreeGatewayPort();
    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token: wizardToken },
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

    const client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: wizardToken,
      clientDisplayName: "vitest-wizard",
    });

    try {
      const start = await client.request<{
        sessionId?: string;
        done: boolean;
        status: "running" | "done" | "cancelled" | "error";
        step?: {
          id: string;
          type: "note" | "select" | "text" | "confirm" | "multiselect" | "progress";
        };
        error?: string;
      }>("wizard.start", { mode: "local" });
      const sessionId = start.sessionId;
      expect(typeof sessionId).toBe("string");

      let next = start;
      let didSendToken = false;
      while (!next.done) {
        const step = next.step;
        if (!step) throw new Error("wizard missing step");
        const value = step.type === "text" ? wizardToken : null;
        if (step.type === "text") didSendToken = true;
        next = await client.request("wizard.next", {
          sessionId,
          answer: { stepId: step.id, value },
        });
      }

      expect(didSendToken).toBe(true);
      expect(next.status).toBe("done");

      const { resolveConfigPath } = await import("../config/config.js");
      const parsed = JSON.parse(await fs.readFile(resolveConfigPath(), "utf8"));
      const token = (parsed as Record<string, unknown>)?.gateway as
        | Record<string, unknown>
        | undefined;
      expect((token?.auth as { token?: string } | undefined)?.token).toBe(wizardToken);
    } finally {
      client.stop();
      await server.close({ reason: "wizard e2e complete" });
    }

    const port2 = await getFreeGatewayPort();
    const server2 = await startGatewayServer(port2, {
      bind: "loopback",
      controlUiEnabled: false,
    });
    try {
      const resNoToken = await connectDeviceAuthReq({
        url: `ws://127.0.0.1:${port2}`,
      });
      expect(resNoToken.ok).toBe(false);
      expect(resNoToken.error?.message ?? "").toContain("unauthorized");

      const resToken = await connectDeviceAuthReq({
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
      process.env.CLAWDBOT_SKIP_BROWSER_CONTROL_SERVER = prev.skipBrowser;
    }
  });
});
