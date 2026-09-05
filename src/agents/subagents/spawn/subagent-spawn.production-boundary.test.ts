/** Recursive spawn authority must survive the real Gateway and agent-command admission path. */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { readAgentRuntimeExecutionLineage } from "../../../gateway/agent-runtime-execution-lineage.js";
import {
  createAgentRuntimeApprovalAuthorityValidator,
  type AgentRuntimeIdentity,
} from "../../../gateway/agent-runtime-identity-token.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import { createRequestGatewayMethodRegistry } from "../../../gateway/server-methods.js";
import { createChatAbortContext } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { resetTaskFlowRegistryForTests } from "../../../tasks/task-flow-registry.test-support.js";
import * as taskControlRuntime from "../../../tasks/task-registry-control.runtime.js";
import {
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
} from "../../../tasks/task-registry.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import type { EmbeddedAgentRunResult } from "../../embedded-agent.js";
import { refreshPreparedModelRuntimeSnapshots } from "../../prepared-model-runtime.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../registry/subagent-registry.persistence.test-support.js";
import {
  resetSubagentRegistryForTests,
  testing as registryTesting,
} from "../registry/subagent-registry.test-helpers.js";

const runEmbeddedAgent = vi.hoisted(() => vi.fn());

vi.mock("../../embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../embedded-agent.js")>()),
  runEmbeddedAgent,
}));

const parentSessionKey = "agent:main:subagent:production-boundary-parent";
const parentRunId = "production-boundary-parent";
const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir = "";

type PreparedRuntimeTestApi = {
  resetPreparedModelRuntimeSnapshotsForTest(): void;
};

function resetPreparedRuntime() {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.preparedModelRuntimeTestApi")
  ] as PreparedRuntimeTestApi | undefined;
  api?.resetPreparedModelRuntimeSnapshotsForTest();
}

async function waitForStage<T>(label: string, task: Promise<T>, timeoutMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out during ${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function writeTestConfig() {
  await writeFile(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({
      logging: { audit: { enabled: true, executionIdentity: true } },
      agents: {
        ownership: "explicit",
        defaults: {
          workspace: stateDir,
          systemAgent: { agentId: "main" },
        },
        entries: { main: { workspace: stateDir } },
      },
    }),
  );
  clearConfigCache();
  clearRuntimeConfigSnapshot();
}

beforeEach(async () => {
  resetPreparedRuntime();
  runEmbeddedAgent.mockReset();
  stateDir = tempDirs.make("openclaw-spawn-production-boundary-");
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  await writeTestConfig();
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  setTaskRegistryControlRuntimeForTests(taskControlRuntime);
  registryTesting.setDepsForTest({
    loadAgentRuntimePluginRegistryHandle: () => undefined,
    callGateway: async (request) => {
      if (request.method !== "agent.wait") {
        throw new Error(`Unexpected registry RPC ${request.method}`);
      }
      return await new Promise<never>(() => {});
    },
  });
});

afterEach(async () => {
  await settleSubagentRegistryPersistenceWork();
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetTaskRegistryControlRuntimeForTests();
  registryTesting.setDepsForTest();
  resetPreparedRuntime();
  await cleanupSessionStateForTest({ stateDir });
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  env.restore();
});

async function createBoundParent() {
  const cfg = getRuntimeConfig();
  const storePath = await writeSubagentSessionEntry({
    stateDir,
    agentId: "main",
    sessionKey: parentSessionKey,
    defaultSessionId: "parent-session",
  });
  const context = createChatAbortContext({
    getRuntimeConfig: () => cfg,
    getSessionEventSubscriberConnIds: () => new Set(),
    broadcastToConnIds: vi.fn(),
  });
  const admission = prepareAgentRunAdmission({
    cfg,
    operationalRunInstance: createOperationalRunInstanceRef(parentRunId),
    facts: {
      runId: parentRunId,
      agentId: "main",
      ingress: { kind: "system", boundary: "spawn-production-boundary-test", state: "present" },
    },
  });
  const parent = registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId: parentRunId,
    sessionKey: parentSessionKey,
    sessionId: "parent-session",
    agentId: "main",
    ownerConnId: "owner-connection",
    timeoutMs: 60_000,
    operationalRunInstance: admission.operationalRunInstance,
  });
  const admitted = await admission.admit("embedded");
  bindGatewayContextResolver(admitted, () => context as unknown as GatewayRequestContext);
  const authority = getAdmittedRunDelegatedAuthority(admitted)!;
  parent.bindAgentRunDelegatedAuthority(authority);
  return { cfg, storePath, context, admission, parent, admitted };
}

