/** Real registry/SQLite lifetime shared by cancellation ownership regressions. */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../config/config.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { flushLogger, resetLogger } from "../../../logging/logger.js";
import { resetDetachedTaskLifecycleRuntimeForTests } from "../../../tasks/detached-task-runtime.test-support.js";
import { resetTaskFlowRegistryForTests } from "../../../tasks/task-flow-registry.test-support.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-registry.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { testing as schedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import { settleSubagentRegistryPersistenceWork } from "./subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests, testing } from "./subagent-registry.test-helpers.js";

export function useSubagentControlFixture() {
  const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
  let stateDir = "";
  const persist = vi.fn(persistSubagentRunsToDiskOrThrow);
  const gateway = vi.fn(async (request: { method: string }) => {
    if (request.method !== "agent.wait") {
      throw new Error(`Unexpected registry RPC ${request.method}`);
    }
    return await new Promise<never>(() => {});
  });
  beforeEach(async () => {
    stateDir = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "openclaw-ancestor-retirement-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    await writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { workspace: stateDir } } }),
    );
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    gateway.mockClear();
    persist.mockReset().mockImplementation(persistSubagentRunsToDiskOrThrow);
    testing.setDepsForTest({
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      resolveContextEngine: async () => new LegacyContextEngine(),
      callGateway: gateway,
      persistSubagentRunsToDiskOrThrow: persist,
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await settleSubagentRegistryPersistenceWork();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    schedulerTesting.reset();
    resetDetachedTaskLifecycleRuntimeForTests();
    await cleanupSessionStateForTest({ stateDir });
    testing.setDepsForTest();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await flushLogger();
    resetLogger();
    await rm(stateDir, { recursive: true, force: true });
    env.restore();
  });

  return {
    get stateDir() {
      return stateDir;
    },
    persist,
    gateway,
  };
}
