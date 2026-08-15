// Codex composed native hook relay retention regression.
import path from "node:path";
import {
  invokeNativeHookRelay,
  nativeHookRelayTesting,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createAdmittedHostCapabilityTestFixture,
  createMockPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import type { CodexServerNotification } from "./protocol.js";
import {
  createParams,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  extractRelayIdFromThreadRequest,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt native hook relay retention", () => {
  it.each([
    {
      name: "Codex multi-agent V1",
      bindBeforeClaim: false,
      hasDeliveryScope: true,
      childThreadId: "child-v1",
      childClaim: {
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "thread-1",
        receiverThreadIds: ["child-v1"],
      },
    },
    {
      name: "Codex multi-agent V2",
      bindBeforeClaim: true,
      hasDeliveryScope: true,
      childThreadId: "child-v2",
      childClaim: {
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "child-v2",
        agentPath: "/root/child-v2",
      },
    },
    {
      name: "Codex multi-agent V2 without delivery scope",
      bindBeforeClaim: true,
      hasDeliveryScope: false,
      childThreadId: "child-v2-no-delivery",
      childClaim: {
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "child-v2-no-delivery",
        agentPath: "/root/child-v2-no-delivery",
      },
    },
  ] as const)(
    "retains and fences a live child through sessions_yield ($name)",
    async ({ bindBeforeClaim, hasDeliveryScope, childThreadId, childClaim }) => {
      const sessionFile = path.join(tempDir, `${childThreadId}-yield-session.jsonl`);
      const workspaceDir = path.join(tempDir, `${childThreadId}-yield-workspace`);
      let resolveTurnStart: ((value: undefined) => void) | undefined;
      const deferredTurnStart = new Promise<undefined>((resolve) => {
        resolveTurnStart = resolve;
      });
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "turn/start") {
          return await deferredTurnStart;
        }
        return undefined;
      });
      const params = createParams(sessionFile, workspaceDir);
      params.disableTools = false;
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.onAgentEvent = vi.fn();
      setCodexTestModelSupportsTools(params, true);
      const fixture = await createAdmittedHostCapabilityTestFixture(params);
      params.hostCapabilities = fixture.hostCapabilities;
      if (hasDeliveryScope) {
        params.agentHarnessTaskRuntimeScope = fixture.agentHarnessTaskRuntimeScope;
      }

      const beforeToolCall = vi.fn(async (event: unknown) =>
        (event as { params?: { command?: string } }).params?.command === "deny-child"
          ? { block: true, blockReason: "child policy denied" }
          : undefined,
      );
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
      );

      const run = runCodexAppServerAttempt(params, {
        nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
      });
      let relayId: string | undefined;
      try {
        await harness.waitForMethod("turn/start");
        if (bindBeforeClaim) {
          resolveTurnStart?.(undefined);
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
        const startRequest = harness.requests.find((request) => request.method === "thread/start");
        relayId = extractRelayIdFromThreadRequest(startRequest?.params);
        const preDiscoveryPayload = {
          hook_event_name: "PreToolUse",
          agent_id: childThreadId,
          cwd: workspaceDir,
          tool_name: "Bash",
          tool_use_id: `${childThreadId}-pre-discovery`,
          tool_input: { command: "allow-child" },
        };
        let firstPendingSettled = false;
        const firstPending = invokeNativeHookRelay({
          provider: "codex",
          relayId,
          event: "pre_tool_use",
          rawPayload: preDiscoveryPayload,
        }).finally(() => {
          firstPendingSettled = true;
        });
        const duplicatePending = invokeNativeHookRelay({
          provider: "codex",
          relayId,
          event: "pre_tool_use",
          rawPayload: { ...preDiscoveryPayload, tool_use_id: `${childThreadId}-pre-discovery-2` },
        });
        await Promise.resolve();
        expect(firstPendingSettled).toBe(false);
        expect(beforeToolCall).not.toHaveBeenCalled();
        const terminalChildThreadId = `${childThreadId}-terminal-before-claim`;
        const terminalPending = invokeNativeHookRelay({
          provider: "codex",
          relayId,
          event: "pre_tool_use",
          rawPayload: { ...preDiscoveryPayload, agent_id: terminalChildThreadId },
        });
        await harness.notify({
          method: "thread/started",
          params: {
            thread: {
              id: terminalChildThreadId,
              parentThreadId: "thread-1",
              source: {
                subAgent: {
                  thread_spawn: { parent_thread_id: "thread-1", depth: 1 },
                },
              },
            },
          },
        } as CodexServerNotification);
        await harness.notify({
          method: "turn/completed",
          params: {
            threadId: terminalChildThreadId,
            turn: {
              id: `${terminalChildThreadId}-turn`,
              status: "completed",
              items: [],
              itemsView: "full",
              error: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
            },
          },
        } as CodexServerNotification);
        await expect(terminalPending).rejects.toThrow("Codex child turn completed");
        await harness.notify({
          method: "thread/started",
          params: {
            thread: {
              id: childThreadId,
              parentThreadId: "thread-1",
              source: {
                subAgent: {
                  thread_spawn: { parent_thread_id: "thread-1", depth: 1 },
                },
              },
            },
          },
        } as CodexServerNotification);
        if (childClaim.type === "collabAgentToolCall") {
          await harness.notify({
            method: "item/completed",
            params: { threadId: "thread-1", turnId: "wrong-turn", item: childClaim },
          } as unknown as CodexServerNotification);
          await harness.notify({
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: { ...childClaim, status: "failed" },
            },
          } as unknown as CodexServerNotification);
          await Promise.resolve();
          expect(firstPendingSettled).toBe(false);
          expect(beforeToolCall).not.toHaveBeenCalled();
        } else {
          await harness.notify({
            method: "item/completed",
            params: { threadId: "thread-1", turnId: "wrong-turn", item: childClaim },
          } as unknown as CodexServerNotification);
          await Promise.resolve();
          expect(firstPendingSettled).toBe(false);
          expect(beforeToolCall).not.toHaveBeenCalled();
        }
        await harness.notify({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: childClaim,
          },
        } as unknown as CodexServerNotification);
        // Cover both exact-turn admission paths: an already-bound owner and
        // evidence buffered before turn/start responds.
        if (!bindBeforeClaim) {
          resolveTurnStart?.(undefined);
        }
        await expect(Promise.all([firstPending, duplicatePending])).resolves.toEqual([
          { stdout: "", stderr: "", exitCode: 0 },
          { stdout: "", stderr: "", exitCode: 0 },
        ]);
        expect(beforeToolCall).toHaveBeenCalledTimes(2);

        const yieldResponse = await harness.handleServerRequest({
          id: "request-sessions-yield",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: `yield-${childThreadId}`,
            namespace: null,
            tool: "sessions_yield",
            arguments: { message: "Waiting for child" },
          },
        });
        expect(yieldResponse).toMatchObject({ success: true, contentItems: expect.any(Array) });

        // The app-server response intentionally exposes only protocol content; the internal
        // terminate marker schedules the turn release on the next macrotask.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        const result = await run;
        expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, promptError: null });
        expect(result.runtimeContinuationStarted).toBe(hasDeliveryScope ? true : undefined);
        const terminalLifecycleEvents = (params.onAgentEvent as ReturnType<typeof vi.fn>).mock.calls
          .map(([event]) => event as { stream?: string; data?: Record<string, unknown> })
          .filter(
            (event) =>
              event.stream === "lifecycle" &&
              (event.data?.phase === "end" || event.data?.phase === "error"),
          );
        expect(terminalLifecycleEvents).toHaveLength(1);
        expect(terminalLifecycleEvents[0]?.data).toMatchObject({
          phase: "end",
          yielded: true,
          livenessState: "paused",
          stopReason: "end_turn",
        });
        expect(
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId),
        ).toBeDefined();
        fixture.closeHost();
        fixture.closeAdmission();
        await expect(
          invokeNativeHookRelay({
            provider: "codex",
            relayId,
            event: "pre_tool_use",
            rawPayload: {
              agent_id: childThreadId,
              tool_name: "Bash",
              tool_input: { command: "allow-child" },
            },
          }),
        ).resolves.toMatchObject({ exitCode: 0 });
        const denied = await invokeNativeHookRelay({
          provider: "codex",
          relayId,
          event: "pre_tool_use",
          rawPayload: {
            agent_id: childThreadId,
            tool_name: "Bash",
            tool_input: { command: "deny-child" },
          },
        });
        expect(JSON.parse(denied.stdout)).toMatchObject({
          hookSpecificOutput: {
            permissionDecision: "deny",
            permissionDecisionReason: "child policy denied",
          },
        });
        expect(beforeToolCall).toHaveBeenCalledTimes(5);
        expect(
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId),
        ).toBeDefined();
        for (const agentId of ["unknown-child", `${childThreadId}/nested`]) {
          await expect(
            invokeNativeHookRelay({
              provider: "codex",
              relayId,
              event: "pre_tool_use",
              rawPayload: { agent_id: agentId, tool_name: "Bash", tool_input: {} },
            }),
          ).rejects.toThrow(/not found|inactive|retained invocation/);
        }

        const childTerminal = {
          method: "turn/completed",
          params: {
            threadId: childThreadId,
            turn: {
              id: `${childThreadId}-turn`,
              status: "completed",
              items: [],
              itemsView: "full",
              error: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
            },
          },
        } as CodexServerNotification;
        await harness.notify(childTerminal);
        nativeHookRelayUnregisterQueue.flush();
        expect(
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId),
        ).toBeUndefined();
        await expect(
          invokeNativeHookRelay({
            provider: "codex",
            relayId,
            event: "pre_tool_use",
            rawPayload: {
              agent_id: childThreadId,
              tool_name: "Bash",
              tool_input: { command: "allow-child" },
            },
          }),
        ).rejects.toThrow(/not found|inactive/);
      } finally {
        fixture.closeHost();
        fixture.closeAdmission();
      }
    },
  );

  it("revokes a claimed child when the parent fails after sessions_yield", async () => {
    const childThreadId = "child-failed-parent";
    const sessionFile = path.join(tempDir, `${childThreadId}-session.jsonl`);
    const workspaceDir = path.join(tempDir, `${childThreadId}-workspace`);
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);
    const fixture = await createAdmittedHostCapabilityTestFixture(params);
    params.hostCapabilities = fixture.hostCapabilities;

    const beforeToolCall = vi.fn(async () => undefined);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );

    const run = runCodexAppServerAttempt(params, {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });
    try {
      await harness.waitForMethod("turn/start");
      const startRequest = harness.requests.find((request) => request.method === "thread/start");
      const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
      await harness.notify({
        method: "thread/started",
        params: {
          thread: {
            id: childThreadId,
            parentThreadId: "thread-1",
            source: {
              subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 1 } },
            },
          },
        },
      } as CodexServerNotification);
      await harness.notify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "thread-1",
            receiverThreadIds: [childThreadId],
          },
        },
      } as unknown as CodexServerNotification);
      const childPayload = {
        hook_event_name: "PreToolUse",
        agent_id: childThreadId,
        cwd: workspaceDir,
        tool_name: "Bash",
        tool_use_id: `${childThreadId}-tool`,
        tool_input: { command: "allow-child" },
      };
      await expect(
        invokeNativeHookRelay({
          provider: "codex",
          relayId,
          event: "pre_tool_use",
          rawPayload: childPayload,
        }),
      ).resolves.toMatchObject({ exitCode: 0 });
      expect(beforeToolCall).toHaveBeenCalledOnce();

      await expect(
        harness.handleServerRequest({
          id: "request-sessions-yield-before-failure",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "yield-before-failure",
            namespace: null,
            tool: "sessions_yield",
            arguments: { message: "Waiting for child" },
          },
        }),
      ).resolves.toMatchObject({ success: true });
      await harness.notify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "failed",
            error: { message: "parent failed after yielding" },
          },
        },
      } as CodexServerNotification);

      const result = await run;
      expect(readAttemptTerminal(result).promptError).toContain("parent failed after yielding");
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId),
      ).toBeUndefined();
      await expect(
        invokeNativeHookRelay({
          provider: "codex",
          relayId,
          event: "pre_tool_use",
          rawPayload: childPayload,
        }),
      ).rejects.toThrow(/not found|inactive/);
    } finally {
      fixture.closeHost();
      fixture.closeAdmission();
    }
  });
});
