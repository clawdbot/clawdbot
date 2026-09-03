// Minimal-gateway boot smoke: guards the startup path the Control UI e2e suites
// depend on. Bundled plugins stay enabled on purpose — disabling them (as other
// gateway boot tests do) hides startup work that materializes plugin runtime,
// which is exactly how a startup stall shipped green while hanging every
// ui-e2e suite that boots a minimal test gateway.
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import { readLoggingConfig } from "../logging/config.js";
import { resetLogger } from "../logging/logger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";

// Local boot completes in ~10s; the budget only buys headroom for loaded CI
// runners. A stall exhausts it and fails in the gateway lane instead of first
// surfacing on unrelated UI PRs.
const BOOT_BUDGET_MS = 90_000;

afterEach(() => {
  resetLogger();
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
  clearPluginMetadataLifecycleCaches();
});

describe("gateway minimal boot smoke", () => {
  it("suppresses ambient channel triggers when the server option is omitted", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-bootstrap-ambient-default",
      layout: "home",
      env: {
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    const token = "gateway-bootstrap-test-token";
    await state.writeConfig({
      gateway: { auth: { mode: "token", token } },
      logging: { level: "debug" },
      plugins: {},
    });
    state.applyEnv();

    try {
      const { prepareGatewayServerBootstrap } = await import("./server-startup-bootstrap.js");
      const log = createSubsystemLogger("gateway/bootstrap-test");
      const bootstrap = await prepareGatewayServerBootstrap({
        port,
        opts: {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        },
        log,
        logSecrets: log,
        loadWorkerEnvironmentStartupModule: async () =>
          await import("./server-worker-environment-startup.js"),
        formatRuntimeGatewayAuthTokenWarning: () => "unused",
      });

      expect(bootstrap.ambientEnvTriggers).toBe("suppress");
      vi.stubEnv(
        "OPENCLAW_CONFIG_PATH",
        `/tmp/openclaw-bootstrap-missing-${process.pid}-${Date.now()}.json`,
      );
      expect(readLoggingConfig()).toMatchObject({ level: "debug" });
    } finally {
      await state.cleanup();
    }
  });

  it("boots a minimal test gateway within budget", { timeout: BOOT_BUDGET_MS }, async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-minimal-boot-smoke",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    const token = "gateway-minimal-boot-smoke-token";
    const timelinePath = state.path("gateway-startup.jsonl");
    state.envVars.OPENCLAW_DIAGNOSTICS = "1";
    state.envVars.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = timelinePath;
    await state.writeConfig({
      gateway: {
        auth: { mode: "token", token },
        controlUi: { enabled: false },
        port,
      },
    });
    state.applyEnv();
    try {
      const { startGatewayServer } = await import("./server.js");
      const server = await startGatewayServer(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      expect(server).toBeTruthy();
      const startupMeasures = (await fs.readFile(timelinePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.type === "span.start" && event.phase === "startup")
        .map((event) => {
          const attributes = event.attributes as { traceName?: string } | undefined;
          return attributes?.traceName ?? event.name;
        });
      expect(startupMeasures.indexOf("http.listen")).toBeGreaterThan(-1);
      expect(startupMeasures.indexOf("runtime.early")).toBeGreaterThan(
        startupMeasures.indexOf("http.listen"),
      );
      await server.close({ reason: "minimal boot smoke complete" });
    } finally {
      await state.cleanup();
    }
  });

  it(
    "bounds restored requester-settle wakes through Gateway startup",
    { timeout: BOOT_BUDGET_MS },
    async () => {
      const port = await getFreePort();
      const state = await createOpenClawTestState({
        label: "gateway-restored-requester-settle",
        layout: "home",
        env: {
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          VITEST: "1",
        },
      });
      const token = "gateway-restored-requester-settle-token";
      await state.writeConfig({
        gateway: {
          auth: { mode: "token", token },
          controlUi: { enabled: false },
          port,
        },
        plugins: { enabled: false },
      });
      state.applyEnv();

      let activeWakes = 0;
      let maxActiveWakes = 0;
      const wakeResolvers: Array<() => void> = [];
      const wakeRequester = vi.fn(
        (params: {
          settledEntry: { runId: string };
          completeBatch(runIds: readonly string[]): void;
        }) =>
          new Promise<boolean>((resolve) => {
            activeWakes += 1;
            maxActiveWakes = Math.max(maxActiveWakes, activeWakes);
            wakeResolvers.push(() => {
              params.completeBatch([params.settledEntry.runId]);
              activeWakes -= 1;
              resolve(false);
            });
          }),
      );
      subagentRegistryTesting.setDepsForTest({
        maybeWakeRequesterAfterAllChildrenSettled: wakeRequester,
      });
      const endedAt = Date.now();
      const restoredRuns = Array.from(
        { length: 3 },
        (_, index): SubagentRunRecord => ({
          runId: `run-gateway-restored-wake-${index}`,
          childSessionKey: `agent:main:subagent:gateway-restored-wake-${index}`,
          requesterSessionKey: `agent:main:gateway-requester-${index}`,
          requesterDisplayKey: `gateway-requester-${index}`,
          task: "resume a durable requester wake through Gateway startup",
          cleanup: "keep",
          createdAt: endedAt - 1_000,
          endedReason: "subagent-complete",
          execution: {
            status: "terminal",
            startedAt: endedAt - 500,
            endedAt,
            outcome: { status: "ok" },
          },
          expectsCompletionMessage: true,
          completion: { required: true, resultText: "done", capturedAt: endedAt },
          delivery: { status: "delivered", deliveredAt: endedAt },
          cleanupHandled: true,
          cleanupCompletedAt: endedAt,
          requesterSettleWake: { status: "pending", attemptCount: 0 },
        }),
      );
      saveSubagentRegistryToSqlite(
        new Map(restoredRuns.map((entry) => [entry.runId, entry] as const)),
      );

      let server:
        | Awaited<ReturnType<(typeof import("./server.js"))["startGatewayServer"]>>
        | undefined;
      try {
        const { startGatewayServer } = await import("./server.js");
        server = await startGatewayServer(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });

        await vi.waitFor(() => expect(wakeRequester).toHaveBeenCalledTimes(2));
        expect(activeWakes).toBe(2);
        expect(maxActiveWakes).toBe(2);

        wakeResolvers.shift()?.();
        await vi.waitFor(() => expect(wakeRequester).toHaveBeenCalledTimes(3));
        expect(maxActiveWakes).toBe(2);
      } finally {
        while (wakeResolvers.length > 0) {
          wakeResolvers.shift()?.();
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
        await vi.waitFor(() => expect(activeWakes).toBe(0));
        await server?.close({ reason: "restored requester settle proof complete" });
        resetSubagentRegistryForTests({ persist: false });
        subagentRegistryTesting.setDepsForTest();
        closeOpenClawStateDatabaseForTest();
        await state.cleanup();
      }
    },
  );
});
