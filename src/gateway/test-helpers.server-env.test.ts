import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";
import { drainSystemEvents, enqueueSystemEvent } from "../infra/system-events.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { createGatewayConfigModuleMock } from "./test-helpers.config-runtime.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  installGatewayTestHooks,
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

  it.each(["session store", "config mock"])(
    "keeps config readable while the %s fixture publishes an update",
    async (fixture) => {
      const actual =
        await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
      const { writeConfigFile } = createGatewayConfigModuleMock(actual);
      await writeConfigFile({ session: { reset: { idleMinutes: 30 } } });
      const configPath = process.env.OPENCLAW_CONFIG_PATH!;
      const readIdleMinutes = () =>
        actual.loadConfig({ pin: false, skipPluginValidation: true, skipShellEnvFallback: true })
          .session?.reset?.idleMinutes;
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
          await writeConfigFile({ session: { reset: { idleMinutes: 60 } } });
        }
        expect(readIdleMinutes()).toBe(60);
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
