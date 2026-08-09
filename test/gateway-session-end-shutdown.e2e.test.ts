// A real Gateway process must finish reset-started plugin work before SIGTERM exit.
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const PLUGIN_ID = "session-end-shutdown-proof";
const SESSION_KEY = "agent:main:dashboard:session-end-shutdown-proof";
const HOOK_DELAY_MS = 10_000;
const TEST_TIMEOUT_MS = 120_000;
const WAIT_OPTIONS = { timeout: 10_000, interval: 25 } as const;

const instances: OpenClawTestInstance[] = [];
const fixtureDirs: string[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map(async (instance) => await instance.cleanup()));
  await Promise.all(
    fixtureDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })),
  );
});

async function writeSessionEndPlugin(pluginDir: string, tracePath: string): Promise<void> {
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({
      id: PLUGIN_ID,
      name: "Session End Shutdown Proof",
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    })}\n`,
  );
  await writeFile(
    path.join(pluginDir, "index.mjs"),
    [
      'import { appendFileSync } from "node:fs";',
      "export default {",
      `  id: ${JSON.stringify(PLUGIN_ID)},`,
      "  register(api) {",
      '    api.on("session_end", async (event) => {',
      `      if (event.sessionKey !== ${JSON.stringify(SESSION_KEY)} || event.reason !== "reset") return;`,
      `      appendFileSync(${JSON.stringify(tracePath)}, "started\\n");`,
      `      await new Promise((resolve) => setTimeout(resolve, ${HOOK_DELAY_MS}));`,
      `      appendFileSync(${JSON.stringify(tracePath)}, "completed\\n");`,
      "    });",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
}

async function readTrace(tracePath: string): Promise<string[]> {
  try {
    return (await readFile(tracePath, "utf8")).split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

describe("Gateway session-end shutdown", () => {
  it(
    "finishes a real reset-started session_end hook after an operating-system SIGTERM",
    async () => {
      const fixtureDir = await mkdtemp(path.join(tmpdir(), "openclaw-session-end-shutdown-"));
      fixtureDirs.push(fixtureDir);
      const pluginDir = path.join(fixtureDir, "plugin");
      const tracePath = path.join(fixtureDir, "session-end.trace");
      await writeSessionEndPlugin(pluginDir, tracePath);

      const config = {
        plugins: {
          enabled: true,
          allow: [PLUGIN_ID],
          load: { paths: [pluginDir] },
          entries: { [PLUGIN_ID]: { enabled: true } },
          slots: { memory: "none" },
        },
      } satisfies OpenClawConfig;
      const instance = await createOpenClawTestInstance({
        name: "session-end-shutdown",
        config,
        env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
        stopTimeoutMs: 10_000,
      });
      instances.push(instance);
      await instance.startGateway();

      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });

      try {
        await vi.waitFor(async () => {
          const created = await client.request<{ key: string; sessionId: string }>(
            "sessions.create",
            { agentId: "main", key: SESSION_KEY },
          );
          expect(created.key).toBe(SESSION_KEY);
          expect(created.sessionId).toBeTruthy();
        }, WAIT_OPTIONS);

        await client.request("sessions.reset", { key: SESSION_KEY, reason: "reset" });
        await vi.waitFor(async () => {
          expect(await readTrace(tracePath), instance.logs()).toEqual(["started"]);
        }, WAIT_OPTIONS);

        const child = instance.child;
        if (!child) {
          throw new Error("Gateway process exited before its session-end hook was signaled");
        }
        const exited = once(child, "exit") as Promise<
          [code: number | null, signal: NodeJS.Signals | null]
        >;
        expect(child.kill("SIGTERM")).toBe(true);

        await expect(exited).resolves.toEqual([0, null]);
        await expect(readTrace(tracePath)).resolves.toEqual(["started", "completed"]);
      } finally {
        await disconnectGatewayClient(client).catch(() => undefined);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
