// Shared real-registry and SQLite fixture for restart ownership integration tests.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
} from "../../../config/sessions.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  consumeSessionWorkAdmissionHandoff,
  type SessionWorkAdmissionLease,
} from "../../../sessions/session-lifecycle-admission.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../../tasks/task-runtime.test-helpers.js";
import { captureEnv } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import {
  createCanonicalSubagentRunFixture,
  createSubagentRegistryTestDeps,
} from "./subagent-registry.persistence.test-support.js";
import {
  activateSubagentRegistry,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function makeRestartRecoveryRun(
  overrides: Partial<SubagentRunRecordOverrides>,
): SubagentRunRecord {
  return createCanonicalSubagentRunFixture(
    createSubagentRunRecord({
      runId: "run",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "restart-recoverable work",
      cleanup: "keep",
      createdAt: Date.now(),
      startedAt: Date.now(),
      ...overrides,
    }),
  );
}

export function useSubagentRestartRecoveryFixture() {
  function consumeRecoveryAdmission(payload: Record<string, unknown>): SessionWorkAdmissionLease {
    const sessionKey = String(payload.sessionKey);
    const sessionId = String(payload.expectedExistingSessionId);
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const scope = resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId });
    const admission = consumeSessionWorkAdmissionHandoff({
      handoffId: String(payload.internalRuntimeHandoffId),
      scope,
      identities: [sessionKey, sessionId],
      onInterrupt: () => undefined,
    });
    if (!admission) {
      throw new Error("expected recovery dispatch to consume its session admission handoff");
    }
    return admission;
  }

  async function acceptRecoveryDispatch(payload: Record<string, unknown>) {
    consumeRecoveryAdmission(payload).release();
    return {
      runId: String(payload.idempotencyKey),
      status: "accepted",
    };
  }

  const dispatchAgent = vi.fn(acceptRecoveryDispatch);
  const gatewayRuntime: GatewayRecoveryRuntime = {
    dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
    waitForAgent: vi.fn(async () => ({
      status: "pending",
    })) as GatewayRecoveryRuntime["waitForAgent"],
    sendRecoveryNotice: vi.fn(),
  };
  const activateGatewayRuntime = () => {
    const gatewayContext = {
      recoveryRuntime: gatewayRuntime,
      resolveGatewayContext: () => gatewayContext as never,
    };
    bindGatewayContextResolver(gatewayRuntime, gatewayContext.resolveGatewayContext);
    activateSubagentRegistry(gatewayContext.resolveGatewayContext);
  };

  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;

  beforeEach(async () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-orphan-integ-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    setRuntimeConfigSnapshot({ session: { store: undefined } } as never);
    // Real registry wiring: only the delivery/announce/cleanup seams (true
    // external side effects) are recorded so completeSubagentRun runs in-process.
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
      onAgentEvent: vi.fn(() => () => undefined),
    });
    activateGatewayRuntime();
    dispatchAgent.mockReset();
    dispatchAgent.mockImplementation(acceptRecoveryDispatch);
  });

  afterEach(async () => {
    testing.setDepsForTest();
    resetSubagentRegistryForTests({ persist: false });
    await cleanupSessionStateForTest();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
    envSnapshot.restore();
  });

  return {
    acceptRecoveryDispatch,
    activateGatewayRuntime,
    dispatchAgent,
    gatewayRuntime,
    get stateDir(): string {
      if (!tempStateDir) {
        throw new Error("Restart recovery fixture has not initialized its state directory");
      }
      return tempStateDir;
    },
  };
}