function createBoundSpawnInvocation(bound: Awaited<ReturnType<typeof createBoundParent>>) {
  const source = createSessionsSpawnTool({
    config: bound.cfg,
    agentSessionKey: parentSessionKey,
    requesterRunId: parentRunId,
    requesterTurnRunId: parentRunId,
  });
  const caller = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: bound.admitted,
    agentId: "main",
    sessionKey: parentSessionKey,
  });
  return () =>
    withPluginRuntimeGatewayRequestScope(
      {
        context: bound.context as unknown as GatewayRequestContext,
        isWebchatConnect: () => false,
      },
      () =>
        withGatewayToolCallerIdentity(caller, () =>
          source.execute!("spawn-production-boundary", { task: "bounded child" }),
        ),
    );
}

describe("recursive spawn production boundary", () => {
  it("authorizes and admits an upgraded descendant before model execution", async () => {
    const bound = await createBoundParent();
    await waitForStage(
      "prepared model runtime publication",
      refreshPreparedModelRuntimeSnapshots(bound.cfg, {
        gatewayLifecycle: true,
        catalogMode: "static",
        defaultWorkspaceDir: stateDir,
      }),
    );
    const context = bound.context as unknown as GatewayRequestContext;
    const validateRuntimeAuthority = createAgentRuntimeApprovalAuthorityValidator();
    let observedRuntimeIdentity: AgentRuntimeIdentity | undefined;
    context.validateAgentRuntimeApprovalAuthority = (identity) => {
      observedRuntimeIdentity = identity;
      return validateRuntimeAuthority(identity);
    };
    const methodRegistry = createRequestGatewayMethodRegistry();
    const runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () => methodRegistry,
      isDispatchAvailable: () => true,
    });
    context.createAgentTurnFacade = runtime.createAgentTurnFacade;
    context.getGatewayMethodRegistry = () => methodRegistry;
    const modelRun = createDeferred<EmbeddedAgentRunResult>();
    runEmbeddedAgent.mockReturnValueOnce(modelRun.promise);
    let childRunId: string | undefined;
    try {
      const result = await waitForStage(
        "production spawn acceptance",
        createBoundSpawnInvocation(bound)(),
      );
      expect(result).toMatchObject({
        details: {
          status: "accepted",
          childSessionKey: expect.any(String),
          runId: expect.any(String),
        },
      });
      const details = result.details as { childSessionKey: string; runId: string };
      childRunId = details.runId;
      await vi.waitFor(() => expect(runEmbeddedAgent).toHaveBeenCalledOnce(), { timeout: 15_000 });
      const embeddedRun = runEmbeddedAgent.mock.calls[0]?.[0];
      expect(embeddedRun).toMatchObject({
        runId: details.runId,
        sessionKey: details.childSessionKey,
      });
      expect(context.chatAbortControllers.get(details.runId)).toMatchObject({
        agentId: "main",
        sessionKey: details.childSessionKey,
        operationalRunInstance: { runId: details.runId },
      });
      expect(observedRuntimeIdentity).toMatchObject({
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: parentSessionKey,
      });
      expect(
        readAgentRuntimeExecutionLineage(observedRuntimeIdentity?.sessionSpawnContext),
      ).toMatchObject({
        relation: "sessions_spawn",
        requesterRef: parentSessionKey,
        controllerRef: parentSessionKey,
        depth: 2,
        applicableGrantRefs: ["tool:sessions_spawn"],
        runtimeAssuranceRefs: ["spawn-runtime:subagent"],
      });
      expect(
        loadSessionEntry({ storePath: bound.storePath, sessionKey: details.childSessionKey }),
      ).toMatchObject({
        spawnedBy: parentSessionKey,
        spawnDepth: 2,
      });
      expect(subagentRuns.get(details.runId)).toMatchObject({
        childSessionKey: details.childSessionKey,
        requesterSessionKey: parentSessionKey,
        execution: { status: "running" },
      });
    } finally {
      modelRun.resolve({
        payloads: [{ text: "descendant complete" }],
        meta: { durationMs: 1 },
      });
      if (childRunId) {
        await vi.waitFor(
          () =>
            expect(subagentRuns.get(childRunId!)).toMatchObject({
              execution: { status: "terminal" },
              cleanupCompletedAt: expect.any(Number),
            }),
          { timeout: 15_000 },
        );
        await vi.waitFor(() => expect(context.chatAbortControllers.has(childRunId!)).toBe(false), {
          timeout: 15_000,
        });
      }
      runtime.close();
      bound.admission.close();
      bound.parent.cleanup();
    }
  });
});
