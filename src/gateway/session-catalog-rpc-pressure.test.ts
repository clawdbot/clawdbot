import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { clearGatewaySubagentRuntime } from "../plugins/runtime/gateway-bindings.test-fixtures.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { startGatewayServer } from "./server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getFreeGatewayPort,
} from "./test-helpers.e2e.js";

const GATEWAY_E2E_TIMEOUT_MS = 90_000;
let gatewayTestSeq = 0;

const GATEWAY_TEST_ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN",
  "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

function nextGatewayId(prefix: string): string {
  return `${prefix}-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}-${gatewayTestSeq++}`;
}

async function createEmptyBundledPluginsDir(tempHome: string): Promise<string> {
  const bundledPluginsDir = path.join(tempHome, "openclaw-test-empty-bundled-plugins");
  await fs.mkdir(bundledPluginsDir, { recursive: true });
  return bundledPluginsDir;
}

async function createGatewayConfigPath(tempHome: string): Promise<string> {
  const configPath = path.join(tempHome, ".openclaw", "openclaw.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  return configPath;
}

async function removeGatewayTempHome(tempHome: string): Promise<void> {
  await fs.rm(tempHome, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
}

async function startLoopbackTokenGateway(token: string) {
  const port = await getFreeGatewayPort();
  const server = await startGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token },
    controlUiEnabled: false,
    sidecarStartup: "defer",
  });
  return { port, server };
}

async function writeWorkspacePlugin(params: {
  workspaceDir: string;
  id: string;
  body: string;
  activation?: { onStartup?: boolean };
}): Promise<void> {
  const pluginDir = path.join(params.workspaceDir, ".openclaw", "extensions", params.id);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: params.id,
        ...(params.activation ? { activation: params.activation } : {}),
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(pluginDir, "index.cjs"), params.body, "utf8");
}

async function setupGatewayTempHome(prefix: string) {
  const envSnapshot = captureEnv(GATEWAY_TEST_ENV_KEYS);
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  setTestEnvValue("HOME", tempHome);
  setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tempHome, ".openclaw"));
  deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
  setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
  setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
  setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
  setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
  setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
  setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
  const workspaceDir = path.join(tempHome, "openclaw");
  await fs.mkdir(workspaceDir, { recursive: true });
  setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", await createEmptyBundledPluginsDir(tempHome));
  setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  return { envSnapshot, tempHome, workspaceDir };
}

function resetGatewayTestState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
  clearGatewaySubagentRuntime();
}

describe("session catalog RPC pressure e2e", () => {
  afterEach(resetGatewayTestState);

  it(
    "coalesces and queues session catalog RPC loads over a real loopback Gateway",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const { envSnapshot, tempHome, workspaceDir } = await setupGatewayTempHome(
        "openclaw-gw-session-catalog-pressure-home-",
      );

      const token = nextGatewayId("catalog-pressure-token");
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
      const eventsPath = path.join(tempHome, "catalog-events.jsonl");
      const releaseDir = path.join(tempHome, "catalog-release");
      await fs.mkdir(releaseDir, { recursive: true });
      await writeWorkspacePlugin({
        workspaceDir,
        id: "slow-session-catalog",
        activation: { onStartup: true },
        body: `
const fs = require("node:fs");
const path = require("node:path");
const eventsPath = ${JSON.stringify(eventsPath)};
const releaseDir = ${JSON.stringify(releaseDir)};
let callCount = 0;

function append(event) {
  fs.appendFileSync(eventsPath, JSON.stringify({ ...event, at: Date.now() }) + "\\n");
}

async function waitForRelease(callId) {
  const releasePath = path.join(releaseDir, String(callId));
  while (!fs.existsSync(releasePath)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

module.exports = {
  id: "slow-session-catalog",
  register(api) {
    api.registerSessionCatalog({
      id: "slow",
      label: "Slow Catalog",
      list: async (params) => {
        const callId = ++callCount;
        append({ event: "start", callId, search: params.search ?? "" });
        await waitForRelease(callId);
        append({ event: "finish", callId, search: params.search ?? "" });
        return [{ hostId: "host-" + (params.search ?? "all"), label: "Host", kind: "gateway", connected: true, sessions: [] }];
      },
      read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
    });
  },
};
`.trimStart(),
      });

      const configPath = await createGatewayConfigPath(tempHome);
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            agents: {
              defaults: { workspace: workspaceDir },
              list: [{ id: "main", default: true }],
            },
            plugins: { allow: ["slow-session-catalog"] },
            gateway: { auth: { token } },
          },
          null,
          2,
        )}\n`,
      );
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);

      const { port, server } = await startLoopbackTokenGateway(token);
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        clientDisplayName: "vitest-session-catalog-pressure",
        scopes: ["operator.read"],
      });

      const readEvents = async () => {
        try {
          return (await fs.readFile(eventsPath, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { event: string; callId: number; search: string });
        } catch {
          return [];
        }
      };
      const releaseCall = async (callId: number) => {
        await fs.writeFile(path.join(releaseDir, String(callId)), "release\n");
      };
      const expectStartCount = async (count: number) => {
        await expect
          .poll(
            async () => (await readEvents()).filter((event) => event.event === "start").length,
            {
              timeout: 5_000,
              interval: 25,
            },
          )
          .toBe(count);
      };

      try {
        const first = client.request("sessions.catalog.list", {
          catalogId: "slow",
          search: "same",
        });
        const second = client.request("sessions.catalog.list", {
          catalogId: "slow",
          search: "same",
          progressId: "same-follower",
        });
        await expectStartCount(1);
        await releaseCall(1);
        await expect(Promise.all([first, second])).resolves.toEqual([
          expect.objectContaining({ catalogs: [expect.objectContaining({ id: "slow" })] }),
          expect.objectContaining({ catalogs: [expect.objectContaining({ id: "slow" })] }),
        ]);

        const active = Array.from({ length: 4 }, (_, index) =>
          client.request("sessions.catalog.list", { catalogId: "slow", search: `queued-${index}` }),
        );
        await expectStartCount(5);

        const queued = client.request("sessions.catalog.list", {
          catalogId: "slow",
          search: "queued-fifth",
        });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });
        expect((await readEvents()).filter((event) => event.event === "start")).toHaveLength(5);

        await releaseCall(2);
        await expectStartCount(6);
        await Promise.all([3, 4, 5, 6].map(releaseCall));
        await expect(queued).resolves.toEqual(
          expect.objectContaining({ catalogs: [expect.objectContaining({ id: "slow" })] }),
        );
        await expect(Promise.all(active)).resolves.toHaveLength(4);
      } finally {
        await disconnectGatewayClient(client);
        await server.close({ reason: "session catalog pressure e2e complete" });
        await removeGatewayTempHome(tempHome);
        envSnapshot.restore();
      }
    },
  );
});
