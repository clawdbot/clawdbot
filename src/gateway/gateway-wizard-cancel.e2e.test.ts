import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WizardStartResult } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import {
  enqueueCommandInLane,
  getTotalQueueSize,
  markGatewayDraining,
} from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import type { SetupWizardRunner } from "./server-methods/wizard.js";
import { startGatewayServer } from "./server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
} from "./test-helpers.e2e.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "./test-helpers.env.js";

const GATEWAY_E2E_TIMEOUT_MS = 90_000;
const ENV_KEYS = [
  "HOME",
  ...GATEWAY_STARTUP_MUTATED_ENV_KEYS,
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
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
];

function resetGatewayTestState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest();
  resetCommandQueueStateForTest();
  resetGatewayWorkAdmission();
}

afterEach(() => {
  resetGatewayTestState();
});

async function withWizardGateway(
  wizardRunner: SetupWizardRunner,
  releaseRunner: () => void,
  run: (fixture: {
    server: Awaited<ReturnType<typeof startGatewayServer>>;
    connect: () => ReturnType<typeof connectGatewayClient>;
  }) => Promise<void>,
): Promise<void> {
  const envSnapshot = captureEnv(ENV_KEYS);
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wizard-cancel-home-"));
  const stateDir = path.join(tempHome, ".openclaw");
  const bundledPluginsDir = path.join(tempHome, "empty-bundled-plugins");
  const token = `wizard-cancel-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}`;
  const clients: Array<Awaited<ReturnType<typeof connectGatewayClient>>> = [];
  try {
    await fs.mkdir(bundledPluginsDir, { recursive: true });
    setTestEnvValue("HOME", tempHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
    setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
    setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
    setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
    setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
    setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
    setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
    setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledPluginsDir);
    setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", "1");
    const port = await getGatewayE2ePortBlock();
    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
      wizardRunner,
    });
    try {
      await run({
        server,
        connect: async () => {
          const client = await connectGatewayClient({
            url: `ws://127.0.0.1:${port}`,
            token,
            clientDisplayName: "vitest-wizard-cancel",
          });
          clients.push(client);
          return client;
        },
      });
    } finally {
      releaseRunner();
      await Promise.all(clients.map(disconnectGatewayClient));
      await server.close({ reason: "wizard cancellation lifecycle complete" });
    }
  } finally {
    releaseRunner();
    try {
      await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } finally {
      envSnapshot.restore();
    }
  }
}

describe("gateway wizard cancellation lifecycle", () => {
  it(
    "keeps a cancelled wizard owner until settlement before allowing a replacement",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const runnerSettled = [createDeferred(), createDeferred()] as const;
      let runnerIndex = 0;
      await withWizardGateway(
        async (_opts, _runtime, prompter) => {
          const settlement = runnerSettled[runnerIndex++];
          if (!settlement) {
            throw new Error("wizard runner started more than twice");
          }
          prompter.progress("working");
          await settlement.promise;
        },
        () => {
          runnerSettled[0].resolve();
          runnerSettled[1].resolve();
        },
        async ({ connect }) => {
          const client = await connect();
          const start = await client.request<WizardStartResult>("wizard.start", { mode: "local" });
          expect(start).toMatchObject({ done: false, status: "running" });
          await expect(
            client.request("wizard.cancel", { sessionId: start.sessionId }),
          ).resolves.toMatchObject({ status: "cancelled" });
          await expect(client.request("wizard.start", { mode: "local" })).rejects.toMatchObject({
            code: "UNAVAILABLE",
          });
          runnerSettled[0].resolve();
          let replacement: WizardStartResult | undefined;
          await expect
            .poll(
              async () => {
                try {
                  replacement = await client.request<WizardStartResult>("wizard.start", {
                    mode: "local",
                  });
                  return replacement.status;
                } catch {
                  return "blocked";
                }
              },
              { timeout: 5_000 },
            )
            .toBe("running");
          if (!replacement) {
            throw new Error("replacement wizard did not start");
          }
          expect(replacement).toMatchObject({ done: false, status: "running" });
          await expect(client.request("health", {})).resolves.toBeDefined();
          await expect(
            client.request("wizard.cancel", { sessionId: replacement.sessionId }),
          ).resolves.toMatchObject({ status: "cancelled" });
          runnerSettled[1].resolve();
        },
      );
    },
  );

  it.each(["process drain", "server close"])(
    "retires an abandoned reconnectable wizard before %s joins its cleanup",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async (closing) => {
      const cleanupStarted = createDeferred();
      const releaseCleanup = createDeferred();
      const fixtureStop = new AbortController();
      let submitted = false;
      let closed = false;
      let closingServer: Promise<void> | undefined;
      await withWizardGateway(
        async (_opts, _runtime, prompter) => {
          await enqueueCommandInLane("wizard-shutdown-e2e", async () => {
            try {
              await prompter.text({ message: "Local model base URL", signal: fixtureStop.signal });
              submitted = true;
            } finally {
              cleanupStarted.resolve();
              await releaseCleanup.promise;
            }
          });
        },
        () => {
          fixtureStop.abort();
          releaseCleanup.resolve();
        },
        async ({ connect, server }) => {
          const first = await connect();
          const start = await first.request<WizardStartResult>("wizard.start", { mode: "local" });
          expect(start.step?.type).toBe("text");
          await disconnectGatewayClient(first);
          expect(getActiveGatewayRootWorkCount()).toBe(1);
          const reconnected = await connect();
          await expect(
            reconnected.request("wizard.next", { sessionId: start.sessionId }),
          ).resolves.toMatchObject({
            done: false,
            status: "running",
            step: { id: start.step?.id },
          });
          await disconnectGatewayClient(reconnected);
          expect(getTotalQueueSize()).toBe(1);
          if (closing === "process drain") {
            markGatewayDraining();
          } else {
            closingServer = server.close({ reason: "abandoned wizard proof" }).then(() => {
              closed = true;
            });
          }
          await withTestTimeout(
            cleanupStarted.promise,
            1_000,
            "shutdown did not retire the abandoned prompt",
          );
          expect(submitted).toBe(false);
          expect(closed).toBe(false);
          expect(getActiveGatewayRootWorkCount()).toBe(1);
          expect(getTotalQueueSize()).toBe(1);
          releaseCleanup.resolve();
          expect((await waitForGatewayActiveWork(5_000)).drained).toBe(true);
          expect(getActiveGatewayRootWorkCount()).toBe(0);
          expect(getTotalQueueSize()).toBe(0);
          await closingServer;
        },
      );
    },
  );
});
