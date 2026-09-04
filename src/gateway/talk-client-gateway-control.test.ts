import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { RealtimeVoiceBridge } from "../talk/provider-types.js";
import {
  closeTalkClientGatewayControlSession,
  createTalkClientGatewayControlOwner,
  createTalkRealtimeRunControlOwner,
} from "./talk-client-gateway-control.js";
import {
  sessionTarget,
  controlContext,
  controlBridge,
} from "./talk-client-gateway-control.test-support.js";
import { cleanupTalkConnection } from "./talk-session-registry.js";

describe("Talk client Gateway control owner", () => {
  it.each([
    ["Status?", false, false, "delegation", true],
    ["cancel", false, false, "delegation", true],
    ["use the release branch instead", false, false, "delegation", false],
    ["use the release branch instead", true, false, "delegation", true],
    ["also check tests", false, false, "delegation", false],
    ["also check tests", true, false, "delegation", true],
    ["cancel my meeting tomorrow", true, false, "delegation", false],
    ["hello", false, false, "delegation", false],
    ["cancel", true, true, "transcript", true],
    ["Status?", false, true, "transcript", false],
    ["cancel", false, true, "transcript", false],
    ["Status?", false, undefined, "transcript", false],
    ["Status?", false, false, "transcript", true],
    ["cancel", false, false, "transcript", true],
  ] as const)(
    "admits %s (active=%s, tools=%s, source=%s)",
    async (text, active, supportsToolCalls, controlSource, handled) => {
      const execute = vi.fn(async () => ({
        ok: true,
        mode: "status" as const,
        sessionKey: sessionTarget.canonicalKey,
        active,
        message: "Visible control outcome.",
        speak: true,
        show: true,
        suppress: false,
      }));
      const speak = vi.fn();
      const respond = vi.fn();
      const owner = createTalkRealtimeRunControlOwner({
        controlSource,
        supportsToolCalls,
        hasActiveRun: () => active,
        prepare: () => execute,
        speak,
        warn: vi.fn(),
      });
      try {
        if (controlSource === "delegation") {
          expect(owner.handleSpoken(text)).toBe(false);
          expect(owner.handleDelegationInput?.(text, respond)).toBe(
            handled ? "control" : "consult",
          );
        } else {
          expect(owner.handleDelegationInput).toBeUndefined();
          expect(owner.handleSpoken(text)).toBe(handled);
        }
        await owner.close();
        expect(execute).toHaveBeenCalledTimes(handled ? 1 : 0);
        expect(respond).toHaveBeenCalledTimes(controlSource === "delegation" && handled ? 1 : 0);
        expect(speak).toHaveBeenCalledTimes(controlSource === "transcript" && handled ? 1 : 0);
      } finally {
        await owner.close();
      }
    },
  );

  it.each(["failed", "incomplete"] as const)(
    "keeps Gateway-controlled browser Talk reusable after a %s response",
    async (status) => {
      const warn = vi.fn();
      const closeProvider = vi.fn(async () => undefined);
      const closeLogicalSession = vi.fn(async () => undefined);
      const talkEvents: Array<{ type: string; payload: unknown }> = [];
      const owner = createTalkClientGatewayControlOwner({
        voiceSessionId: `voice-${status}`,
        providerId: "openai",
        sessionTarget,
        connId: "conn-gateway",
        context: controlContext(warn, (event) => talkEvents.push(event)),
        runAgentConsult: vi.fn(async () => ({ text: "done" })),
        appendTranscript: vi.fn(async () => undefined),
        flushTranscript: vi.fn(async () => undefined),
        closeLogicalSession,
      });
      await owner.adoptProvider(closeProvider);
      owner.activate();
      owner.control.onEvent?.({
        direction: "server",
        type: "response.created",
        responseId: "response-1",
      });
      const firstOutcome = {
        status,
        responseId: "response-1",
        message: `provider ${status}`,
      } as const;
      owner.control.onResponseDone?.(firstOutcome);
      owner.control.onEvent?.({
        direction: "server",
        type: "response.done",
        responseId: "response-1",
      });
      owner.control.onEvent?.({
        direction: "server",
        type: "response.created",
        responseId: "response-2",
      });
      owner.control.onResponseDone?.({ status: "completed", responseId: "response-2" });
      owner.control.onEvent?.({
        direction: "server",
        type: "response.done",
        responseId: "response-2",
      });

      expect(talkEvents.filter((event) => event.type === "session.error")).toHaveLength(1);
      expect(talkEvents.filter((event) => event.type === "turn.ended")).toHaveLength(2);
      expect(warn).toHaveBeenCalledWith(`talk Gateway control provider ${status}`);
      expect(closeProvider).not.toHaveBeenCalled();
      expect(closeLogicalSession).not.toHaveBeenCalled();

      await owner.close();
    },
  );

  it.each(["completed", "cancelled"] as const)(
    "persists sideband transcripts, settles a %s consult, and closes idempotently",
    async (outcome) => {
      const consultResult = createDeferred<{ text: string }>();
      const cancelled = {
        ok: true,
        mode: "cancel" as const,
        sessionKey: sessionTarget.canonicalKey,
        active: true,
        aborted: true,
        message: "Cancelled the active OpenClaw run.",
        speak: true,
        show: true,
        suppress: false,
      };
      const controlAgentRun = vi
        .fn(async () => ({
          ...cancelled,
          ok: false,
          active: false,
          aborted: false,
          message: "There is no active OpenClaw run to cancel.",
        }))
        .mockResolvedValueOnce(cancelled);
      const runAgentConsult = vi.fn(async (_args: unknown, signal: AbortSignal) => {
        const result = await consultResult.promise;
        if (outcome === "cancelled") {
          expect(signal.aborted).toBe(true);
          throw new DOMException("Host cancelled the consult", "AbortError");
        }
        return result;
      });
      const appendTranscript = vi.fn(
        async (_entry: { entryId: string; role: "user" | "assistant"; text: string }) => undefined,
      );
      const closeLogicalSession = vi.fn(async () => undefined);
      const closeProvider = vi.fn(async () => undefined);
      const bridge = controlBridge();
      const owner = createTalkClientGatewayControlOwner({
        voiceSessionId: "voice-gateway",
        supportsToolCalls: true,
        sessionTarget,
        connId: "conn-gateway",
        context: controlContext(),
        runAgentConsult,
        controlAgentRun,
        appendTranscript,
        flushTranscript: vi.fn(async () => undefined),
        closeLogicalSession,
      });
      owner.control.bindBridge(bridge);
      await owner.adoptProvider(closeProvider);
      owner.activate();

      owner.control.onTranscript?.("user", "check the repository", true);
      owner.control.onToolCall?.({
        itemId: "item-consult",
        callId: "call-consult",
        name: "openclaw_agent_consult",
        args: { question: "check the repository" },
      });
      await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
      const cancelToolCall = (callId: string) =>
        owner.control.onToolCall?.({
          itemId: callId,
          callId,
          name: "openclaw_agent_control",
          args: { text: "cancel", mode: "cancel" },
        });
      if (outcome === "cancelled") {
        cancelToolCall("call-cancel");
        await vi.waitFor(() =>
          expect(bridge.submitToolResult).toHaveBeenCalledWith("call-cancel", cancelled),
        );
      }
      consultResult.resolve({ text: "The repository is clean." });
      const expectedResult =
        outcome === "cancelled"
          ? expect.objectContaining({ status: "cancelled" })
          : { result: "The repository is clean." };
      await vi.waitFor(() =>
        expect(bridge.submitToolResult).toHaveBeenCalledWith("call-consult", expectedResult),
      );
      expect(appendTranscript).toHaveBeenCalledWith({
        entryId: expect.stringMatching(/^gateway-[0-9a-f-]+-1$/),
        role: "user",
        text: "check the repository",
      });
      if (outcome === "cancelled") {
        await nextEventLoopTurn();
        owner.control.onTranscript?.("user", "cancel", true);
        // A later explicit tool call drains the same control FIFO after the late ASR event.
        cancelToolCall("call-next-cancel");
        await vi.waitFor(() =>
          expect(bridge.submitToolResult).toHaveBeenCalledWith(
            "call-next-cancel",
            expect.objectContaining({ active: false }),
          ),
        );
        expect(controlAgentRun).toHaveBeenCalledTimes(2);
        expect(bridge.sendUserMessage).not.toHaveBeenCalled();
      }

      const closeParams = {
        voiceSessionId: "voice-gateway",
        sessionKey: sessionTarget.sessionKey,
        connId: "conn-gateway",
      };
      await expect(
        closeTalkClientGatewayControlSession({ ...closeParams, connId: "conn-other" }),
      ).rejects.toThrow("not owned by this client");
      await expect(closeTalkClientGatewayControlSession(closeParams)).resolves.toBe(true);
      await expect(closeTalkClientGatewayControlSession(closeParams)).resolves.toBe(false);
      expect(closeProvider).toHaveBeenCalledOnce();
      expect(closeLogicalSession).toHaveBeenCalledOnce();
    },
  );

  it("routes control tool results without starting another consult", async () => {
    const bridge = controlBridge();
    const runAgentConsult = vi.fn(async () => ({ text: "unexpected" }));
    const owner = createTalkClientGatewayControlOwner({
      voiceSessionId: "voice-control",
      sessionTarget,
      connId: "conn-control",
      context: controlContext(),
      runAgentConsult,
      appendTranscript: vi.fn(async () => undefined),
      flushTranscript: vi.fn(async () => undefined),
      closeLogicalSession: vi.fn(async () => undefined),
    });
    owner.control.bindBridge(bridge);
    await owner.adoptProvider(vi.fn(async () => undefined));
    owner.activate();
    owner.control.onToolCall?.({
      itemId: "item-status",
      callId: "call-status",
      name: "openclaw_agent_control",
      args: { text: "status", mode: "status" },
    });

    await vi.waitFor(() =>
      expect(bridge.submitToolResult).toHaveBeenCalledWith(
        "call-status",
        expect.objectContaining({ mode: "status", speak: true }),
      ),
    );
    expect(runAgentConsult).not.toHaveBeenCalled();
    await owner.close();
  });

  it.each(["tool", "delegation"] as const)(
    "handles spoken status, steering, and cancellation during a %s consult",
    async (entry) => {
      const controlAgentRun = vi.fn(async ({ text }: { text: string }) => ({
        ok: true,
        mode:
          text === "cancel"
            ? ("cancel" as const)
            : text === "status"
              ? ("status" as const)
              : ("steer" as const),
        sessionKey: sessionTarget.canonicalKey,
        active: true,
        ...(text === "cancel" ? { aborted: true } : { queued: text !== "status" }),
        message: `${text} accepted`,
        speak: true,
        show: true,
        suppress: false,
      }));
      const runStarted = createDeferred();
      const runAgentConsult = vi.fn(
        async (_args: unknown, signal: AbortSignal) =>
          await new Promise<{ text: string }>((_resolve, reject) => {
            runStarted.resolve();
            signal.addEventListener(
              "abort",
              () =>
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error("Realtime voice consult aborted"),
                ),
              { once: true },
            );
          }),
      );
      const bridge = controlBridge();
      const owner = createTalkClientGatewayControlOwner({
        voiceSessionId: `voice-spoken-control-${entry}`,
        sessionTarget,
        connId: `conn-spoken-control-${entry}`,
        context: controlContext(),
        runAgentConsult,
        controlAgentRun,
        appendTranscript: vi.fn(async () => undefined),
        flushTranscript: vi.fn(async () => undefined),
        closeLogicalSession: vi.fn(async () => undefined),
      });
      if (entry === "delegation") {
        owner.control.bindControl?.({ sendUserMessage: bridge.sendUserMessage });
      } else {
        owner.control.bindBridge(bridge);
      }
      await owner.adoptProvider(vi.fn(async () => undefined));
      owner.activate();
      const delegationController = new AbortController();
      const delegation =
        entry === "delegation"
          ? owner
              .runAgentConsult({ prompt: "long task", signal: delegationController.signal })
              .catch((error: unknown) => error)
          : undefined;
      if (entry === "tool") {
        owner.control.onToolCall?.({
          itemId: "item-long",
          callId: "call-long",
          name: "openclaw_agent_consult",
          args: { question: "long task" },
        });
      }
      try {
        await runStarted.promise;
        for (const text of ["status", "use the release branch instead", "cancel"]) {
          owner.control.onTranscript?.("user", text, true);
          await vi.waitFor(() =>
            expect(controlAgentRun).toHaveBeenCalledTimes(
              text === "status" ? 1 : text === "cancel" ? 3 : 2,
            ),
          );
        }
        expect(controlAgentRun.mock.calls.map(([input]) => input.text)).toEqual([
          "status",
          "use the release branch instead",
          "cancel",
        ]);
        expect(bridge.sendUserMessage).toHaveBeenCalledTimes(3);
        if (delegation) {
          await expect(delegation).resolves.toBeInstanceOf(Error);
          expect(bridge.submitToolResult).not.toHaveBeenCalled();
        } else {
          await vi.waitFor(() =>
            expect(bridge.submitToolResult).toHaveBeenCalledWith(
              "call-long",
              expect.objectContaining({ status: "cancelled" }),
            ),
          );
        }
      } finally {
        delegationController.abort(new Error("test cleanup"));
        await owner.close();
        await delegation;
      }
    },
  );

  it.each([
    { entry: "tool", transition: "close" },
    { entry: "tool", transition: "replace" },
    { entry: "delegation", transition: "close" },
    { entry: "delegation", transition: "replace" },
  ] as const)(
    "fences $entry admission when $transition occurs during transcript flush",
    async ({ entry, transition }) => {
      const flush = createDeferred();
      const flushTranscript = vi.fn(() => flush.promise);
      const runAgentConsult = vi.fn(async () => ({ text: "must not run" }));
      const common = {
        voiceSessionId: `voice-flush-${entry}-${transition}`,
        sessionTarget,
        connId: `conn-flush-${entry}-${transition}`,
        context: controlContext(),
        runAgentConsult,
        appendTranscript: vi.fn(async () => undefined),
        closeLogicalSession: vi.fn(async () => undefined),
      };
      const owner = createTalkClientGatewayControlOwner({ ...common, flushTranscript });
      let replacement: ReturnType<typeof createTalkClientGatewayControlOwner> | undefined;
      let delegation: Promise<unknown> | undefined;
      await owner.adoptProvider(vi.fn(async () => undefined));
      owner.activate();
      try {
        if (entry === "delegation") {
          delegation = owner
            .runAgentConsult({ prompt: "queued task" })
            .catch((error: unknown) => error);
        } else {
          owner.control.onToolCall?.({
            itemId: "item-flush",
            callId: "call-flush",
            name: "openclaw_agent_consult",
            args: { question: "queued task" },
          });
        }
        await vi.waitFor(() => expect(flushTranscript).toHaveBeenCalledOnce());
        if (transition === "replace") {
          replacement = createTalkClientGatewayControlOwner({
            ...common,
            flushTranscript: vi.fn(async () => undefined),
          });
          await replacement.adoptProvider(vi.fn(async () => undefined));
          replacement.activate();
        } else {
          void owner.close();
        }
        flush.resolve();
        await owner.close();
        if (delegation) {
          await expect(delegation).resolves.toBeInstanceOf(Error);
        }
        expect(runAgentConsult).not.toHaveBeenCalled();
      } finally {
        flush.resolve();
        await owner.close();
        await replacement?.close();
        await delegation;
      }
    },
  );

  it.each(["tool", "delegation"] as const)(
    "never admits a %s consult after flush completion schedules closure",
    async (entry) => {
      const flush = createDeferred();
      const transitioned = createDeferred();
      const admissionsAfterClose: boolean[] = [];
      let closed = false;
      const flushTranscript = vi.fn(() => flush.promise);
      const owner = createTalkClientGatewayControlOwner({
        voiceSessionId: `voice-flush-completion-${entry}`,
        sessionTarget,
        connId: `conn-flush-completion-${entry}`,
        context: controlContext(),
        runAgentConsult: vi.fn(async () => {
          admissionsAfterClose.push(closed);
          return { text: "accepted while open" };
        }),
        appendTranscript: vi.fn(async () => undefined),
        flushTranscript,
        closeLogicalSession: vi.fn(async () => undefined),
      });
      // Another completion observer may close the owner between an async
      // preparation helper returning and its caller admitting the actual run.
      void flush.promise.then(() => {
        queueMicrotask(() => {
          closed = true;
          void owner.close();
          transitioned.resolve();
        });
      });
      await owner.adoptProvider(vi.fn(async () => undefined));
      owner.activate();
      let delegation: Promise<unknown> | undefined;
      try {
        if (entry === "delegation") {
          delegation = owner.runAgentConsult({ prompt: "queued task" }).catch(() => undefined);
        } else {
          owner.control.onToolCall?.({
            itemId: "item-flush-completion",
            callId: "call-flush-completion",
            name: "openclaw_agent_consult",
            args: { question: "queued task" },
          });
        }
        await vi.waitFor(() => expect(flushTranscript).toHaveBeenCalledOnce());
        flush.resolve();
        await transitioned.promise;
        await owner.close();
        await delegation;
        expect(admissionsAfterClose).not.toContain(true);
      } finally {
        flush.resolve();
        await owner.close();
        await delegation;
      }
    },
  );

  it("detaches accepted provider consultations without extending admission", async () => {
    const result = createDeferred<{ text: string }>();
    const started = createDeferred();
    const providerController = new AbortController();
    let acceptedSignal: AbortSignal | undefined;
    const runAgentConsult = vi.fn(async (_args: unknown, signal: AbortSignal) => {
      acceptedSignal = signal;
      started.resolve();
      return await result.promise;
    });
    const owner = createTalkClientGatewayControlOwner({
      voiceSessionId: "voice-delegation-detach",
      sessionTarget,
      connId: "conn-delegation-detach",
      context: controlContext(),
      runAgentConsult,
      appendTranscript: vi.fn(async () => undefined),
      flushTranscript: vi.fn(async () => undefined),
      closeLogicalSession: vi.fn(async () => undefined),
    });
    await owner.adoptProvider(vi.fn(async () => undefined));
    owner.activate();
    const accepted = owner.runAgentConsult({
      prompt: "accepted task",
      signal: providerController.signal,
    });
    try {
      await started.promise;
      await owner.close();
      expect(acceptedSignal?.aborted).toBe(false);
      await expect(owner.runAgentConsult({ prompt: "late task" })).rejects.toThrow("closed");
      expect(runAgentConsult).toHaveBeenCalledOnce();
      providerController.abort(new Error("provider cancelled accepted work"));
      expect(acceptedSignal?.aborted).toBe(true);
      result.resolve({ text: "accepted task finished" });
      await expect(accepted).resolves.toEqual({ text: "accepted task finished" });
    } finally {
      result.resolve({ text: "test cleanup" });
      await accepted;
      await owner.close();
    }
  });

  it("closes the provider and logical session when the owning client disconnects", async () => {
    const closeProvider = vi.fn(async () => undefined);
    const closeLogicalSession = vi.fn(async () => undefined);
    const owner = createTalkClientGatewayControlOwner({
      voiceSessionId: "voice-disconnect",
      sessionTarget,
      connId: "conn-disconnect",
      context: controlContext(),
      runAgentConsult: vi.fn(async () => ({ text: "done" })),
      appendTranscript: vi.fn(async () => undefined),
      flushTranscript: vi.fn(async () => undefined),
      closeLogicalSession,
    });
    await owner.adoptProvider(closeProvider);
    owner.activate();

    cleanupTalkConnection("conn-disconnect", { warn: vi.fn() });

    await vi.waitFor(() => expect(closeLogicalSession).toHaveBeenCalledOnce());
    expect(closeProvider).toHaveBeenCalledOnce();
  });

  it("finishes logical cleanup when provider teardown fails", async () => {
    const closeLogicalSession = vi.fn(async () => undefined);
    const owner = createTalkClientGatewayControlOwner({
      voiceSessionId: "voice-close-error",
      sessionTarget,
      connId: "conn-close-error",
      context: controlContext(),
      runAgentConsult: vi.fn(async () => ({ text: "done" })),
      appendTranscript: vi.fn(async () => undefined),
      flushTranscript: vi.fn(async () => undefined),
      closeLogicalSession,
    });
    await owner.adoptProvider(vi.fn(() => Promise.reject(new Error("provider close failed"))));
    owner.activate();

    await expect(owner.close()).rejects.toThrow("provider close failed");
    expect(closeLogicalSession).toHaveBeenCalledOnce();
  });

  it("replaces only the physical transport while preserving the logical owner and run", async () => {
    const consult = createDeferred<{ text: string }>();
    const runStarted = createDeferred();
    let runSignal: AbortSignal | undefined;
    const runAgentConsult = vi.fn(async (_args: unknown, signal: AbortSignal) => {
      runSignal = signal;
      runStarted.resolve();
      return await consult.promise;
    });
    const appendTranscript = vi.fn(
      async (_entry: { entryId: string; role: "user" | "assistant"; text: string }) => undefined,
    );
    const closeLogicalSession = vi.fn(async () => undefined);
    const common = {
      voiceSessionId: "voice-replacement",
      sessionTarget,
      connId: "conn-replacement",
      context: controlContext(),
      runAgentConsult,
      appendTranscript,
      flushTranscript: vi.fn(async () => undefined),
      closeLogicalSession,
    };
    const firstBridge = controlBridge();
    const secondBridge = {
      ...firstBridge,
      submitToolResult: vi.fn(),
    } satisfies RealtimeVoiceBridge;
    const closeFirst = vi.fn(async () => undefined);
    const closeSecond = vi.fn(async () => undefined);
    const first = createTalkClientGatewayControlOwner(common);
    first.control.bindBridge(firstBridge);
    await first.adoptProvider(closeFirst);
    first.activate();
    first.control.onTranscript?.("user", "first transport", true);
    first.control.onToolCall?.({
      itemId: "item-replacement",
      callId: "call-replacement",
      name: "openclaw_agent_consult",
      args: { question: "keep running" },
    });
    await runStarted.promise;

    const second = createTalkClientGatewayControlOwner(common);
    second.control.bindBridge(secondBridge);
    await second.adoptProvider(closeSecond);
    second.activate();
    await vi.waitFor(() => expect(closeFirst).toHaveBeenCalledOnce());
    expect(() => first.control.bindControl?.({ sendUserMessage: vi.fn() })).toThrow("closed");
    first.control.onClose?.("completed");
    first.control.onTranscript?.("user", "stale transport", true);
    second.control.onTranscript?.("user", "second transport", true);

    expect(runSignal?.aborted).toBe(false);
    expect(closeLogicalSession).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(appendTranscript).toHaveBeenCalledTimes(2));
    const entryIds = appendTranscript.mock.calls.map(([entry]) => entry.entryId);
    expect(entryIds).toHaveLength(2);
    expect(entryIds[0]).toMatch(/^gateway-[0-9a-f-]+-1$/);
    expect(entryIds[1]).toMatch(/^gateway-[0-9a-f-]+-1$/);
    expect(entryIds[0]).not.toBe(entryIds[1]);

    consult.resolve({ text: "done" });
    await vi.waitFor(() => expect(closeFirst).toHaveBeenCalledOnce());
    expect(firstBridge.submitToolResult).not.toHaveBeenCalled();
    await second.close();
    expect(() => second.control.bindBridge(secondBridge)).toThrow("closed");
    expect(closeSecond).toHaveBeenCalledOnce();
    expect(closeLogicalSession).toHaveBeenCalledOnce();
  });
});
