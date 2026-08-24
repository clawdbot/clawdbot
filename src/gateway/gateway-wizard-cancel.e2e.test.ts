import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WizardStartResult } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
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
}

afterEach(() => {
  resetGatewayTestState();
});

describe("gateway wizard cancellation lifecycle", () => {
  it(
    "keeps a cancelled wizard owner until settlement before allowing a replacement",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const envSnapshot = captureEnv(ENV_KEYS);
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wizard-cancel-home-"));
      const stateDir = path.join(tempHome, ".openclaw");
      const bundledPluginsDir = path.join(tempHome, "empty-bundled-plugins");
      const token = `wizard-cancel-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}`;
      const runnerSettled = [createDeferred(), createDeferred()] as const;
      let runnerIndex = 0;

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
          wizardRunner: async (_opts, _runtime, prompter) => {
            const settlement = runnerSettled[runnerIndex++];
            if (!settlement) {
              throw new Error("wizard runner started more than twice");
            }
            prompter.progress("working");
            await settlement.promise;
          },
        });
        try {
          const client = await connectGatewayClient({
            url: `ws://127.0.0.1:${port}`,
            token,
            clientDisplayName: "vitest-wizard-cancel",
          });
          try {
            const start = await client.request<WizardStartResult>("wizard.start", {
              mode: "local",
            });
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
          } finally {
            await disconnectGatewayClient(client);
          }
        } finally {
          runnerSettled[0].resolve();
          runnerSettled[1].resolve();
          await server.close({ reason: "wizard cancellation lifecycle complete" });
        }
      } finally {
        runnerSettled[0].resolve();
        runnerSettled[1].resolve();
        try {
          await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        } finally {
          envSnapshot.restore();
        }
      }
    },
  );
});
