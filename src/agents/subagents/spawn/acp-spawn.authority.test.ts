import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  getAcpSessionManager,
  testing as managerTesting,
} from "../../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../../acp/control-plane/manager.lifecycle.js";
import { SessionActorQueue } from "../../../acp/control-plane/session-actor-queue.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../../acp/runtime/registry.js";
import type { CliDeps } from "../../../cli/deps.types.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import * as sessionAccessor from "../../../config/sessions/session-accessor.js";
import * as gatewayCall from "../../../gateway/call.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { withLocalGatewayRequestScope } from "../../../gateway/local-request-context.js";
import { handleChatAbortRequest } from "../../../gateway/server-methods/chat-abort-handler.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
} from "../../../infra/outbound/session-binding-service.js";
import { flushLogger, resetLogger } from "../../../logging/logger.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-registry.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { copyAgentToolMetadata } from "../../agent-tool-metadata.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import type { AnyAgentTool } from "../../agent-tools.types.js";
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
import * as acpSpawnRuntime from "./acp-spawn-runtime.js";
import { setSubagentSpawnDepsForTest } from "./subagent-spawn-deps.js";

const parentSessionKey = "agent:main:main";
const parentRunId = "acp-spawn-parent";
const backendId = "spawn-authority-fixture";
const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
let stateDir = "";

beforeAll(async () => {
  // Prepare the real cleanup graph before the RPC deadline starts; source
  // transformation is not part of the running Gateway's cleanup budget.
  await Promise.all([
    import("../../../gateway/server-methods/sessions-delete.js"),
    import("../../../gateway/server-methods/sessions.runtime.js"),
    import("../../embedded-agent.js"),
    import("../../agent-bundle-mcp-tools.js"),
    import("../../bash-process-registry.js"),
  ]);
});

beforeEach(async () => {
  stateDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-acp-authority-")));
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  await writeFile(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({
      logging: { audit: { enabled: false } },
      acp: { enabled: true, backend: backendId, allowedAgents: ["fixture"] },
      agents: {
        ownership: "explicit",
        defaults: { workspace: stateDir },
        entries: { main: { workspace: stateDir }, fixture: { workspace: stateDir } },
      },
    }),
  );
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  managerTesting.resetAcpSessionManagerForTests();
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
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
  try {
    await disposeAcpSessionManagerInstance(getAcpSessionManager(), "test-cleanup");
    managerTesting.resetAcpSessionManagerForTests();
    unregisterAcpRuntimeBackend(backendId);
    await settleSubagentRegistryPersistenceWork();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    await cleanupSessionStateForTest({ stateDir });
  } finally {
    registryTesting.setDepsForTest();
    setSubagentSpawnDepsForTest();
    vi.restoreAllMocks();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    try {
      await flushLogger();
      resetLogger();
    } finally {
      env.restore();
    }
  }
  await rm(stateDir, { recursive: true, force: true });
});

