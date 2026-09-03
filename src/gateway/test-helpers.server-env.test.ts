import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { listAgentIds } from "../agents/agent-scope.js";
import { type AgentsConfig, resetConfigRuntimeState } from "../config/config.js";
import { drainSystemEvents, enqueueSystemEvent } from "../infra/system-events.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { GatewayClient, GatewayClientRequestError } from "./client.js";
import { createGatewayConfigOverrides } from "./test-helpers.config-runtime.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  rpcReq,
  waitForSystemEvent,
  withGatewayServer,
  writeSessionStore,
} from "./test-helpers.server.js";

const envBeforeSuite = {
  PATH: process.env.PATH,
  OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
  OPENCLAW_PATH_BOOTSTRAPPED: process.env.OPENCLAW_PATH_BOOTSTRAPPED,
};

installGatewayTestHooks();

describe("Gateway test environment lifecycle", () => {
  it.each(["connect error", "start error"] as const)(
    "joins %s client cleanup before rejecting acquisition",
    async (failureMode) => {
      await withGatewayServer(async ({ port }) => {
        // oxlint-disable-next-line typescript/unbound-method -- Each call binds the acquired client.
        const { start, stopAndWait } = GatewayClient.prototype;
        const startError = new Error("client start failed after allocating its socket");
        let stopAcquiredClient: (() => Promise<void>) | undefined;
        let stopping: Promise<void> | undefined;
        let stopSettled = false;
        const startSpy = vi
          .spyOn(GatewayClient.prototype, "start")
          .mockImplementation(function (this: GatewayClient) {
            stopAcquiredClient = () => stopAndWait.call(this, { timeoutMs: 1_000 });
            start.call(this);
            if (failureMode === "start error") {
              throw startError;
            }
          });
        const stopSpy = vi
          .spyOn(GatewayClient.prototype, "stopAndWait")
          .mockImplementation(function (this: GatewayClient, options) {
            // Observe the actual client completion without holding its socket.
            stopping = stopAndWait.call(this, options).then(() => {
              stopSettled = true;
            });
            return stopping;
          });

        await runQaGatewayFixture(
          async () => {
            const failure: unknown = await connectGatewayClient({
              url: `ws://127.0.0.1:${port}`,
              token:
                failureMode === "connect error"
                  ? "wrong-gateway-token-1234567890"
                  : "test-gateway-token-1234567890",
            }).then(
              () => undefined,
              (error: unknown) => error,
            );
            if (failureMode === "connect error") {
              expect(failure).toBeInstanceOf(GatewayClientRequestError);
              expect(failure).toMatchObject({
                details: { code: "AUTH_TOKEN_MISMATCH" },
              });
            } else {
              expect(failure).toBe(startError);
            }
            expect(stopSpy).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 1_000 });
            expect(stopSettled).toBe(true);
          },
          async () => {
            // The pre-fix helper can reject without owning a stop at all.
            await stopAcquiredClient?.();
            await stopping;
          },
          () => stopSpy.mockRestore(),
          () => startSpy.mockRestore(),
        );
      });
    },
  );

  it("records the process-wide startup environment", async () => {
    await withGatewayServer(async ({ port }) => {
      expect(process.env.OPENCLAW_GATEWAY_PORT).toBe(String(port));
      expect(process.env.OPENCLAW_PATH_BOOTSTRAPPED).toBe("1");
    });
  });

  it("restores startup-owned environment before the next test", () => {
    expect({
      PATH: process.env.PATH,
      OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
      OPENCLAW_PATH_BOOTSTRAPPED: process.env.OPENCLAW_PATH_BOOTSTRAPPED,
    }).toEqual(envBeforeSuite);
  });

  it.each([
    { scope: "per-sender", sessionKey: "agent:ops:work" },
    { scope: "global", sessionKey: "global" },
  ])(
    "reads $scope system events from the fixture's configured owner",
    async ({ scope, sessionKey }) => {
      testState.agentsConfig = { ownership: "explicit", entries: { main: {}, ops: {} } };
      testState.agentConfig = { systemAgent: { agentId: "ops" } };
      testState.sessionConfig = { scope, mainKey: "work" };
      resetConfigRuntimeState();
      enqueueSystemEvent("fixture system event", { sessionKey });
      try {
        await expect(waitForSystemEvent()).resolves.toEqual(["fixture system event"]);
      } finally {
        drainSystemEvents(sessionKey);
      }
    },
  );

  it("keeps the fixture roster visible to real runtime readers while an RPC is pending", async () => {
    const actual = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
    await withGatewayServer(async ({ port }) => {
      const ws = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      try {
        for (const agentId of ["first", "second"]) {
          const workspace = path.join(process.env.OPENCLAW_STATE_DIR!, agentId);
          testState.agentsConfig = { ownership: "explicit", entries: { [agentId]: { workspace } } };
          const request = rpcReq(ws, "health");
          try {
            // A retained real-IO reader can run before the request is dispatched.
            // It must see this case's roster, not pin the suite's on-disk default.
            expect(actual.getRuntimeConfig().agents?.entries).toEqual({ [agentId]: { workspace } });
            expect((await request).ok).toBe(true);
          } finally {
            await request;
          }
        }
      } finally {
        ws.close();
      }
    });
  });

  it.each(["session store", "config mock"])(
    "keeps config readable while the %s fixture publishes an update",
    async (fixture) => {
      const actual = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
      const { writeConfigFile } = createGatewayConfigOverrides(actual);
      const agents: AgentsConfig = { ownership: "explicit", entries: { main: {}, authored: {} } };
      await writeConfigFile({ agents, session: { reset: { idleMinutes: 30 } } });
      testState.agentsConfig = { ownership: "explicit", entries: { main: {}, fixture: {} } };
      const configPath = process.env.OPENCLAW_CONFIG_PATH!;
      const readAuthoredConfig = () =>
        actual.loadConfig({ pin: false, skipPluginValidation: true, skipShellEnvFallback: true });
      const readIdleMinutes = () => readAuthoredConfig().session?.reset?.idleMinutes;
      expect(readIdleMinutes()).toBe(30);
      const writeFile = fs.writeFile.bind(fs);
      const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
        // Schedule the background reader after open: a direct path write has
        // already truncated the live config; a staged descriptor has not.
        const handle = file === configPath ? await fs.open(file, "w") : undefined;
        try {
          expect([30, 60]).toContain(readIdleMinutes());
          await writeFile(handle ?? file, data, options);
        } finally {
          await handle?.close();
        }
      });

      try {
        if (fixture === "session store") {
          testState.sessionStorePath = path.join(path.dirname(configPath), "sessions.json");
          testState.sessionConfig = { reset: { idleMinutes: 60 } };
          await writeSessionStore({ entries: {} });
        } else {
          await writeConfigFile({ agents, session: { reset: { idleMinutes: 60 } } });
        }
        expect(readIdleMinutes()).toBe(60);
        expect(listAgentIds(actual.getRuntimeConfig())).toEqual(["main", "fixture"]);
        expect(listAgentIds(readAuthoredConfig())).toEqual(["main", "authored"]);
      } finally {
        writeSpy.mockRestore();
      }
    },
  );

  it("restores startup-owned environment when a direct E2E server closes", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required");
    }
    setTestEnvValue("PATH", process.env.PATH ?? "");
    deleteTestEnvValue("OPENCLAW_PATH_BOOTSTRAPPED");
    const envBeforeServer = {
      PATH: process.env.PATH,
      OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
      OPENCLAW_PATH_BOOTSTRAPPED: process.env.OPENCLAW_PATH_BOOTSTRAPPED,
    };
    const token = "test-gateway-token-1234567890";
    for (const attempt of ["first", "second"]) {
      const started = await startGatewayWithClient({
        cfg: { gateway: { auth: { mode: "token", token } } },
        configPath: path.join(stateDir, "openclaw.json"),
        token,
      });

      try {
        expect(process.env.OPENCLAW_GATEWAY_PORT).toBe(String(started.port));
        expect(process.env.OPENCLAW_PATH_BOOTSTRAPPED).toBe("1");
      } finally {
        await disconnectGatewayClient(started.client).catch(() => undefined);
        await started.server.close({
          reason: `${attempt} direct E2E environment proof complete`,
        });
      }

      expect({
        PATH: process.env.PATH,
        OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
        OPENCLAW_PATH_BOOTSTRAPPED: process.env.OPENCLAW_PATH_BOOTSTRAPPED,
      }).toEqual(envBeforeServer);
    }
  });
});
