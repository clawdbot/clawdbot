// Webhooks TaskFlow E2E covers route-bound child cancellation on a real Gateway listener.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/core";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import acpxPlugin from "../../../../extensions/acpx/index.js";
import webhooksPlugin from "../../../../extensions/webhooks/index.js";
import {
  getAcpSessionManager,
  testing as acpManagerTesting,
} from "../../../../src/acp/control-plane/manager.js";
import { createTestAdmittedRunContext } from "../../../../src/agents/admitted-run-context.test-support.js";
import { cancelBackgroundExecSession } from "../../../../src/agents/bash-process-control.js";
import { killSubagentRunAdmin } from "../../../../src/agents/subagents/registry/subagent-control.js";
import { getSubagentRunByRunId } from "../../../../src/agents/subagents/registry/subagent-registry.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../../../../src/agents/subagents/registry/subagent-registry.test-helpers.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import { resolveSessionStorePathCore } from "../../../../src/config/sessions/paths.js";
import { replaceSessionEntrySync } from "../../../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { cancelActiveCronTaskRun } from "../../../../src/cron/service/active-run-cancellation.js";
import { startGatewayServer } from "../../../../src/gateway/server.js";
import { getGatewayE2ePortBlock } from "../../../../src/gateway/test-helpers.e2e.js";
import { snapshotGatewayStartupEnv } from "../../../../src/gateway/test-helpers.env.js";
import { registerPluginHttpRoute } from "../../../../src/plugins/http-registry.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "../../../../src/plugins/runtime.js";
import { createPluginRuntime } from "../../../../src/plugins/runtime/index.js";
import { createSubagentTaskBackingDetail } from "../../../../src/tasks/task-backing-authority.js";
import { createAcpTaskBackingDetailForTest } from "../../../../src/tasks/task-backing-authority.test-support.js";
import { createRunningTaskRunCore } from "../../../../src/tasks/task-executor.js";
import { getTaskFlowById } from "../../../../src/tasks/task-flow-registry.js";
import { findTaskByRunId, listTasksForFlowId } from "../../../../src/tasks/task-registry.js";
import {
  resetTaskFlowRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
  resetTaskRegistryForTests,
} from "../../../../src/tasks/task-runtime.test-helpers.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { createDeferred } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const TOKEN = "webhooks-taskflow-e2e-token";
const SECRET = "webhooks-taskflow-route-secret";
const ROUTE_PATH = "/plugins/webhooks/authority-proof";
const ROUTE_OWNER = "agent:main:webhook-authority-proof";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type WebhookResponse = {
  status: number;
  body: {
    ok?: boolean;
    code?: string;
    error?: string;
    result?: {
      flow?: { flowId?: string; status?: string };
      tasks?: Array<{ status?: string }>;
    };
  };
};

beforeEach(() => {
  subagentRegistryTesting.setDepsForTest({
    persistSubagentRunsToDisk: () => {},
    persistSubagentRunsToDiskOrThrow: () => {},
    restoreSubagentRunsFromDisk: () => 0,
  });
});

afterEach(() => {
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  acpManagerTesting.resetAcpSessionManagerForTests();
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetPluginStateStoreForTests();
  resetPluginRuntimeStateForTest();
  subagentRegistryTesting.setDepsForTest();
});

function registerRunningSubagent(params: {
  runId: string;
  childSessionKey: string;
  ownerKey: string;
}) {
  const startedAt = Date.now();
  const generation = (getSubagentRunByRunId(params.runId)?.generation ?? 0) + 1;
  addSubagentRunForTests({
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    controllerSessionKey: params.ownerKey,
    requesterSessionKey: params.ownerKey,
    requesterDisplayKey: params.ownerKey,
    task: `Running child ${params.runId}`,
    cleanup: "keep",
    generation,
    createdAt: startedAt,
    startedAt,
  });
  const task = createRunningTaskRunCore({
    runtime: "subagent",
    ownerKey: params.ownerKey,
    scopeKind: "session",
    childSessionKey: params.childSessionKey,
    runId: params.runId,
    task: `Running child ${params.runId}`,
    startedAt,
    deliveryStatus: "pending",
    detail: createSubagentTaskBackingDetail(generation),
  });
  if (!task) {
    throw new Error(`failed to create canonical task for ${params.runId}`);
  }
  return { generation, task };
}

