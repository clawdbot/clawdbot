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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import acpxPlugin from "../../../../extensions/acpx/index.js";
import webhooksPlugin from "../../../../extensions/webhooks/index.js";
import {
  getAcpSessionManager,
  testing as acpManagerTesting,
} from "../../../../src/acp/control-plane/manager.js";
import { createTestAdmittedRunContext } from "../../../../src/agents/admitted-run-context.test-support.js";
import { cancelBackgroundExecSession } from "../../../../src/agents/bash-process-control.js";
import { killSubagentRunAdmin } from "../../../../src/agents/subagents/registry/subagent-control.js";
import { testing as subagentControlTesting } from "../../../../src/agents/subagents/registry/subagent-control.test-support.js";
import { getSubagentRunByRunId } from "../../../../src/agents/subagents/registry/subagent-registry.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../../../../src/agents/subagents/registry/subagent-registry.test-helpers.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../../src/config/config.js";
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
import { createRunningTaskRunCore } from "../../../../src/tasks/task-executor.js";
import { getTaskFlowById } from "../../../../src/tasks/task-flow-registry.js";
import { listTasksForFlowId } from "../../../../src/tasks/task-registry.js";
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
  // Keep the real registry and kill lifecycle while injecting the process facts
  // that this isolated Gateway has no embedded model run or persisted session for.
  subagentControlTesting.setDepsForTest({
    abortEmbeddedAgentRun: () => false,
    isEmbeddedAgentRunActive: () => false,
    clearSessionQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
  });
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
  subagentControlTesting.setDepsForTest();
  subagentRegistryTesting.setDepsForTest();
});

function registerRunningSubagent(params: {
  runId: string;
  childSessionKey: string;
  ownerKey: string;
}) {
  const startedAt = Date.now();
  addSubagentRunForTests({
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    controllerSessionKey: params.ownerKey,
    requesterSessionKey: params.ownerKey,
    requesterDisplayKey: params.ownerKey,
    task: `Running child ${params.runId}`,
    cleanup: "keep",
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
  });
  if (!task) {
    throw new Error(`failed to create canonical task for ${params.runId}`);
  }
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
              agents: {
                codex: {
                  command: process.execPath,
                  args: [path.resolve("node_modules/@agentclientprotocol/codex-acp/dist/index.js")],
                },
              },
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
          registerRunningSubagent({
            runId: foreignRunId,
            childSessionKey: foreignChild,
            ownerKey: "agent:main:foreign-owner",
          });
          const foreignFlowId = await createFlow(origin, "Reject foreign child");
          await projectChild({
            origin,
            flowId: foreignFlowId,
            childSessionKey: foreignChild,
            runId: foreignRunId,
          });
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
            status: 202,
            body: { ok: true, code: "cancel_pending" },
          });
          expect(getSubagentRunByRunId(replacementRunId)).toMatchObject({
            execution: { status: "running" },
          });
          expect(getSubagentRunByRunId(replacementRunId)?.execution.endedAt).toBeUndefined();

          const acpChild = "agent:main:acp:webhook-replacement";
          const staleAcpRunId = "run-webhook-acp-stale";
          const currentAcpRunId = "run-webhook-acp-current";
          const acpManager = getAcpSessionManager();
          await acpManager.initializeSession({
            cfg: config,
            sessionKey: acpChild,
            agent: "codex",
            mode: "persistent",
            backendId: "acpx",
          });
          const elicitationEntered = createDeferred<void>();
          const releaseElicitation = createDeferred<void>();
          const activeAcpTurn = acpManager.runTurn({
            admittedRunContext: createTestAdmittedRunContext(currentAcpRunId),
            cfg: config,
            sessionKey: acpChild,
            provenance: "system",
            text: "Keep this replacement turn active for cancellation fencing proof.",
            mode: "prompt",
            requestId: currentAcpRunId,
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
            const staleCanonicalTask = createRunningTaskRunCore({
              runtime: "acp",
              ownerKey: ROUTE_OWNER,
              scopeKind: "session",
              childSessionKey: acpChild,
              runId: staleAcpRunId,
              task: "Stale ACP child projection",
              startedAt: Date.now(),
              deliveryStatus: "pending",
            });
            if (!staleCanonicalTask) {
              throw new Error("failed to create stale ACP canonical task");
            }
            const acpReplacementFlowId = await createFlow(origin, "Reject replaced ACP child");
            await projectChild({
              origin,
              flowId: acpReplacementFlowId,
              runtime: "acp",
              childSessionKey: acpChild,
              runId: staleAcpRunId,
            });
            acpReplacement = await postWebhook(origin, {
              action: "cancel_flow",
              flowId: acpReplacementFlowId,
            });
            expect(acpReplacement).toMatchObject({
              status: 202,
              body: { ok: true, code: "cancel_pending" },
            });
            acpxMethodsBeforeRelease = (await fs.readFile(acpxTracePath, "utf8"))
              .trim()
              .split("\n")
              .map((line) => (JSON.parse(line) as { method: string }).method);
            expect(acpxMethodsBeforeRelease).toContain("turn/start");
            expect(acpxMethodsBeforeRelease).not.toContain("turn/interrupt");
          } finally {
            releaseElicitation.resolve();
            await activeAcpTurn;
          }
          if (!acpReplacement) {
            throw new Error("missing ACP replacement cancellation response");
          }

          console.info(
            "webhooks-taskflow-authority-proof",
            JSON.stringify({
              allowed: {
                httpStatus: allowed.status,
                flowStatus: getTaskFlowById(allowedFlowId)?.status,
                childStatus: getSubagentRunByRunId(allowedRunId)?.execution.status,
              },
              foreign: {
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
              acpReplacement: {
                transport: "process",
                httpStatus: acpReplacement.status,
                code: acpReplacement.body.code,
                interruptRequests: acpxMethodsBeforeRelease.filter(
                  (method) => method === "turn/interrupt",
                ).length,
                replacementStatus: "completed",
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
