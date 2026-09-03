import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as preparedModelRuntime from "../agents/prepared-model-runtime.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { isSubagentRunQueued } from "../agents/subagents/registry/subagent-registry-read.js";
import { spawnSubagentDirect } from "../agents/subagents/spawn/subagent-spawn.js";
import { testing as spawnTesting } from "../agents/subagents/spawn/subagent-spawn.test-support.js";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
} from "../infra/agent-run-registry.js";
import { agentRunHandler } from "./server-methods/agent-run-handler.js";
import { handleChatAbortRequest } from "./server-methods/chat-abort-handler.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import { sessionAbortHandlers } from "./server-methods/sessions-abort.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import type { dispatchGatewayMethodInProcess } from "./server-plugins.js";
import { useQueuedCollectorFixture } from "./session-utils.queued-collector.test-support.js";

const { parentKey, requestContext, operatorClient } = useQueuedCollectorFixture();

describe("queued collector native admission", () => {
  it.each([false, true])(
    "cancels the native collector's own real preaccept admission (exact=%s)",
    async (exact) => {
      const context = requestContext();
      const entered = createDeferred();
      const dispatched = createDeferred();
      let nativeRunId: string | undefined;
      const agentResponse = vi.fn();
      const runtimeGate = vi
        .spyOn(preparedModelRuntime, "loadPublishedGatewayReplyDispatchRuntime")
        .mockImplementation(async ({ abortSignal }) => {
          const signal = expectDefined(abortSignal, "native admission abort signal");
          signal.throwIfAborted();
          entered.resolve();
          return await new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                const reason: unknown = signal.reason;
                reject(reason instanceof Error ? reason : new Error("Native admission aborted"));
              },
              { once: true },
            );
          });
        });
      spawnTesting.setDepsForTest({
        hasInProcessGatewayContext: () => true,
        dispatchGatewayMethodInProcess: async <T>(
          method: string,
          params: Record<string, unknown>,
          options?: Parameters<typeof dispatchGatewayMethodInProcess>[2],
        ) => {
          const respond = method === "agent" ? agentResponse : vi.fn();
          const request = {
            req: { type: "req" as const, id: "native-preaccept", method },
            params,
            respond,
            context,
            client: createSyntheticPluginRuntimeClient({
              agentRunTracking: options?.agentRunTracking,
              scopes: options?.syntheticScopes,
            }),
            isWebchatConnect: () => false,
          };
          if (method === "agent") {
            nativeRunId = String(params.idempotencyKey);
            try {
              await agentRunHandler!(request);
            } finally {
              dispatched.resolve();
            }
          } else if (method === "chat.abort") {
            await handleChatAbortRequest(request);
          } else {
            throw new Error(`Unexpected native cleanup method ${method}`);
          }
          const [ok, payload, error] = respond.mock.calls[0] ?? [];
          if (!ok) {
            throw new Error(`Native Gateway request failed: ${JSON.stringify(error)}`);
          }
          return payload as T;
        },
      });
      try {
        const spawned = await spawnSubagentDirect(
          {
            task: "Do not execute before cancellation",
            label: "Pending native collector",
            collect: true,
            context: "isolated",
            lightContext: true,
          },
          {
            agentSessionKey: parentKey,
            requesterRunId: "parent-turn",
            requesterTurnRunId: "parent-turn",
          },
        );
        expect(spawned.status).toBe("accepted");
        await Promise.race([
          entered.promise,
          dispatched.promise.then(() => {
            throw new Error(
              `Native admission ended before runtime gate: ${JSON.stringify(agentResponse.mock.calls)}`,
            );
          }),
        ]);
        const entry = expectDefined(subagentRuns.get(spawned.runId!), "pending native collector");
        const admission = expectDefined(
          context.chatAbortControllers.get(entry.runId),
          "real native controller",
        );
        expect(admission.kind).toBe("agent");
        expect(admission.executionStarted).toBe(false);
        expect(getAgentRunContext(entry.runId)).toBeDefined();
        expect(isSubagentRunQueued(entry)).toBe(true);
        expect(
          resolveVisibleActiveSessionRunState({
            context,
            requestedKey: entry.childSessionKey,
            canonicalKey: entry.childSessionKey,
          }).status,
        ).toBeUndefined();
        const releaseCapacityWait = registerAgentRunCapacityWait(
          entry.runId,
          getAgentRunLifecycleGeneration(),
        );
        try {
          expect(
            resolveVisibleActiveSessionRunState({
              context,
              requestedKey: entry.childSessionKey,
              canonicalKey: entry.childSessionKey,
            }).status,
          ).toBe("queued");
        } finally {
          releaseCapacityWait?.();
        }
        expect(entry.execution.startedAt).toBeUndefined();
        const respond = vi.fn();
        await sessionAbortHandlers["sessions.abort"]!({
          req: { type: "req", id: "stop-native-preaccept", method: "sessions.abort" },
          params: {
            key: entry.childSessionKey,
            ...(exact ? { runId: entry.runId } : { clearQueued: true }),
          },
          context,
          respond,
          client: operatorClient(),
          isWebchatConnect: () => false,
        });
        await dispatched.promise;
        await vi.waitFor(() => expect(entry.collectorCompletion?.status).toBe("killed"));
        expect
          .soft(respond.mock.calls[0]?.slice(0, 2))
          .toEqual([true, { ok: true, status: "aborted", abortedRunId: entry.runId }]);
        expect.soft(context.chatRunState.hasAbortMarker(entry.runId)).toBe(true);
        expect.soft(admission.abortStopReason).toBe("rpc");
        expect.soft(entry.execution.startedAt).toBeUndefined();
        expect.soft(entry.sessionStartedAt).toBeUndefined();
        expect(context.chatAbortControllers.has(entry.runId)).toBe(false);
      } finally {
        if (nativeRunId) {
          context.chatAbortControllers.get(nativeRunId)?.controller.abort();
          await dispatched.promise;
          clearAgentRunContext(nativeRunId);
        }
        runtimeGate.mockRestore();
      }
    },
  );
});
