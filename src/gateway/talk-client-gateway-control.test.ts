import { describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceBridge } from "../talk/provider-types.js";
import {
  closeTalkClientGatewayControlSession,
  createTalkClientGatewayControlOwner,
} from "./talk-client-gateway-control.js";
import { cleanupTalkConnection } from "./talk-session-registry.js";

const sessionTarget = {
  agentId: "main",
  sessionKey: "agent:main:main",
  canonicalKey: "agent:main:main",
  storePath: "/tmp/sessions",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function controlContext(
  warn = vi.fn(),
  onTalkEvent?: (event: { type: string; payload: unknown }) => void,
) {
  return {
    logGateway: { warn },
    chatAbortControllers: new Map(),
    broadcastToConnIds: vi.fn((_name: string, payload: { talkEvent?: unknown }) => {
      if (payload.talkEvent) {
        onTalkEvent?.(payload.talkEvent as { type: string; payload: unknown });
      }
    }),
  } as never;
}

describe("Talk client Gateway control owner", () => {
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

  it("persists sideband transcripts, completes consults, and closes idempotently", async () => {
    const consultResult = deferred<{ text: string }>();
    const runAgentConsult = vi.fn(async () => await consultResult.promise);
    const appendTranscript = vi.fn(
      async (_entry: { entryId: string; role: "user" | "assistant"; text: string }) => undefined,
    );
    const closeLogicalSession = vi.fn(async () => undefined);
    const closeProvider = vi.fn(async () => undefined);
    const bridge = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      sendUserMessage: vi.fn(),
      submitToolResult: vi.fn(async () => undefined),
      acknowledgeMark: vi.fn(),
      isConnected: vi.fn(() => true),
    } satisfies RealtimeVoiceBridge;
    const owner = createTalkClientGatewayControlOwner({
      voiceSessionId: "voice-gateway",
      sessionTarget,
      connId: "conn-gateway",
      context: controlContext(),
      runAgentConsult,
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
    consultResult.resolve({ text: "The repository is clean." });
    await vi.waitFor(() =>
      expect(bridge.submitToolResult).toHaveBeenCalledWith("call-consult", {
        result: "The repository is clean.",
      }),
    );
    expect(appendTranscript).toHaveBeenCalledWith({
      entryId: expect.stringMatching(/^gateway-[0-9a-f-]+-1$/),
      role: "user",
      text: "check the repository",
    });

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
  });

  it("routes control tool results without starting another consult", async () => {
    const bridge = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      submitToolResult: vi.fn(async () => undefined),
      acknowledgeMark: vi.fn(),
      isConnected: vi.fn(() => true),
    } satisfies RealtimeVoiceBridge;
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

  it("handles spoken status, steering, and cancellation while a consult is active", async () => {
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
    const runStarted = deferred<void>();
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
    const bridge = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      sendUserMessage: vi.fn(),
      submitToolResult: vi.fn(async () => undefined),
      acknowledgeMark: vi.fn(),
      isConnected: vi.fn(() => true),
    } satisfies RealtimeVoiceBridge;
    const owner = createTalkClientGatewayControlOwner({
      voiceSessionId: "voice-spoken-control",
      sessionTarget,
      connId: "conn-spoken-control",
      context: controlContext(),
      runAgentConsult,
      controlAgentRun,
      appendTranscript: vi.fn(async () => undefined),
      flushTranscript: vi.fn(async () => undefined),
      closeLogicalSession: vi.fn(async () => undefined),
    });
    owner.control.bindBridge(bridge);
    await owner.adoptProvider(vi.fn(async () => undefined));
    owner.activate();
    owner.control.onToolCall?.({
      itemId: "item-long",
      callId: "call-long",
      name: "openclaw_agent_consult",
      args: { question: "long task" },
    });
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
    await vi.waitFor(() =>
      expect(bridge.submitToolResult).toHaveBeenCalledWith(
        "call-long",
        expect.objectContaining({ status: "cancelled" }),
      ),
    );
    await owner.close();
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
    const consult = deferred<{ text: string }>();
    const runStarted = deferred<void>();
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
    const firstBridge = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      isConnected: vi.fn(() => true),
    } satisfies RealtimeVoiceBridge;
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
    expect(closeSecond).toHaveBeenCalledOnce();
    expect(closeLogicalSession).toHaveBeenCalledOnce();
  });
});
