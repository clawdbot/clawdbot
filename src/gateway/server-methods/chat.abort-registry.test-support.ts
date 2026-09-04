/** Shared real SQLite/registry lifetime for cancellation boundary tests. */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { settleSubagentRegistryPersistenceWork } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import {
  resetSubagentRegistryForTests,
  testing,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { testing as schedulerTesting } from "../../agents/subagents/swarm/swarm-scheduler.test-support.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { LegacyContextEngine } from "../../context-engine/legacy.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-flow-registry.test-support.js";
import * as taskControlRuntime from "../../tasks/task-registry-control.runtime.js";
import {
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
  resetTaskRegistryControlRuntimeForTests,
} from "../../tasks/task-registry.test-support.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";

export function useChatAbortRegistryFixture() {
  const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
  let stateDir = "";
  beforeEach(async () => {
    stateDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-abort-errors-")));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    await writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: { defaults: { workspace: stateDir } },
        browser: { enabled: false },
      }),
    );
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    // Supply the real ESM owner through the existing CJS runtime seam.
    setTaskRegistryControlRuntimeForTests(taskControlRuntime);
    testing.setDepsForTest({
      // These cancellation fixtures own no browser sessions; browser cleanup has its own tests.
      cleanupBrowserSessionsForLifecycleEnd: async () => {},
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      resolveContextEngine: async () => new LegacyContextEngine(),
      callGateway: async ({ method }) => {
        if (method !== "agent.wait") {
          throw new Error(`Unexpected registry RPC ${method}`);
        }
        return await new Promise<never>(() => {});
      },
    });
  });
  afterEach(async () => {
    try {
      await settleSubagentRegistryPersistenceWork();
      resetSubagentRegistryForTests({ persist: false });
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      schedulerTesting.reset();
      resetTaskRegistryControlRuntimeForTests();
      await cleanupSessionStateForTest({ stateDir });
      testing.setDepsForTest();
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      await rm(stateDir, { recursive: true, force: true });
    } finally {
      env.restore();
    }
  });

  return {
    get stateDir() {
      return stateDir;
    },
  };
}
