/** Channel Stop initiates native and ACP cancellation independently of either drain. */
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getAcpSessionManager, testing as acpTesting } from "../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../acp/control-plane/manager.lifecycle.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadExactSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { useChatAbortRegistryFixture } from "../../gateway/server-methods/chat.abort-registry.test-support.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  beginSessionWorkAdmission,
  isSessionWorkAdmissionActive,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { tryFastAbortFromMessage } from "./abort.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { buildTestCtx } from "./test-ctx.js";

const fixture = useChatAbortRegistryFixture();

it.each(
  ["idle", "active", "native failure"].flatMap((scenario) =>
    ["resolve", "reject"].map((completion) => ({ scenario, completion })),
  ),
)(
  "native and bound ACP cancellation initiate before either drain ($scenario, $completion)",
  async ({ scenario, completion }) => {
    const active = scenario !== "idle";
    const nativeFailure = scenario === "native failure";
    const nativeError = new Error("native cancellation failed");
    const sourceKey = "agent:main:stop-test:direct:room";
    const acpKey = "agent:main:acp:bound-stop";
    const runningKey = "agent:main:subagent:running";
    const queuedKey = "agent:main:subagent:queued";
    for (const [runId, sessionKey] of [
      ["source", sourceKey],
      ["acp", acpKey],
      ["running", runningKey],
      ["queued", queuedKey],
    ] as const) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey,
        defaultSessionId: `${runId}-session`,
      });
    }
    const cfg = getRuntimeConfig();
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
    const registry = captureActivePluginRegistrySnapshot();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "stop-test",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "stop-test" }),
            conversationBindings: { supportsCurrentConversationBinding: true },
          },
        },
      ]),
    );
    const binding = await getSessionBindingService().bind({
      targetSessionKey: acpKey,
      targetKind: "session",
      conversation: { channel: "stop-test", accountId: "default", conversationId: "room" },
      placement: "current",
    });
    const entered = createDeferred();
    const proceed = createDeferred();
    const cancelFinished = createDeferred();
    const turnStarted = createDeferred<AbortSignal>();
    const finishTurn = createDeferred();
    const nativeInterrupted = createDeferred();
    const cancel = vi.fn<AcpRuntime["cancel"]>(async () => {
      entered.resolve();
      await proceed.promise;
      cancelFinished.resolve();
      if (completion === "reject") {
        throw new Error("backend cancellation failed");
      }
    });
    registerAcpRuntimeBackend({
      id: "stop-test",
      runtime: {
        ensureSession: async ({ sessionKey }) => ({
          sessionKey,
          backend: "stop-test",
          runtimeSessionName: "mock-runtime",
        }),
        async *runTurn({ signal }) {
          if (!signal) {
            throw new Error("ACP manager did not provide its active turn signal");
          }
          turnStarted.resolve(signal);
          await finishTurn.promise;
          yield { type: "done", status: "cancelled" };
        },
        cancel,
        close: async () => {},
      },
    });
    acpTesting.resetAcpSessionManagerForTests();
    const manager = getAcpSessionManager();
    const native = createReplyOperation({
      sessionKey: sourceKey,
      sessionId: "source-session",
      resetTriggered: false,
    });
    native.attachBackend({
      kind: "embedded",
      isStreaming: () => true,
      cancel: () => {
        releaseSwarmRun("capacity");
        if (nativeFailure) {
          throw nativeError;
        }
      },
    });
    const runningAbort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId: "running", abort: runningAbort });
    setActiveEmbeddedRun("running-session", handle, runningKey);
    const selectedDispatch = vi.fn(async () => {});
    const survivorDispatch = vi.fn(async () => {});
    let pending: ReturnType<typeof tryFastAbortFromMessage> | undefined;
    let childAdmission: SessionWorkAdmissionLease | undefined;
    const preparedAdmission = prepareAgentRunAdmission({
      cfg,
      operationalRunInstance: createOperationalRunInstanceRef("acp-steer"),
      facts: {
        runId: "acp-steer",
        agentId: "main",
        ingress: { kind: "acp", boundary: "acp.command.steer", state: "absent" },
      },
    });
    let turn: Promise<void> | undefined;
    let acpSignal: AbortSignal | undefined;
    let stopSettled = false;
    try {
      await manager.initializeSession({
        cfg,
        sessionKey: acpKey,
        agent: "main",
        mode: "persistent",
        backendId: "stop-test",
      });
      if (active) {
        const admittedRunContext = await preparedAdmission.admit("acp");
        // Match /acp steer: the manager owns the only cancellation signal.
        turn = manager
          .runTurn({
            cfg,
            admittedRunContext,
            sessionKey: acpKey,
            requestId: "acp-steer",
            mode: "steer",
            provenance: "agent",
            text: "keep working",
          })
          .finally(() => preparedAdmission.close());
        acpSignal = await Promise.race([
          turnStarted.promise,
          turn.then(() => {
            throw new Error("ACP steer completed before the active-turn gate");
          }),
        ]);
        expect(acpSignal.aborted).toBe(false);
        expect(manager.getObservabilitySnapshot().turns.active).toBe(1);
        childAdmission = await beginSessionWorkAdmission({
          scope: storePath,
          identities: [runningKey, "running-session"],
          assertAllowed: () => {},
          onInterrupt: () => nativeInterrupted.resolve(),
        });
      }
      for (const [runId, childSessionKey] of [
        ["running", runningKey],
        ["queued", queuedKey],
      ] as const) {
        registerSubagentRun({
          runId,
          childSessionKey,
          requesterSessionKey: sourceKey,
          requesterAgentId: "main",
          requesterDisplayKey: sourceKey,
          task: runId,
          cleanup: "keep",
          collect: true,
          queued: runId === "queued",
          expectsCompletionMessage: false,
        });
      }
      for (const [runId, start] of [
        ["queued", selectedDispatch],
        ["survivor", survivorDispatch],
      ] as const) {
        enqueueSwarmRun({
          groupId: "bound-acp",
          runId,
          maxConcurrent: 1,
          activeRunIds: ["capacity"],
          start,
          onStartFailure: () => true,
        });
      }
      pending = tryFastAbortFromMessage({
        cfg,
        ctx: buildTestCtx({
          SessionKey: sourceKey,
          CommandBody: "/stop",
          RawBody: "/stop",
          CommandAuthorized: true,
          Provider: "stop-test",
          Surface: "stop-test",
          From: "stop-test:room",
          To: "stop-test:room",
          MessageSid: "77",
          Timestamp: 1234567890000,
        }),
      }).finally(() => {
        stopSettled = true;
      });
      const outcome = pending.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      if (nativeFailure) {
        await Promise.race([
          entered.promise,
          outcome.then(() => {
            throw new Error("Native failure escaped before ACP cancellation started");
          }),
        ]);
        expect(native.abortSignal.aborted).toBe(true);
        expect(acpSignal?.aborted).toBe(true);
        expect(stopSettled).toBe(false);
        proceed.resolve();
        expect(await outcome).toEqual({ error: nativeError });
        expect(cancel).toHaveBeenCalledOnce();
        return;
      }
      if (active) {
        await nativeInterrupted.promise;
        expect(native.abortSignal.aborted).toBe(true);
        expect(isSessionWorkAdmissionActive(storePath, [runningKey, "running-session"])).toBe(true);
        await vi.waitFor(() => expect(acpSignal?.aborted).toBe(true));
        expect(cancel).toHaveBeenCalledOnce();
        expect(stopSettled).toBe(false);
        expect(selectedDispatch).not.toHaveBeenCalled();
        if (completion === "reject") {
          proceed.resolve();
          await cancelFinished.promise;
          // Let rejection observers run while the native admission is still retained.
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(stopSettled).toBe(false);
        }
        childAdmission?.release();
      }
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("Stop missed the bound ACP backend");
        }),
      ]);
      expect(native.abortSignal.aborted).toBe(true);
      // Synchronize on native terminal state, never on the still-held ACP completion.
      await vi.waitFor(() => expect(runningAbort).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(survivorDispatch).toHaveBeenCalledOnce());
      expect(selectedDispatch).not.toHaveBeenCalled();
      for (const key of [runningKey, queuedKey]) {
        expect(getSubagentRunByChildSessionKey(key)?.endedReason).toBe("subagent-killed");
      }
      await vi.waitFor(() =>
        expect(loadExactSessionEntryReadOnly({ sessionKey: sourceKey })?.entry).toMatchObject({
          abortedLastRun: true,
          abortCutoffMessageSid: "77",
          abortCutoffTimestamp: 1234567890000,
        }),
      );
      if (!active || completion !== "reject") {
        expect(stopSettled).toBe(false);
      }
      proceed.resolve();
      expect(await pending).toEqual({
        handled: true,
        aborted: true,
        stoppedSubagents: 2,
        failedSubagents: 0,
      });
      expect(cancel).toHaveBeenCalledExactlyOnceWith({
        handle: expect.objectContaining({ sessionKey: acpKey }),
        reason: "fast-abort",
      });
      finishTurn.resolve();
      await turn;
      expect(readAcpSessionMeta({ cfg, sessionKey: acpKey })?.state).toBe(
        !active && completion === "reject" ? "error" : "idle",
      );
    } finally {
      childAdmission?.release();
      proceed.resolve();
      finishTurn.resolve();
      await pending?.catch(() => undefined);
      await turn?.catch(() => undefined);
      preparedAdmission.close();
      native.complete();
      clearActiveEmbeddedRun("running-session", handle, runningKey);
      releaseSwarmRun("capacity");
      releaseSwarmRun("queued");
      releaseSwarmRun("survivor");
      await disposeAcpSessionManagerInstance(manager, "test-cleanup");
      acpTesting.resetAcpSessionManagerForTests();
      unregisterAcpRuntimeBackend("stop-test");
      await getSessionBindingService().unbind({
        bindingId: binding.bindingId,
        reason: "test-cleanup",
      });
      restoreActivePluginRegistrySnapshot(registry);
    }
  },
);
