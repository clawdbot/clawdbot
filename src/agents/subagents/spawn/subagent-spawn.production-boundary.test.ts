/** Recursive spawn authority must survive the real Gateway and agent-command admission path. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { AgentRuntimeIdentity } from "../../../gateway/agent-runtime-identity-token.js";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { createChatAbortContext } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { trackAsyncWork } from "../../../shared/async-work-scope.js";
import { resetTaskFlowRegistryForTests } from "../../../tasks/task-flow-registry.test-support.js";
import * as taskControlRuntime from "../../../tasks/task-registry-control.runtime.js";
import {
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
} from "../../../tasks/task-registry.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import type { EmbeddedAgentRunResult } from "../../embedded-agent.js";
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "../../prepared-model-runtime.test-harness.js";
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
let state: OpenClawTestState;
let stateDir = "";
let runtimeConfig: OpenClawConfig;

async function writeTestConfig() {
  const config = {
    logging: { audit: { enabled: true, executionIdentity: true } },
    agents: {
      ownership: "explicit",
      defaults: {
        workspace: stateDir,
        systemAgent: { agentId: "main" },
        model: { primary: "custom/test-model" },
      },
      entries: { main: { workspace: stateDir } },
    },
    models: {
      providers: {
        custom: {
          api: "openai-completions",
          baseUrl: "https://example.invalid/v1",
          models: [
            {
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              id: "test-model",
              input: ["text"],
              maxTokens: 1_024,
              name: "Test model",
              reasoning: false,
            },
          ],
        },
      },
    },
  } satisfies OpenClawConfig;
  await state.writeConfig(config);
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  return config;
}

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "spawn-production-boundary" });
  await resetPreparedModelRuntimeHarness(state);
  runEmbeddedAgent.mockReset();
  stateDir = state.stateDir;
  runtimeConfig = await writeTestConfig();
  const preparedRuntime = getPreparedModelRuntimeMocks();
  const model = {
    api: "openai-completions" as const,
    baseUrl: "https://example.invalid/v1",
    contextWindow: 4_096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    id: "test-model",
    input: ["text" as const],
    maxTokens: 1_024,
    name: "Test model",
    provider: "custom",
    reasoning: false,
  };
  preparedRuntime.configuredAgentIds = ["main"];
  preparedRuntime.configuredAgentDirs.set("main", state.agentDir("main"));
  preparedRuntime.configuredWorkspaces.set("main", stateDir);
  preparedRuntime.buildPreparedModelCatalogSnapshot.mockResolvedValue({
    entries: [model],
    routeVariants: [model],
  });
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  setTaskRegistryControlRuntimeForTests(taskControlRuntime);
  registryTesting.setDepsForTest({
    loadAgentRuntimePluginRegistryHandle: () => undefined,
    runSubagentAnnounceFlow: async () => "delivered",
    callGateway: async <T>(request: CallGatewayOptions): Promise<T> => {
      if (request.method !== "agent.wait") {
        throw new Error(`Unexpected registry RPC ${request.method}`);
      }
      return { status: "pending" } as T;
    },
  });
});

afterEach(async ({ task }) => {
  await settleSubagentRegistryPersistenceWork();
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetTaskRegistryControlRuntimeForTests();
  registryTesting.setDepsForTest();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

async function createBoundParent() {
  const cfg = runtimeConfig;
  const storePath = await writeSubagentSessionEntry({
    stateDir,
    agentId: "main",
    sessionKey: parentSessionKey,
    defaultSessionId: "parent-session",
  });
  const context = createChatAbortContext({
    trackExecution: trackAsyncWork,
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
    const [
      { readAgentRuntimeExecutionLineage },
      { createAgentRuntimeApprovalAuthorityValidator },
      { createGatewayInstanceRuntime },
      { createRequestGatewayMethodRegistry },
      { refreshPreparedModelRuntimeSnapshots },
    ] = await Promise.all([
      import("../../../gateway/agent-runtime-execution-lineage.js"),
      import("../../../gateway/agent-runtime-identity-token.js"),
      import("../../../gateway/server-instance-runtime.js"),
      import("../../../gateway/server-methods.js"),
      import("../../prepared-model-runtime.js"),
    ]);
    await refreshPreparedModelRuntimeSnapshots(bound.cfg, {
      gatewayLifecycle: true,
      catalogMode: "static",
      defaultWorkspaceDir: stateDir,
    });
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
      const result = await createBoundSpawnInvocation(bound)();
      expect(result.details, JSON.stringify(result)).toMatchObject({
        status: "accepted",
        childSessionKey: expect.any(String),
        runId: expect.any(String),
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
      });
    } finally {
      modelRun.resolve({
        payloads: [{ text: "descendant complete" }],
        meta: { durationMs: 1 },
      });
      if (childRunId) {
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
