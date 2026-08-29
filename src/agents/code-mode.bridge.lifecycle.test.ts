/** Subscribed embedded tool lifecycles, including real QuickJS bridge coverage. */
import { getEventListeners } from "node:events";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { composeTranscriptDisplay } from "../chat/transcript-display-position.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { estimateTranscriptPromptTokens } from "../config/sessions/session-accessor.sqlite-parent-fork.js";
import { projectChatDisplayMessages } from "../gateway/chat-display-projection.js";
import { readSessionMessagesAsync } from "../gateway/session-transcript-readers.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import { buildExecApprovalPendingToolResult } from "./bash-tools.exec-host-shared.js";
import { disposeAllCodeModeRuns } from "./code-mode-state.js";
import { createSubscribedCodeModeHarness } from "./code-mode.bridge.lifecycle.test-support.js";
import { addClientToolsToCodeModeCatalog, applyCodeModeCatalog } from "./code-mode.js";
import {
  fakeTool,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  runUntilCompleted,
  testing,
} from "./code-mode.test-support.js";
import { buildEmbeddedRunPayloads } from "./embedded-agent-runner/run/payloads.js";
import { emitAssistantTextDeltaAndEnd } from "./embedded-agent-subscribe.e2e-harness.js";
import { countActiveToolExecutions } from "./embedded-agent-subscribe.handlers.tools.js";
import { attachInternalToolExecutionPreparer } from "./runtime/internal-hooks.js";
import { SessionManager } from "./sessions/session-manager.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import { jsonResult } from "./tools/common.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Code Mode subscribed bridge lifecycle", () => {
  afterEach(() => resetCodeModeTestState());

  it("observes output rejection as the single nested terminal failure", async () => {
    const harness = createSubscribedCodeModeHarness({ name: "output-rejection" });
    const target = pluginToolWithExecute("lookup", "Look up a record", async () =>
      jsonResult({ rejected: true }),
    );
    try {
      await expect(
        harness.executeTool({
          tool: target,
          toolName: target.name,
          source: "openclaw",
          toolCallId: "nested-output-rejection",
          parentToolCallId: "outer-exec",
          input: {},
          acceptResultBeforeProjection: async () => {
            throw new Error("declared output mismatch");
          },
        }),
      ).rejects.toThrow("declared output mismatch");
      expect(harness.subscription.toolMetas).toEqual([
        expect.objectContaining({ toolName: "lookup", isError: true }),
      ]);
      expect(harness.subscription.getItemLifecycle()).toMatchObject({
        startedCount: 1,
        completedCount: 1,
        activeCount: 0,
      });
    } finally {
      harness.dispose();
    }
  });

  it("persists concurrent nested starts in order across wait without changing replay or pairing", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(42);
    const dir = tempDirs.make("nested-tool-history-");
    const scope = {
      agentId: "main",
      sessionId: "nested-history",
      sessionKey: "agent:main:nested-history",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(scope, dir);
    const harness = createSubscribedCodeModeHarness({
      name: "nested-history",
      sessionManager: manager,
    });
    const firstStarted = createDeferred();
    const finishFirst = createDeferred();
    const ids = [1, 2, 3].map((index) => `tool_search_code:exec|fc-original:read:${index}`);
    const target = pluginToolWithExecute("read", "Read a record", async (id) => {
      if (id === ids[0]) {
        firstStarted.resolve();
        await finishFirst.promise;
      }
      return jsonResult({ text: "same result" });
    });
    const call = (index: number, executeTool = harness.executeTool) =>
      executeTool({
        tool: target,
        toolName: "read",
        source: "openclaw",
        toolCallId: expectDefined(ids[index], "nested invocation id"),
        parentToolCallId: "exec|fc-original",
        input: { path: "repeat-proof.txt" },
        acceptResultBeforeProjection: async (result) => result,
      });
    const appendCall = (name: string) =>
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: name, name, arguments: {} }],
        stopReason: "toolUse",
        timestamp: Date.now(),
      } as never);
    const appendResult = (name: string) =>
      manager.appendMessage({
        role: "toolResult",
        toolCallId: name,
        toolName: name,
        content: [{ type: "text", text: "done" }],
        isError: false,
        timestamp: Date.now(),
      });
    try {
      manager.appendMessage({ role: "user", content: "Read three times", timestamp: 1 });
      appendCall("exec");
      const first = call(0);
      await firstStarted.promise;
      await call(1);
      finishFirst.resolve();
      await first;
      expect(
        manager.buildSessionContext().messages.some((message) => message.role === "toolResult"),
      ).toBe(false);
      appendResult("exec");
      appendCall("wait");
      await call(2);
      appendResult("wait");
      const reopened = SessionManager.open(scope, dir);
      const messages = reopened
        .getBranch()
        .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
      const activities = messages.filter((message) => message.role === "custom");
      expect(activities).toHaveLength(3);
      expect(harness.nestedToolActivities.map(({ details }) => details.runId)).toEqual([
        harness.runId,
        harness.runId,
        harness.runId,
      ]);
      const history = await readSessionMessagesAsync(scope, {
        mode: "full",
        reason: "nested activity lifecycle proof",
      });
      const calls = composeTranscriptDisplay(projectChatDisplayMessages(history))
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .filter((block) => block.type === "toolCall");
      expect(calls.map((block) => block.name)).toEqual(["exec", "read", "read", "wait", "read"]);
      expect(calls.filter((block) => block.name === "read").map((block) => block.id)).toEqual(ids);
      expect(calls.filter((block) => block.name === "read")).toEqual(
        ids.map((id) =>
          expect.objectContaining({
            id,
            runId: harness.runId,
            parentToolCallId: "exec|fc-original",
            timestamp: 42,
          }),
        ),
      );
      const replay = reopened.buildSessionContext().messages;
      expect(replay.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
        "assistant",
        "toolResult",
      ]);
      const bounded = SessionManager.openBounded(scope, { maxEvents: 4, maxBytes: 4096 });
      expect(bounded.buildSessionContext().messages).toEqual(replay.slice(-4));
      const events = reopened.getPersistedEntries();
      expect(estimateTranscriptPromptTokens(events)).toEqual(
        estimateTranscriptPromptTokens(
          events.filter(
            (event) =>
              !(event as { message?: { excludeFromContext?: boolean } }).message
                ?.excludeFromContext,
          ),
        ),
      );
      harness.emit({
        type: "compaction_end",
        reason: "overflow",
        outcome: { status: "completed", tokensBefore: 100, tokensAfter: 50, willRetry: true },
      });
      await harness.subscription.waitForPendingEvents();
      expect(harness.subscription.toolMetas).toEqual([]);
      expect(harness.nestedToolActivities.map(({ details }) => details.toolName)).toEqual([
        "read",
        "read",
        "read",
      ]);
      const other = createSubscribedCodeModeHarness({
        name: "reused-child",
        sessionManager: manager,
      });
      try {
        await call(0, other.executeTool);
        const repeated = projectChatDisplayMessages(
          await readSessionMessagesAsync(scope, {
            mode: "full",
            reason: "reused child identity proof",
          }),
        )
          .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
          .filter((block) => block.type === "toolCall" && block.id === ids[0]);
        expect(repeated.map((block) => block.runId)).toEqual([harness.runId, other.runId]);
      } finally {
        other.dispose();
      }
    } finally {
      finishFirst.resolve();
      harness.dispose();
      clock.mockRestore();
    }
  });

  it("aborts promptly while a terminal observer stalls and disposes preparation once", async () => {
    const observing = createDeferred();
    const release = createDeferred();
    const dispose = vi.fn();
    const harness = createSubscribedCodeModeHarness({
      name: "stalled-terminal",
      onToolStreamBoundary: async () => {
        observing.resolve();
        await release.promise;
      },
    });
    const target = pluginToolWithExecute("read", "Read a record", async () =>
      jsonResult({ ok: true }),
    );
    attachInternalToolExecutionPreparer(target, async () => ({
      kind: "ready",
      args: {},
      dispose,
      execute: async (start) => {
        start?.();
        return jsonResult({ ok: true });
      },
    }));
    try {
      const pending = harness.executeTool({
        tool: target,
        toolName: "read",
        source: "openclaw",
        toolCallId: "stalled-terminal",
        input: {},
        acceptResultBeforeProjection: async (result) => result,
      });
      await observing.promise;
      harness.runAbortController.abort();
      await expect(pending).rejects.toThrow("Aborted");
      expect(dispose).toHaveBeenCalledOnce();
      release.resolve();
      await harness.subscription.waitForPendingEvents();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      harness.dispose();
    }
  });

  it.each([
    { approval: "unavailable", outcome: "recovery" },
    { approval: "unavailable", outcome: "error" },
    { approval: "pending", outcome: "recovery" },
    { approval: "pending", outcome: "rejected-notice" },
  ] as const)(
    "preserves $outcome delivery after a nested $approval approval notice",
    async ({ approval, outcome }) => {
      const onToolResult = vi.fn();
      const onPartialReply = vi.fn();
      const onBlockReply = vi.fn();
      const harness = createSubscribedCodeModeHarness({
        name: `approval-${approval}-${outcome}`,
        onToolResult,
        onPartialReply,
        onBlockReply,
      });
      let unavailable = approval === "unavailable";
      const shell = pluginToolWithExecute("exec", "Run shell", async () =>
        buildExecApprovalPendingToolResult({
          host: "gateway",
          command: "review weekly pull requests",
          cwd: "/tmp/work",
          warningText: "",
          approvalId: "12345678-1234-1234-1234-123456789012",
          approvalSlug: "12345678",
          expiresAtMs: Date.now() + 60_000,
          initiatingSurface: { kind: "disabled", channel: "discord", channelLabel: "Discord" },
          sentApproverDms: false,
          unavailableReason: unavailable ? "initiating-platform-disabled" : null,
        }),
      );
      const browser = pluginToolWithExecute("browser", "Read pull requests", async () =>
        jsonResult({ pullRequests: [123] }),
      );
      // Exercise the executor used by hidden Code Mode calls without a worker-startup deadline.
      const callNestedTool = (tool: typeof shell, toolCallId: string) =>
        harness.executeTool({
          tool,
          toolName: tool.name,
          source: "openclaw",
          sourceName: "fixture-plugin",
          toolCallId,
          parentToolCallId: `code-${toolCallId}`,
          input: {},
          acceptResultBeforeProjection: async (result) => result,
        });

      try {
        await callNestedTool(shell, "approval");
        expect(onToolResult).toHaveBeenCalledOnce();
        expect(onToolResult.mock.calls[0]?.[0].text).toContain(
          approval === "pending" ? "/approve 12345678" : "not configured on Discord",
        );

        if (outcome === "rejected-notice") {
          unavailable = true;
          onToolResult.mockRejectedValueOnce(new Error("notice delivery failed"));
          await callNestedTool(shell, "unavailable");
          expect(onToolResult).toHaveBeenCalledTimes(2);
        }

        const answer = "I found PR #123 in last week's channel messages.";
        if (outcome !== "error") {
          const recovered = await callNestedTool(browser, "recovery");
          expect(recovered.details).toEqual({ pullRequests: [123] });
          expect(browser.execute).toHaveBeenCalledOnce();
          harness.emit({ type: "message_start", message: { role: "assistant", content: [] } });
          emitAssistantTextDeltaAndEnd({ emit: harness.emit, text: answer });
        } else {
          harness.emit({
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "rate limit exceeded",
            },
          });
        }
        harness.emit({ type: "agent_end", messages: [], willRetry: false });
        await harness.subscription.waitForPendingEvents();

        const payloads = buildEmbeddedRunPayloads({
          assistantTexts: harness.subscription.assistantTexts,
          lastAssistant: harness.subscription.getCurrentAttemptAssistant(),
          lastToolError: harness.subscription.getLastToolError(),
          sessionKey: harness.sessionKey,
          didSendDeterministicApprovalPrompt:
            harness.subscription.didSendDeterministicApprovalPrompt(),
        });
        if (approval === "pending") {
          expect(onPartialReply).not.toHaveBeenCalled();
          expect(onBlockReply).not.toHaveBeenCalled();
          expect(payloads).not.toContainEqual(expect.objectContaining({ text: answer }));
          if (outcome === "recovery") {
            expect(payloads).toEqual([]);
          }
        } else if (outcome === "recovery") {
          expect(onPartialReply).toHaveBeenCalledWith(expect.objectContaining({ text: answer }));
          expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual([answer]);
          expect(payloads).toEqual([expect.objectContaining({ text: answer })]);
        } else {
          expect(payloads).toEqual([
            expect.objectContaining({ isError: true, text: expect.stringMatching(/rate limit/i) }),
          ]);
        }
      } finally {
        harness.dispose();
      }
    },
  );

  it("starts a subscribed nested tool without re-entering its outer presentation flush", async () => {
    const blockReplyFlush = createDeferred();
    const onBlockReplyFlush = vi.fn(() => blockReplyFlush.promise);
    const harness = createSubscribedCodeModeHarness({ name: "circular-flush", onBlockReplyFlush });
    const target = pluginToolWithExecute("release_flush", "Release the pending reply", async () => {
      blockReplyFlush.resolve();
      return jsonResult({ released: true });
    });
    applyCodeModeCatalog({ ...harness, tools: [...harness.tools, target] });

    try {
      const result = await runUntilCompleted({
        execTool: expectDefined(harness.tools[0], "Code Mode exec test invariant"),
        waitTool: expectDefined(harness.tools[1], "Code Mode wait test invariant"),
        code: "return await release_flush({});",
      });

      expect(result.status, JSON.stringify(result)).toBe("completed");
      expect(result.value).toEqual({ released: true });
      expect(target.execute).toHaveBeenCalledOnce();
      expect(onBlockReplyFlush).not.toHaveBeenCalled();
      expect(harness.subscription.getItemLifecycle()).toMatchObject({
        startedCount: 1,
        completedCount: 1,
        activeCount: 0,
      });
      expect(countActiveToolExecutions(harness.runId)).toBe(0);
      expect(testing.activeRuns.size).toBe(0);
    } finally {
      blockReplyFlush.resolve();
      harness.dispose();
    }
  });

  it("settles subscribed nested dispatch exactly once across repeated exec and wait turns", async () => {
    const blockReplyFlush = createDeferred();
    const onBlockReplyFlush = vi.fn(() => blockReplyFlush.promise);
    const harness = createSubscribedCodeModeHarness({
      name: "repeated-lifecycle",
      onBlockReplyFlush,
    });
    const target = pluginToolWithExecute("finish_stage", "Finish one suspended stage", async () => {
      blockReplyFlush.resolve();
      return jsonResult({ finished: true });
    });
    applyCodeModeCatalog({ ...harness, tools: [...harness.tools, target] });

    try {
      for (let stage = 0; stage < 2; stage += 1) {
        const suspended = resultDetails(
          await expectDefined(harness.tools[0], "Code Mode exec test invariant").execute(
            `code-call-stage-${stage}`,
            { code: 'await yield_control("pause"); return await finish_stage({});' },
          ),
        );
        expect(suspended).toMatchObject({ status: "waiting", reason: "yield" });

        const completed = resultDetails(
          await expectDefined(harness.tools[1], "Code Mode wait test invariant").execute(
            `code-wait-stage-${stage}`,
            { runId: suspended.runId },
          ),
        );
        expect(completed).toMatchObject({ status: "completed", value: { finished: true } });
        expect(countActiveToolExecutions(harness.runId)).toBe(0);
      }

      expect(target.execute).toHaveBeenCalledTimes(2);
      expect(onBlockReplyFlush).not.toHaveBeenCalled();
      expect(harness.subscription.getItemLifecycle()).toMatchObject({
        startedCount: 2,
        completedCount: 2,
        activeCount: 0,
      });
      expect(testing.activeRuns.size).toBe(0);
    } finally {
      blockReplyFlush.resolve();
      harness.dispose();
    }
  });

  it("keeps direct sessions_yield handoff successful while closing sibling Code Mode cells", async () => {
    const harness = createSubscribedCodeModeHarness({ name: "yield-handoff" });
    const handoffReason = { code: "sessions_yield", turnHandoff: true } as const;
    const onYield = vi.fn(() => harness.runAbortController.abort(handoffReason));
    const target = wrapToolWithAbortSignal(
      createSessionsYieldTool({
        sessionId: harness.sessionId,
        claimYield: () => true,
        onYield,
      }),
      harness.runAbortController.signal,
    );
    const surface = applyCodeModeCatalog({ ...harness, tools: [...harness.tools, target] });
    try {
      const parked = resultDetails(
        await harness.tools[0]!.execute("sibling-cell", {
          code: "await yield_control(); return 'unreachable';",
        }),
      );
      expect(parked.status).toBe("waiting");
      expect(
        harness.catalogRef.current?.entries.some((entry) => entry.name === "sessions_yield"),
      ).toBe(false);
      const direct = expectDefined(
        surface.tools.find((tool) => tool.name === "sessions_yield"),
        "direct handoff tool",
      );
      expect(resultDetails(await direct.execute("yield-handoff", {}))).toMatchObject({
        status: "yielded",
      });
      expect(onYield).toHaveBeenCalledOnce();
      expect(testing.activeRuns.size).toBe(0);
      await expect(
        harness.tools[1]!.execute("closed-sibling", { runId: parked.runId }),
      ).rejects.toThrow(/unavailable|expired/);
    } finally {
      harness.dispose();
    }
  });

  it.each(["context", "tool", "catalog"] as const)(
    "releases only the parked owner after %s abort without wait",
    async (signalSource) => {
      const owner = createSubscribedCodeModeHarness({ name: `parked-${signalSource}` });
      const survivor = createSubscribedCodeModeHarness({ name: `survivor-${signalSource}` });
      const toolAbortController = new AbortController();
      const controller =
        signalSource === "context" ? owner.runAbortController : toolAbortController;
      const code = 'setTimeout(() => {}, 60_000); await yield_control("pause"); return "done";';
      applyCodeModeCatalog(owner);
      applyCodeModeCatalog(survivor);

      try {
        const parked = resultDetails(
          await expectDefined(owner.tools[0], "owner exec").execute(
            "code-call-parked",
            { code },
            signalSource === "tool" ? toolAbortController.signal : undefined,
          ),
        );
        const other = resultDetails(
          await expectDefined(survivor.tools[0], "survivor exec").execute("code-call-survivor", {
            code,
          }),
        );
        for (const result of [parked, other]) {
          expect(result).toMatchObject({ status: "waiting", runId: expect.any(String) });
        }
        const ownerId = parked.runId as string;
        const survivorId = other.runId as string;
        const ownerState = expectDefined(testing.activeRuns.get(ownerId), "parked owner snapshot");
        const survivorState = expectDefined(
          testing.activeRuns.get(survivorId),
          "survivor snapshot",
        );
        const pending = expectDefined(
          ownerState.pending.find((entry) => entry.method === "sleep"),
          "owner timer",
        );
        const otherPending = expectDefined(
          survivorState.pending.find((entry) => entry.method === "sleep"),
          "survivor timer",
        );
        expect(pending.settled).toBeUndefined();
        expect(otherPending.settled).toBeUndefined();
        expect(ownerState.snapshotBytes.byteLength).toBeGreaterThan(0);
        expect(testing.resumingRunIds.size).toBe(0);

        // Both exec calls have returned; no wait is in flight to perform owner cleanup.
        if (signalSource === "catalog") {
          clearToolSearchCatalog(owner);
        } else {
          controller.abort(new Error("parked owner closed"));
        }
        expect([...testing.activeRuns.keys()]).toEqual([survivorId]);
        await expect(pending.promise).resolves.toMatchObject({ id: pending.id, ok: false });
        expect(testing.activeRuns.get(survivorId)).toBe(survivorState);
        expect(otherPending.settled).toBeUndefined();
      } finally {
        owner.dispose();
        survivor.dispose();
      }
    },
  );

  it.each(["complete", "context", "tool", "catalog"] as const)(
    "transfers parked ownership across refresh and repeated resumes before %s",
    async (close) => {
      const owner = createSubscribedCodeModeHarness({ name: `transfer-${close}` });
      applyCodeModeCatalog(owner);
      const exec = expectDefined(owner.tools[0], "owner exec");
      const wait = expectDefined(owner.tools[1], "owner wait");
      let controller = new AbortController();
      try {
        let result = resultDetails(
          await exec.execute(
            "transfer-exec",
            {
              code: `await yield_control("first");
                await yield_control("second");
                await yield_control("third");
                return "done";`,
            },
            controller.signal,
          ),
        );
        expect(result.status).toBe("waiting");
        const runId = result.runId as string;
        const initial = expectDefined(testing.activeRuns.get(runId), "initial snapshot");
        expect(applyCodeModeCatalog(owner).catalogReused).toBe(true);
        addClientToolsToCodeModeCatalog({
          ...owner,
          tools: [fakeTool("client_probe", "Client probe")],
        });
        expect(testing.activeRuns.get(runId)).toBe(initial);
        expect(exec.description).toContain("client_probe");

        for (let index = 0; index < 2; index += 1) {
          const previous = expectDefined(testing.activeRuns.get(runId), "previous snapshot");
          const previousController = controller;
          controller = new AbortController();
          result = resultDetails(
            await wait.execute(`transfer-wait-${index}`, { runId }, controller.signal),
          );
          expect(result).toMatchObject({ status: "waiting", runId });
          const replacement = expectDefined(testing.activeRuns.get(runId), "replacement snapshot");
          expect(replacement).not.toBe(previous);
          previousController.abort();
          expect(testing.activeRuns.get(runId)).toBe(replacement);
          expect(replacement.owner).toBe(previous.owner);
          expect(replacement.owner.signal.aborted).toBe(false);
          expect(owner.catalogRef.onDispose?.size).toBe(1);
        }

        const finalState = expectDefined(testing.activeRuns.get(runId), "final snapshot");
        const pending = finalState.pending;
        if (close === "complete") {
          expect(resultDetails(await wait.execute("transfer-complete", { runId }))).toMatchObject({
            status: "completed",
            value: "done",
          });
        } else if (close === "catalog") {
          clearToolSearchCatalog(owner);
        } else {
          (close === "context" ? owner.runAbortController : controller).abort();
        }
        expect(testing.activeRuns.size).toBe(0);
        expect(testing.resumingRunIds.size).toBe(0);
        await Promise.all(pending.map((entry) => entry.promise));
        expect(getEventListeners(finalState.owner.signal, "abort")).toHaveLength(0);
        expect(finalState.owner.signal.aborted).toBe(true);
        expect(owner.catalogRef.onDispose?.size ?? 0).toBe(0);
      } finally {
        clearToolSearchCatalog(owner);
        owner.dispose();
      }
    },
  );

  it.each(["exec", "wait"] as const)(
    "does not publish a snapshot after its catalog closes during %s",
    async (phase) => {
      // Worker startup must not consume the host budget before close_owner dispatches.
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const owner = createSubscribedCodeModeHarness({ name: `close-during-${phase}` });
      const closeOwner = pluginToolWithExecute("close_owner", "Close the run catalog", async () => {
        clearToolSearchCatalog(owner);
        return jsonResult({ closed: true });
      });
      applyCodeModeCatalog({ ...owner, tools: [...owner.tools, closeOwner] });
      try {
        const execute = () =>
          expectDefined(owner.tools[0], "owner exec").execute("close-during-exec", {
            code: `${phase === "wait" ? 'await yield_control("initial");' : ""}
            await close_owner({});
            await yield_control("closed");
            return "unreachable";`,
          });
        let completion;
        if (phase === "wait") {
          const parked = resultDetails(await execute());
          expect(parked.status).toBe("waiting");
          completion = expectDefined(owner.tools[1], "owner wait").execute("close-during-wait", {
            runId: parked.runId,
          });
        } else {
          completion = execute();
        }
        expect(resultDetails(await completion)).toMatchObject({
          status: "failed",
          code: "aborted",
          telemetry: { catalogSize: 1, callCount: 1 },
        });
        expect(owner.catalogRef.current).toBeUndefined();
        expect(closeOwner.execute).toHaveBeenCalledOnce();
        expect(testing.activeRuns.size).toBe(0);
        expect(testing.resumingRunIds.size).toBe(0);
        expect(countActiveToolExecutions(owner.runId)).toBe(0);
      } finally {
        clearToolSearchCatalog(owner);
        owner.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("does not return a closed snapshot when owner abort races the wait deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const owner = createSubscribedCodeModeHarness({
      name: "abort-wait-deadline",
      timeoutMs: 1_500,
    });
    const lifecycle = vi.spyOn(owner.subscription, "runToolLifecycle");
    const started = createDeferred();
    const stalled = pluginToolWithExecute("stalled", "Await cancellation", async () => {
      started.resolve();
      return await new Promise<never>(() => {});
    });
    applyCodeModeCatalog({ ...owner, tools: [...owner.tools, stalled] });
    try {
      const execution = expectDefined(owner.tools[0], "owner exec").execute("deadline-exec", {
        code: "return await stalled({});",
      });
      await started.promise;
      await vi.advanceTimersByTimeAsync(1_500);
      const parked = resultDetails(await execution);
      expect(parked.status).toBe("waiting");
      const waiting = expectDefined(owner.tools[1], "owner wait").execute("deadline-wait", {
        runId: parked.runId,
      });
      vi.advanceTimersByTime(1_499);
      owner.runAbortController.abort();
      expect(resultDetails(await waiting)).toMatchObject({ status: "failed", code: "aborted" });
      expect(testing.activeRuns.size).toBe(0);
      expect(testing.resumingRunIds.size).toBe(0);
      // Abort returns before nested transcript and terminal finalization; join its owner.
      expect(lifecycle).toHaveBeenCalledOnce();
      await expect(lifecycle.mock.results[0]?.value).rejects.toThrow("Aborted");
      expect(countActiveToolExecutions(owner.runId)).toBe(0);
    } finally {
      lifecycle.mockRestore();
      clearToolSearchCatalog(owner);
      owner.dispose();
      vi.useRealTimers();
    }
  });

  it.each([
    { kind: "explicit cancellation", close: "cancel" },
    { kind: "run-owner loss", close: "abort" },
    { kind: "snapshot expiry", close: "expire" },
    { kind: "gateway shutdown", close: "shutdown" },
    { kind: "catalog closure during wait", close: "catalog" },
  ] as const)(
    "settles an abort-ignoring subscribed tool exactly once after $kind",
    async ({ close }) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const downstream = createDeferred();
      const started = createDeferred();
      const harness = createSubscribedCodeModeHarness({
        name: `closure-${close}`,
        timeoutMs: 2_000,
      });
      const target = pluginToolWithExecute("stalled_target", "Ignore cancellation", async () => {
        started.resolve();
        await downstream.promise;
        return jsonResult({ late: true });
      });
      const continuation = pluginToolWithExecute(
        "continue_after_target",
        "Continue the guest",
        async () => jsonResult({ continued: true }),
      );
      applyCodeModeCatalog({ ...harness, tools: [...harness.tools, target, continuation] });

      try {
        const execution = expectDefined(harness.tools[0], "Code Mode exec test invariant").execute(
          `code-call-${close}`,
          {
            code: `const target = stalled_target({});
                try { await target; } catch (error) { return error.message; }
                return await continue_after_target({});`,
          },
        );
        await started.promise;
        await vi.advanceTimersByTimeAsync(2_000);
        const suspended = resultDetails(await execution);
        expect(suspended.status).toBe("waiting");
        expect(target.execute).toHaveBeenCalledOnce();
        expect(countActiveToolExecutions(harness.runId)).toBe(1);

        const parked = testing.activeRuns.get(suspended.runId as string);
        const pending = parked?.pending.find((entry) => entry.method === "callValue");
        expect(pending).toBeDefined();
        if (!parked || !pending) {
          throw new Error("expected one parked subscribed tool call");
        }
        const settlements = vi.fn();
        void pending.promise.then(settlements);
        const cancel = vi.spyOn(pending, "cancel");
        const waiting = expectDefined(harness.tools[1], "Code Mode wait test invariant").execute(
          `code-wait-${close}`,
          { runId: suspended.runId },
        );

        if (close === "cancel") {
          pending.cancel?.();
        } else if (close === "abort") {
          harness.runAbortController.abort(new Error("run owner closed"));
        } else if (close === "expire") {
          parked.expiresAt = Date.now() - 1;
          testing.removeExpiredRuns();
        } else if (close === "catalog") {
          clearToolSearchCatalog(harness);
        } else {
          disposeAllCodeModeRuns();
        }

        const settlement = await pending.promise;
        expect(settlement).toMatchObject({ id: pending.id, ok: false });
        expect(settlement.ok ? "" : settlement.error).toMatch(/cancel|abort|expir|owner|shut/i);
        const result = resultDetails(await waiting);
        expect(result.status).not.toBe("waiting");
        if (close === "catalog") {
          expect(result).toMatchObject({
            status: "failed",
            code: "aborted",
            telemetry: suspended.telemetry,
          });
          expect(harness.catalogRef.current).toBeUndefined();
        }
        await vi.waitFor(() => expect(countActiveToolExecutions(harness.runId)).toBe(0));
        expect(settlements).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledOnce();
        expect(harness.subscription.getItemLifecycle().activeCount).toBe(0);
        expect(testing.activeRuns.size).toBe(0);
        expect(testing.resumingRunIds.size).toBe(0);

        downstream.resolve();
        await Promise.resolve();
        expect(target.execute).toHaveBeenCalledOnce();
        expect(continuation.execute).not.toHaveBeenCalled();
        expect(settlements).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledOnce();
      } finally {
        downstream.resolve();
        clearToolSearchCatalog(harness);
        harness.dispose();
        vi.useRealTimers();
      }
    },
  );
});