describe("pending ACP spawn authority", () => {
  it.each([
    ["runtime", "abort"],
    ["runtime", "admission close"],
    ["runtime", "live"],
    ["row", "admission close"],
    ["transcript", "admission close"],
    ["thread", "admission close"],
    ["thread", "live"],
    ["actor", "admission close"],
    ["metadata", "admission close"],
    ["initialized", "admission close"],
  ] as const)(
    "transfers initialized ACP work only from its live parent: %s / %s",
    async (stage, closure) => {
      const cfg = getRuntimeConfig();
      await writeSubagentSessionEntry({
        stateDir,
        agentId: "main",
        sessionKey: parentSessionKey,
        defaultSessionId: "parent-session",
      });
      const context = withLocalGatewayRequestScope(
        { deps: {} as CliDeps, getRuntimeConfig: () => cfg },
        () => getPluginRuntimeGatewayRequestScope()!.context!,
      );
      const work = new AsyncWorkScope();
      const trackExecution = context.trackExecution;
      context.trackExecution = (run) => work.track(() => trackExecution(run));
      const admission = prepareAgentRunAdmission({
        cfg,
        operationalRunInstance: createOperationalRunInstanceRef(parentRunId),
        facts: {
          runId: parentRunId,
          agentId: "main",
          ingress: { kind: "system", boundary: "acp-authority-test", state: "present" },
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
      bindGatewayContextResolver(admitted, () => context);
      parent.bindAgentRunDelegatedAuthority(getAdmittedRunDelegatedAuthority(admitted)!);
      expect(admitted.executionIdentityToken).toBeUndefined();
      const entered = createDeferred<string>();
      const release = createDeferred();
      const pause = async (sessionKey: string) => {
        entered.resolve(sessionKey);
        await release.promise;
      };
      let childKey: string | undefined;
      const upsert = sessionAccessor.upsertSessionEntryCore;
      vi.spyOn(sessionAccessor, "upsertSessionEntryCore").mockImplementation(async (...args) => {
        const entry = await upsert(...args);
        childKey = args[0].sessionKey;
        if (stage === "row") {
          await pause(childKey);
        }
        return entry;
      });
      if (stage === "transcript") {
        const resolve = sessionAccessor.resolveSessionTranscriptRuntimeTarget;
        vi.spyOn(sessionAccessor, "resolveSessionTranscriptRuntimeTarget").mockImplementation(
          async (...args) => {
            const target = await resolve(...args);
            await pause(target.sessionKey);
            return target;
          },
        );
      } else if (stage === "actor") {
        const run = vi.spyOn(SessionActorQueue.prototype, "run");
        run.mockImplementationOnce(function (this: SessionActorQueue, key, op) {
          run.mockRestore();
          return this.run(key, async () => {
            if (!childKey) {
              throw new Error("ACP actor started before its child entry existed");
            }
            await pause(childKey);
            return await op();
          });
        });
      } else if (stage === "initialized" || stage === "metadata") {
        const initialize = acpSpawnRuntime.initializeAcpSpawnRuntime;
        vi.spyOn(acpSpawnRuntime, "initializeAcpSpawnRuntime").mockImplementationOnce(
          async (params) => {
            const initialized = await initialize(params);
            if (stage === "initialized") {
              await pause(params.sessionKey);
            } else if (!getAdmittedRunDelegatedAuthority(admitted)) {
              lateMetadata(initialized.initialized.meta);
            }
            return initialized;
          },
        );
      }
      const lateMetadata = vi.fn();
      if (stage === "metadata") {
        const patch = sessionAccessor.patchSessionEntryWithKey;
        let held = false;
        vi.spyOn(sessionAccessor, "patchSessionEntryWithKey").mockImplementation(
          async (...args) => {
            const patched = await patch(...args);
            if (!held && ensuredSessions.length > 0 && childKey) {
              held = true;
              await pause(childKey);
            }
            return patched;
          },
        );
      }
      const bindThread = vi.fn<NonNullable<SessionBindingAdapter["bind"]>>(async (input) => ({
        bindingId: "default:child-thread",
        targetSessionKey: input.targetSessionKey,
        targetKind: "session",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "child-thread",
          parentConversationId: "parent-channel",
        },
        status: "active",
        boundAt: Date.now(),
        metadata: input.metadata,
      }));
      const bindingAdapter: SessionBindingAdapter = {
        channel: "discord",
        accountId: "default",
        capabilities: { placements: ["child"], bindSupported: true, unbindSupported: true },
        bind: bindThread,
        listBySession: () => [],
        resolveByConversation: () => null,
        unbind: async () => [],
      };
      if (stage === "thread") {
        registerSessionBindingAdapter(bindingAdapter);
      }
      const pausesRuntime = stage === "runtime" || stage === "thread";
      const initializesRuntime = pausesRuntime || stage === "metadata" || stage === "initialized";
      const ensuredSessions: string[] = [];
      const closeRuntime = vi.fn(async () => {});
      const runtime: AcpRuntime = {
        ownerAwareSessions: 1,
        async ensureSession(input) {
          ensuredSessions.push(input.sessionKey);
          if (pausesRuntime) {
            await pause(input.sessionKey);
          }
          return {
            sessionKey: input.sessionKey,
            agentId: input.agentId,
            backend: backendId,
            runtimeSessionName: input.sessionKey,
            backendSessionId: `fixture:${input.sessionKey}`,
          };
        },
        runTurn() {
          throw new Error("No external harness turn belongs in this boundary test");
        },
        async cancel() {},
        close: closeRuntime,
      };
      registerAcpRuntimeBackend({ id: backendId, runtime });
      const dispatch = vi.fn();
      setSubagentSpawnDepsForTest({
        dispatchGatewayMethodInProcess: async <T>(
          method: string,
          params: Record<string, unknown>,
        ) => {
          if (method !== "agent") {
            throw new Error(`Unexpected spawn RPC ${method}`);
          }
          dispatch(params);
          return { runId: params.idempotencyKey, status: "accepted" } as T;
        },
      });
      const socket = vi
        .spyOn(gatewayCall, "callGateway")
        .mockRejectedValue(new Error("Raw WebSocket transport is unavailable"));
      const source = createSessionsSpawnTool({
        config: cfg,
        agentSessionKey: parentSessionKey,
        requesterRunId: parentRunId,
        requesterTurnRunId: parentRunId,
        ...(stage === "thread"
          ? {
              agentChannel: "discord",
              agentAccountId: "default",
              agentTo: "channel:parent-channel",
            }
          : {}),
      });
      let forwarded: Promise<unknown> | undefined;
      const observed: AnyAgentTool = copyAgentToolMetadata(source, {
        ...source,
        execute: (...args) => {
          const pending = source.execute!(...args);
          forwarded = pending.then(
            (result) => result,
            (error: unknown) => error,
          );
          return pending;
        },
      });
      const [tool] = finalizeAgentTools({
        tools: [observed],
        hookContext: {
          config: cfg,
          agentId: "main",
          sessionKey: parentSessionKey,
          runId: parentRunId,
        },
        abortSignal: parent.controller.signal,
      });
      const wrapped = withPluginRuntimeGatewayRequestScope(
        { context, isWebchatConnect: () => false },
        () =>
          withGatewayToolCallerIdentity(
            createAdmittedGatewayToolCallerIdentity({
              admittedRunContext: admitted,
              agentId: "main",
              sessionKey: parentSessionKey,
            }),
            () =>
              tool!.execute!("pending-acp", {
                task: "bounded child",
                runtime: "acp",
                agentId: "fixture",
                mode: "run",
                expectsCompletionMessage: false,
                ...(stage === "thread" ? { thread: true } : {}),
              }),
          ),
      );
      const wrappedOutcome = wrapped.then(
        (result) => result,
        (error: unknown) => error,
      );
      try {
        const childSessionKey = await Promise.race([
          entered.promise,
          wrapped.then(() => {
            throw new Error("ACP spawn settled before runtime initialization");
          }),
        ]);
        expect(subagentRuns.size).toBe(0);
        expect(loadSessionEntry({ sessionKey: childSessionKey, agentId: "fixture" })).toBeDefined();
        if (closure === "abort") {
          const reply = vi.fn();
          const request = { sessionKey: parentSessionKey, runId: parentRunId };
          await handleChatAbortRequest({
            req: { type: "req", id: "abort-parent", method: "chat.abort", params: request },
            params: request,
            context,
            respond: reply,
            client: { ...createSyntheticPluginRuntimeClient(), connId: "owner-connection" },
            isWebchatConnect: () => false,
          });
          expect(reply).toHaveBeenCalledWith(true, {
            ok: true,
            aborted: true,
            runIds: [parentRunId],
          });
          expect(await wrappedOutcome).toBeInstanceOf(Error);
        } else if (closure === "admission close") {
          admission.close();
          expect(parent.controller.signal.aborted).toBe(false);
        }
        expect(getAdmittedRunDelegatedAuthority(admitted) !== undefined).toBe(closure === "live");
        release.resolve();
        const result = await forwarded;
        const sourceBoundary = {
          entry: loadSessionEntry({ sessionKey: childSessionKey, agentId: "fixture" }),
          closes: closeRuntime.mock.calls.length,
        };
        await wrappedOutcome;
        await work.drain();
        expect
          .soft(lateMetadata, "closed parent must not publish ACP metadata after async planning")
          .not.toHaveBeenCalled();
        expect
          .soft(
            ensuredSessions,
            "only live initialization may ensure once; cleanup must not reopen",
          )
          .toEqual(initializesRuntime ? [childSessionKey] : []);
        expect
          .soft(bindThread, "a closed parent must not create an external thread")
          .toHaveBeenCalledTimes(stage === "thread" && closure === "live" ? 1 : 0);
        if (closure === "live") {
          expect(result).toMatchObject({ details: { status: "accepted", childSessionKey } });
          expect(dispatch).toHaveBeenCalledOnce();
          expect(subagentRuns.size).toBe(1);
          expect(closeRuntime).not.toHaveBeenCalled();
        } else {
          expect
            .soft(dispatch, "closed parent must never dispatch new ACP work")
            .not.toHaveBeenCalled();
          expect.soft(subagentRuns.size, "closed parent must never register runnable work").toBe(0);
          expect.soft(socket).not.toHaveBeenCalled();
          expect
            .soft(sourceBoundary.entry, "cleanup completes before spawn returns")
            .toBeUndefined();
          expect
            .soft(sourceBoundary.closes, "runtime closes before spawn returns")
            .toBe(initializesRuntime ? 1 : 0);
          expect
            .soft(loadSessionEntry({ sessionKey: childSessionKey, agentId: "fixture" }))
            .toBeUndefined();
          expect
            .soft(closeRuntime, "cleanup only disposes the runtime this spawn created")
            .toHaveBeenCalledTimes(initializesRuntime ? 1 : 0);
          expect.soft(result).toMatchObject({ details: { status: "error" } });
        }
      } finally {
        release.resolve();
        await forwarded;
        await wrappedOutcome;
        admission.close();
        parent.cleanup();
        await work.drain();
        if (stage === "thread") {
          unregisterSessionBindingAdapter({
            channel: "discord",
            accountId: "default",
            adapter: bindingAdapter,
          });
        }
      }
    },
  );
});
