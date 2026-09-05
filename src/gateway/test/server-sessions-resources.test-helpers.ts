import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { gatewayFixtureLifetime } from "../gateway-fixture-lifetime.test-support.js";
import type { GatewayServerHarness } from "../server.e2e-ws-harness.js";
import { installGatewayTestHooks } from "../test-helpers.server.js";

const getGatewayServerHarnessModule = createLazyRuntimeModule(
  () => import("../server.e2e-ws-harness.js"),
);

export type GatewaySessionsSuiteSetup = (makeTempDir: (prefix: string) => string) => Promise<void>;

export function installGatewaySessionsTestResources(
  startServer: boolean,
  setup?: GatewaySessionsSuiteSetup,
) {
  const tempDirs = createTempDirTracker();
  const defaultAgentWorkspace = path.join(os.tmpdir(), "openclaw-gateway-test");
  let harness: GatewayServerHarness | undefined;
  let sharedSessionStoreDir: string | undefined;

  installGatewayTestHooks({
    scope: "suite",
    setup: async () => {
      await fs.mkdir(defaultAgentWorkspace, { recursive: true });
      if (startServer) {
        const { startGatewayServerHarness } = await getGatewayServerHarnessModule();
        harness = await startGatewayServerHarness();
      }
      sharedSessionStoreDir = tempDirs.make("openclaw-sessions-");
      await setup?.((prefix) => tempDirs.make(prefix));
    },
    cleanup: () =>
      runQaGatewayFixture(
        async () => {
          await harness?.close();
        },
        () => {
          if (harness && !gatewayFixtureLifetime.canReleaseState(harness.server)) {
            return;
          }
          for (const dir of tempDirs.dirs) {
            closeOpenClawAgentDatabasesForTest(dir);
          }
          tempDirs.cleanup();
          sharedSessionStoreDir = undefined;
          harness = undefined;
        },
      ),
  });

  const requireHarness = () => {
    if (!harness) {
      throw new Error("Gateway sessions test harness was not started");
    }
    return harness;
  };
  const requireSharedSessionStoreDir = () => {
    if (!sharedSessionStoreDir) {
      throw new Error("Gateway sessions shared session store dir was not created");
    }
    return sharedSessionStoreDir;
  };
  return { defaultAgentWorkspace, requireHarness, requireSharedSessionStoreDir };
}