async function postWebhook(
  origin: string,
  body: Record<string, unknown>,
): Promise<WebhookResponse> {
  const response = await fetch(`${origin}${ROUTE_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-webhook-secret": SECRET,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as WebhookResponse["body"],
  };
}

async function createFlow(origin: string, goal: string): Promise<string> {
  const response = await postWebhook(origin, { action: "create_flow", goal });
  expect(response).toMatchObject({ status: 200, body: { ok: true } });
  const flowId = response.body.result?.flow?.flowId;
  if (!flowId) {
    throw new Error("webhook create_flow returned no flow id");
  }
  return flowId;
}

async function projectChild(params: {
  origin: string;
  flowId: string;
  childSessionKey: string;
  runId: string;
  runtime?: "acp" | "subagent";
}) {
  const response = await postWebhook(params.origin, {
    action: "run_task",
    flowId: params.flowId,
    runtime: params.runtime ?? "subagent",
    childSessionKey: params.childSessionKey,
    runId: params.runId,
    task: `Managed projection ${params.runId}`,
  });
  expect(response).toMatchObject({ status: 200, body: { ok: true } });
}

async function readAcpTraceMethods(tracePath: string): Promise<string[]> {
  return (await fs.readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { method: string }).method);
}

describe("webhooks TaskFlow child cancellation authority", () => {
  it("allows the owner and rejects foreign or replaced backing runs before termination", async () => {
    const root = tempDirs.make("openclaw-webhooks-taskflow-authz-");
    const stateDir = path.join(root, "state");
    const acpxStateDir = path.join(root, "acpx-state");
    const acpxTracePath = path.join(root, "acpx-process-trace.jsonl");
    const configPath = path.join(root, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });

    const config: OpenClawConfig = {
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { mode: "token", token: TOKEN },
      },
      acp: {
        enabled: true,
        backend: "acpx",
        dispatch: { enabled: true },
        allowedAgents: ["codex"],
      },
    };
    await fs.writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");

    await withEnvAsync(
      {
        ...snapshotGatewayStartupEnv(),
        HOME: root,
        CODEX_PATH: path.resolve("extensions/acpx/test/fixtures/codex-app-server.mjs"),
        OPENCLAW_ACPX_PROCESS_FIXTURE_TRACE: acpxTracePath,
        OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE: "0",
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_HOME: root,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_SKIP_ACPX_RUNTIME: undefined,
        OPENCLAW_SKIP_ACPX_RUNTIME_PROBE: "1",
        OPENCLAW_STATE_DIR: stateDir,
      },
      async () => {
        clearConfigCache();
        clearRuntimeConfigSnapshot();
        const port = await getGatewayE2ePortBlock();
        const server = await startGatewayServer(port, {
          auth: { mode: "token", token: TOKEN },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        await server.startupSettled;
        const registry = getActivePluginRegistry();
        if (!registry) {
          throw new Error("gateway did not publish an active plugin registry");
        }
        setTaskRegistryControlRuntimeForTests({
          cancelActiveCronTaskRun,
          cancelBackgroundExecSession,
          getAcpSessionManager,
          killSubagentRunAdmin,
        });
        const routeCleanups: Array<() => void> = [];
        const acpxServices: OpenClawPluginService[] = [];
        const acpxRuntime = createPluginRuntimeMock({
          state: {
            openKeyedStore: (options) => createPluginStateKeyedStoreForTests("acpx", options),
          },
        });
        acpxPlugin.register(
          createTestPluginApi({
            id: "acpx",
            name: "ACPX Runtime",
            config,
            pluginConfig: {
              cwd: root,
              stateDir: acpxStateDir,
              permissionMode: "deny-all",
              timeoutSeconds: 15,
            },
            runtime: acpxRuntime,
            registerService: (service) => {
              acpxServices.push(service);
            },
          }),
        );
        const acpxService = acpxServices.at(0);
        if (!acpxService) {
          throw new Error("ACPX plugin did not register its runtime service");
        }
        const acpxServiceContext = {
          config,
          workspaceDir: root,
          stateDir,
          logger: { info() {}, warn() {}, error() {}, debug() {} },
        };
        await acpxService.start(acpxServiceContext);
        webhooksPlugin.register(
          createTestPluginApi({
            id: "webhooks",
            name: "Webhooks",
            config,
            pluginConfig: {
              routes: {
                authorityProof: {
                  path: ROUTE_PATH,
                  sessionKey: ROUTE_OWNER,
                  secret: SECRET,
                },
              },
            },
            runtime: createPluginRuntime(),
            registerHttpRoute: (route) => {
              routeCleanups.push(
                registerPluginHttpRoute({
                  ...route,
                  pluginId: "webhooks",
                  registry,
                  source: "extensions/webhooks/index.ts",
                }),
              );
            },
          }),
        );

        try {
          const origin = `http://127.0.0.1:${port}`;

          const allowedRunId = "run-webhook-owned";
          const allowedChild = "agent:main:subagent:webhook-owned";
          registerRunningSubagent({
            runId: allowedRunId,
            childSessionKey: allowedChild,
            ownerKey: ROUTE_OWNER,
          });
          const allowedFlowId = await createFlow(origin, "Cancel owned child");
          await projectChild({
            origin,
            flowId: allowedFlowId,
            childSessionKey: allowedChild,
            runId: allowedRunId,
          });
          const allowed = await postWebhook(origin, {
            action: "cancel_flow",
            flowId: allowedFlowId,
          });
          expect(allowed).toMatchObject({ status: 200, body: { ok: true } });
          expect(getSubagentRunByRunId(allowedRunId)).toMatchObject({
            endedReason: "subagent-killed",
            execution: { status: "terminal", endedAt: expect.any(Number) },
          });
          expect(getTaskFlowById(allowedFlowId)?.status).toBe("cancelled");
          expect(listTasksForFlowId(allowedFlowId)).toEqual([
            expect.objectContaining({ status: "cancelled" }),
          ]);

          const foreignRunId = "run-webhook-foreign";
          const foreignChild = "agent:main:subagent:webhook-foreign";
          const foreignBacking = registerRunningSubagent({
            runId: foreignRunId,
            childSessionKey: foreignChild,
            ownerKey: "agent:main:foreign-owner",
          });
          const foreignFlowId = await createFlow(origin, "Reject foreign child");
          const foreignAdmission = await postWebhook(origin, {
            action: "run_task",
            flowId: foreignFlowId,
            runtime: "subagent",
            childSessionKey: foreignChild,
            runId: foreignRunId,
            task: "Reject foreign child projection",
          });
          expect(foreignAdmission).toMatchObject({
            status: 409,
            body: { ok: false, code: "task_not_created" },
          });
          const forgedProjection = createRunningTaskRunCore({
            runtime: "subagent",
            ownerKey: ROUTE_OWNER,
            scopeKind: "session",
            parentFlowId: foreignFlowId,
            childSessionKey: foreignChild,
            runId: foreignRunId,
            task: "Persisted foreign child projection",
            startedAt: Date.now(),
            detail: {
              ...createSubagentTaskBackingDetail(foreignBacking.generation),
              taskId: foreignBacking.task.taskId,
            },
          });
          if (!forgedProjection) {
            throw new Error("failed to create persisted foreign child projection");
          }
          const foreign = await postWebhook(origin, {
            action: "cancel_flow",
            flowId: foreignFlowId,
          });
          expect(foreign).toMatchObject({
            status: 409,
            body: { ok: false, code: "cancel_rejected" },
          });
          expect(getSubagentRunByRunId(foreignRunId)).toMatchObject({
            execution: { status: "running" },
          });
          expect(getSubagentRunByRunId(foreignRunId)?.execution.endedAt).toBeUndefined();
          expect(getTaskFlowById(foreignFlowId)).toMatchObject({ status: "queued" });
          expect(getTaskFlowById(foreignFlowId)?.cancelRequestedAt).toBeUndefined();

          const replacedRunId = "run-webhook-replaced";
          const replacementRunId = "run-webhook-replacement";
          const replacedChild = "agent:main:subagent:webhook-replaced";
          registerRunningSubagent({
            runId: replacedRunId,
            childSessionKey: replacedChild,
            ownerKey: ROUTE_OWNER,
          });
          const replacedFlowId = await createFlow(origin, "Reject replaced child");
          await projectChild({
            origin,
            flowId: replacedFlowId,
            childSessionKey: replacedChild,
            runId: replacedRunId,
          });
          registerRunningSubagent({
            runId: replacementRunId,
            childSessionKey: replacedChild,
            ownerKey: ROUTE_OWNER,
          });
          const replaced = await postWebhook(origin, {
            action: "cancel_flow",
            flowId: replacedFlowId,
          });
          expect(replaced).toMatchObject({
            status: 409,
            body: { ok: false, code: "cancel_rejected" },
          });
          expect(getSubagentRunByRunId(replacementRunId)).toMatchObject({
            execution: { status: "running" },
          });
          expect(getSubagentRunByRunId(replacementRunId)?.execution.endedAt).toBeUndefined();

          const reusedRunId = "run-webhook-reused";
          const reusedChild = "agent:main:subagent:webhook-reused";
          registerRunningSubagent({
            runId: reusedRunId,
            childSessionKey: reusedChild,
            ownerKey: ROUTE_OWNER,
          });
          const reusedFlowId = await createFlow(origin, "Reject reused-id replacement child");
          await projectChild({
            origin,
            flowId: reusedFlowId,
            childSessionKey: reusedChild,
            runId: reusedRunId,
          });
          registerRunningSubagent({
            runId: reusedRunId,
            childSessionKey: reusedChild,
            ownerKey: ROUTE_OWNER,
          });
          const reused = await postWebhook(origin, {
            action: "cancel_flow",
            flowId: reusedFlowId,
          });
          expect(reused).toMatchObject({
            status: 409,
            body: { ok: false, code: "cancel_rejected" },
          });
          expect(getSubagentRunByRunId(reusedRunId)).toMatchObject({
            execution: { status: "running" },
          });
          expect(getSubagentRunByRunId(reusedRunId)?.execution.endedAt).toBeUndefined();

          const acpChild = "agent:main:acp:webhook-replacement";
          const reusedAcpRunId = "run-webhook-acp-reused";
          const acpManager = getAcpSessionManager();
          replaceSessionEntrySync(
            {
              sessionKey: acpChild,
              storePath: resolveSessionStorePathCore(config.session?.store, { agentId: "main" }),
            },
            {
              sessionId: "session-webhook-acp-replacement",
              updatedAt: Date.now(),
              spawnedBy: ROUTE_OWNER,
              parentSessionKey: ROUTE_OWNER,
            },
          );
          await acpManager.initializeSession({
            cfg: config,
            sessionKey: acpChild,
            agent: "codex",
            mode: "persistent",
            backendId: "acpx",
          });
          const firstAcpAdmission = createTestAdmittedRunContext(reusedAcpRunId);
          await acpManager.runTurn({
            admittedRunContext: firstAcpAdmission,
            cfg: config,
            sessionKey: acpChild,
            provenance: "system",
            text: "Complete the first same-id turn before replacement.",
            mode: "prompt",
            requestId: reusedAcpRunId,
            onElicitation: async () => ({
              action: "accept",
              content: { question: "complete normally" },
            }),
          });
          const firstAcpTask = findTaskByRunId(reusedAcpRunId);
          if (!firstAcpTask) {
            throw new Error("first ACP turn created no canonical task");
          }
          const acpReplacementFlowId = await createFlow(origin, "Reject same-id ACP replacement");
          const staleAcpProjection = createRunningTaskRunCore({
            runtime: "acp",
            ownerKey: ROUTE_OWNER,
            scopeKind: "session",
            parentFlowId: acpReplacementFlowId,
            childSessionKey: acpChild,
            runId: reusedAcpRunId,
            task: "Persisted first-generation ACP projection",
            startedAt: Date.now(),
            detail: {
              ...createAcpTaskBackingDetailForTest(
                firstAcpAdmission.operationalRunInstance.instanceId,
                1,
              ),
              taskId: firstAcpTask.taskId,
            },
          });
          if (!staleAcpProjection) {
            throw new Error("failed to create persisted ACP projection");
          }

          const elicitationEntered = createDeferred();
          const releaseElicitation = createDeferred();
          const replacementAcpTurn = acpManager.runTurn({
            admittedRunContext: createTestAdmittedRunContext(reusedAcpRunId),
            cfg: config,
            sessionKey: acpChild,
            provenance: "system",
            text: "Keep the same-id replacement active for cancellation fencing proof.",
            mode: "prompt",
            requestId: reusedAcpRunId,
            onElicitation: async () => {
              elicitationEntered.resolve();
              await releaseElicitation.promise;
              return { action: "accept", content: { question: "complete normally" } };
            },
          });
          let acpReplacement: WebhookResponse | undefined;
          let acpxMethodsBeforeRelease: string[] = [];
          try {
            await elicitationEntered.promise;
            acpReplacement = await postWebhook(origin, {
              action: "cancel_flow",
              flowId: acpReplacementFlowId,
            });
            expect(acpReplacement).toMatchObject({
              status: 409,
              body: { ok: false, code: "cancel_rejected" },
            });
            expect(getTaskFlowById(acpReplacementFlowId)).toMatchObject({ status: "queued" });
            expect(getTaskFlowById(acpReplacementFlowId)?.cancelRequestedAt).toBeUndefined();
            acpxMethodsBeforeRelease = await readAcpTraceMethods(acpxTracePath);
            expect(acpxMethodsBeforeRelease).toContain("turn/start");
            expect(acpxMethodsBeforeRelease).not.toContain("turn/interrupt");
          } finally {
            releaseElicitation.resolve();
            await replacementAcpTurn;
          }
          if (!acpReplacement) {
            throw new Error("missing ACP replacement cancellation response");
          }

          const queuedAcpChild = "agent:main:acp:webhook-queued-successor";
          const queuedAcpRunId = "run-webhook-acp-queued";
          replaceSessionEntrySync(
            {
              sessionKey: queuedAcpChild,
              storePath: resolveSessionStorePathCore(config.session?.store, { agentId: "main" }),
            },
            {
              sessionId: "session-webhook-acp-queued-successor",
              updatedAt: Date.now(),
              spawnedBy: ROUTE_OWNER,
              parentSessionKey: ROUTE_OWNER,
            },
          );
          await acpManager.initializeSession({
            cfg: config,
            sessionKey: queuedAcpChild,
            agent: "codex",
            mode: "persistent",
            backendId: "acpx",
          });
          const queuedTargetEntered = createDeferred();
          const releaseQueuedTarget = createDeferred();
          const queuedTargetTurn = acpManager.runTurn({
            admittedRunContext: createTestAdmittedRunContext(queuedAcpRunId),
            cfg: config,
            sessionKey: queuedAcpChild,
            provenance: "system",
            text: "Keep the target active while its same-id successor queues.",
            mode: "prompt",
            requestId: queuedAcpRunId,
            onElicitation: async () => {
              queuedTargetEntered.resolve();
              await releaseQueuedTarget.promise;
              return { action: "accept", content: { question: "cancel target" } };
            },
          });
          await queuedTargetEntered.promise;
          const queuedFlowId = await createFlow(origin, "Cancel target before queued successor");
          await projectChild({
            origin,
            flowId: queuedFlowId,
            runtime: "acp",
            childSessionKey: queuedAcpChild,
            runId: queuedAcpRunId,
          });
          const interruptsBeforeQueuedCancel = (await readAcpTraceMethods(acpxTracePath)).filter(
            (method) => method === "turn/interrupt",
          ).length;
          const queuedSuccessorEntered = createDeferred();
          const releaseQueuedSuccessor = createDeferred();
          const queuedSuccessorTurn = acpManager.runTurn({
            admittedRunContext: createTestAdmittedRunContext(queuedAcpRunId),
            cfg: config,
            sessionKey: queuedAcpChild,
            provenance: "system",
            text: "Complete the same-id successor without inheriting cancellation.",
            mode: "prompt",
            requestId: queuedAcpRunId,
            onElicitation: async () => {
              queuedSuccessorEntered.resolve();
              await releaseQueuedSuccessor.promise;
              return { action: "accept", content: { question: "complete successor" } };
            },
          });
          const queuedCancelPromise = postWebhook(origin, {
            action: "cancel_flow",
            flowId: queuedFlowId,
          });
          await vi.waitFor(
            async () => {
              const interruptCount = (await readAcpTraceMethods(acpxTracePath)).filter(
                (method) => method === "turn/interrupt",
              ).length;
              expect(interruptCount - interruptsBeforeQueuedCancel).toBeGreaterThan(0);
            },
            { interval: 10, timeout: 10_000 },
          );
          releaseQueuedTarget.resolve();
          const queuedCancel = await queuedCancelPromise;
          expect(queuedCancel).toMatchObject({ status: 200, body: { ok: true } });
          const interruptsAfterTargetCancel = (await readAcpTraceMethods(acpxTracePath)).filter(
            (method) => method === "turn/interrupt",
          ).length;
          expect(interruptsAfterTargetCancel - interruptsBeforeQueuedCancel).toBeGreaterThan(0);
          await queuedTargetTurn;
          await queuedSuccessorEntered.promise;
          const interruptsWhileSuccessorActive = (await readAcpTraceMethods(acpxTracePath)).filter(
            (method) => method === "turn/interrupt",
          ).length;
          expect(interruptsWhileSuccessorActive - interruptsAfterTargetCancel).toBe(0);
          releaseQueuedSuccessor.resolve();
          await queuedSuccessorTurn;

          console.info(
            "webhooks-taskflow-authority-proof",
            JSON.stringify({
              allowed: {
                httpStatus: allowed.status,
                flowStatus: getTaskFlowById(allowedFlowId)?.status,
                childStatus: getSubagentRunByRunId(allowedRunId)?.execution.status,
              },
              foreign: {
                admissionStatus: foreignAdmission.status,
                httpStatus: foreign.status,
                code: foreign.body.code,
                flowStatus: getTaskFlowById(foreignFlowId)?.status,
                childStatus: getSubagentRunByRunId(foreignRunId)?.execution.status,
              },
              replaced: {
                httpStatus: replaced.status,
                code: replaced.body.code,
                replacementStatus: getSubagentRunByRunId(replacementRunId)?.execution.status,
              },
              reusedId: {
                httpStatus: reused.status,
                code: reused.body.code,
                replacementStatus: getSubagentRunByRunId(reusedRunId)?.execution.status,
              },
              acpReplacement: {
                transport: "process",
                httpStatus: acpReplacement.status,
                code: acpReplacement.body.code,
                interruptRequests: acpxMethodsBeforeRelease.filter(
                  (method) => method === "turn/interrupt",
                ).length,
                replacementStatus: "completed",
              },
              acpQueuedSuccessor: {
                transport: "process",
                httpStatus: queuedCancel.status,
                targetInterruptRequests: interruptsAfterTargetCancel - interruptsBeforeQueuedCancel,
                successorInterruptRequests:
                  interruptsWhileSuccessorActive - interruptsAfterTargetCancel,
                successorStatus: "completed",
              },
            }),
          );
        } finally {
          for (const cleanup of routeCleanups.toReversed()) {
            cleanup();
          }
          await acpxService.stop?.(acpxServiceContext);
          await server.close();
        }
      },
    );
  }, 90_000);
});
