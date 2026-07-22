import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayErrorDetailCodes } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SessionObserverAskError } from "./session-observer-contract.js";
import { sessionObserverHandlers } from "./session-observer-rpc.js";
import {
  createHarness,
  event,
  flushObserver,
  persistedLiveDigest,
  preparedModel,
  resetSessionObserverEventSequence,
} from "./session-observer.test-utils.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSessionObserverEventSequence();
});

function plainTextMessage(text: string) {
  return {
    stopReason: "stop",
    content: [{ type: "text", text }],
  };
}

type CompletionCall = {
  context?: { messages?: Array<{ content?: unknown }> };
  options?: { maxTokens?: number; temperature?: number };
};

describe("session observer asks", () => {
  it("requires both an enabled observer and an exact session subscriber", async () => {
    const disabledConfig = {
      gateway: { controlUi: { sessionObserver: false } },
      agents: { defaults: { utilityModel: "openai/gpt-test" } },
    } satisfies OpenClawConfig;
    const disabled = createHarness({ config: disabledConfig });
    await expect(
      disabled.observer.ask({
        sessionKey: "agent:main:session-1",
        question: "What is happening?",
        connId: "conn-1",
      }),
    ).rejects.toMatchObject({ reason: "disabled" });
    expect(disabled.prepareModel).not.toHaveBeenCalled();
    disabled.observer.dispose();

    const unsubscribed = createHarness();
    await expect(
      unsubscribed.observer.ask({
        sessionKey: "agent:main:session-1",
        question: "What is happening?",
        connId: "conn-other",
      }),
    ).rejects.toMatchObject({ reason: "not-subscribed" });
    expect(unsubscribed.prepareModel).not.toHaveBeenCalled();
    unsubscribed.observer.dispose();
  });

  it("allows only one in-flight ask per session", async () => {
    let resolveCompletion: ((value: ReturnType<typeof plainTextMessage>) => void) | undefined;
    const completeModel = vi.fn(
      () =>
        new Promise<ReturnType<typeof plainTextMessage>>((resolve) => {
          resolveCompletion = resolve;
        }),
    );
    const harness = createHarness({ completeModel });
    const first = harness.observer.ask({
      sessionKey: "agent:main:session-1",
      question: "Why is it rerunning the test?",
      connId: "conn-1",
    });
    await flushObserver();
    expect(completeModel).toHaveBeenCalledOnce();

    await expect(
      harness.observer.ask({
        sessionKey: "agent:main:session-1",
        question: "Is it stuck?",
        connId: "conn-1",
      }),
    ).rejects.toMatchObject({ reason: "busy" });
    expect(completeModel).toHaveBeenCalledOnce();

    resolveCompletion?.(plainTextMessage("It is checking whether the fix is stable."));
    await expect(first).resolves.toMatchObject({
      answer: "It is checking whether the fix is stable.",
    });
    harness.observer.dispose();
  });

  it("rate-limits sequential read-scoped asks before another model call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const completeModel = vi.fn(async () => plainTextMessage("It is still progressing."));
    const harness = createHarness({ completeModel });

    for (let index = 0; index < 4; index += 1) {
      await harness.observer.ask({
        sessionKey: "agent:main:session-1",
        question: `What is happening now? ${index}`,
        connId: "conn-1",
      });
    }
    await expect(
      harness.observer.ask({
        sessionKey: "agent:main:session-1",
        question: "What changed?",
        connId: "conn-1",
      }),
    ).rejects.toMatchObject({ reason: "rate-limited", retryAfterMs: 60_000 });
    expect(harness.prepareModel).toHaveBeenCalledTimes(4);
    expect(completeModel).toHaveBeenCalledTimes(4);
    harness.observer.dispose();
  });

  it("falls back to the persisted digest without notes for an unobserved session", async () => {
    const storedDigest = persistedLiveDigest({
      revision: 11,
      headline: "Rerunning a focused test",
    });
    const readSession = vi.fn(() => ({
      sessionId: "stored-session",
      updatedAt: storedDigest.updatedAt,
      observerDigest: storedDigest,
    }));
    const completeModel = vi.fn(async (_params: unknown) =>
      plainTextMessage("The focused test is being retried."),
    );
    const harness = createHarness({ readSession, completeModel });

    await expect(
      harness.observer.ask({
        sessionKey: "agent:main:session-1",
        question: "Why is that test running again?",
        connId: "conn-1",
      }),
    ).resolves.toEqual({
      answer: "The focused test is being retried.",
      digestRevision: 11,
    });

    const call = completeModel.mock.calls[0]?.[0] as unknown as CompletionCall | undefined;
    const prompt = JSON.parse(String(call?.context?.messages?.[0]?.content)) as {
      digest: { headline: string };
      notes: unknown[];
      question: string;
    };
    expect(prompt).toEqual({
      digest: expect.objectContaining({ headline: "Rerunning a focused test", revision: 11 }),
      notes: [],
      question: "Why is that test running again?",
    });
    expect(readSession).toHaveBeenCalledWith("agent:main:session-1", "main");
    harness.observer.dispose();
  });

  it("discards an answer when its observer snapshot is no longer current", async () => {
    let storedDigest = persistedLiveDigest({ revision: 11 });
    const readSession = vi.fn(() => ({
      sessionId: "stored-session",
      updatedAt: storedDigest.updatedAt,
      observerDigest: storedDigest,
    }));
    let resolveCompletion: ((value: ReturnType<typeof plainTextMessage>) => void) | undefined;
    const completeModel = vi.fn(
      () =>
        new Promise<ReturnType<typeof plainTextMessage>>((resolve) => {
          resolveCompletion = resolve;
        }),
    );
    const harness = createHarness({ readSession, completeModel });
    const ask = harness.observer.ask({
      sessionKey: "agent:main:session-1",
      question: "Why is it still testing?",
      connId: "conn-1",
    });
    await flushObserver();

    storedDigest = persistedLiveDigest({
      revision: 12,
      headline: "The test has finished",
    });
    resolveCompletion?.(plainTextMessage("It is still rerunning the test."));

    await expect(ask).rejects.toMatchObject({ reason: "model-unavailable" });
    expect(readSession).toHaveBeenCalledTimes(2);
    harness.observer.dispose();
  });

  it("reuses only sanitized bounded note text in the ask prompt", async () => {
    const completeModel = vi.fn(async (_params: unknown) =>
      plainTextMessage("The command is being retried."),
    );
    const harness = createHarness({ completeModel });
    harness.observer.handleEvent(event({ stream: "lifecycle", data: { phase: "start" } }));
    harness.observer.handleEvent(
      event({
        stream: "tool",
        data: {
          phase: "start",
          name: "exec",
          args: { command: "password=test-password" },
        },
      }),
    );
    const snapshot = harness.observer.getSnapshot("agent:main:session-1");

    await harness.observer.ask({
      sessionKey: "agent:main:session-1",
      question: "Why is the command repeating?",
      connId: "conn-1",
    });
    const call = completeModel.mock.calls[0]?.[0] as unknown as CompletionCall | undefined;
    const prompt = JSON.parse(String(call?.context?.messages?.[0]?.content)) as {
      notes: string[];
    };
    expect(prompt.notes).toEqual(snapshot.notes);
    expect(JSON.stringify(prompt.notes)).not.toContain("test-password");
    expect(JSON.stringify(prompt.notes)).toContain("***");
    harness.observer.dispose();
  });

  it("redacts and truncates plain-text answers to the protocol cap", async () => {
    const completeModel = vi.fn(async (_params: unknown) =>
      plainTextMessage(`password=hunter2 ${"x".repeat(800)}`),
    );
    const harness = createHarness({ completeModel });
    const result = await harness.observer.ask({
      sessionKey: "agent:main:session-1",
      question: "What is the status?",
      connId: "conn-1",
    });

    expect(result.answer).toHaveLength(600);
    expect(result.answer).not.toContain("hunter2");
    expect(result.answer).toContain("***");
    const call = completeModel.mock.calls[0]?.[0] as unknown as CompletionCall | undefined;
    expect(call?.options).toMatchObject({
      maxTokens: 400,
      temperature: 0.2,
    });
    harness.observer.dispose();
  });

  it("never prepares or calls a primary model when the utility model is unresolved", async () => {
    const completeModel = vi.fn(async () => plainTextMessage("should not run"));
    const harness = createHarness({ utilityModelRef: null, completeModel });

    await expect(
      harness.observer.ask({
        sessionKey: "agent:main:session-1",
        question: "What is happening?",
        connId: "conn-1",
      }),
    ).rejects.toMatchObject({ reason: "utility-model-unavailable" });
    expect(harness.prepareModel).not.toHaveBeenCalled();
    expect(completeModel).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("prepares the explicit utility-model path without a primary fallback", async () => {
    const harness = createHarness({
      prepareModel: vi.fn(async () => preparedModel()),
      completeModel: vi.fn(async () => plainTextMessage("It is making progress.")),
    });
    await harness.observer.ask({
      sessionKey: "agent:main:session-1",
      question: "Is it progressing?",
      connId: "conn-1",
    });

    expect(harness.prepareModel).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        modelRef: "openai/gpt-test",
        useUtilityModel: true,
      }),
    );
    harness.observer.dispose();
  });
});

describe("sessions.observer.ask errors", () => {
  it("returns a retryable typed busy error", async () => {
    const respond = vi.fn();
    await sessionObserverHandlers["sessions.observer.ask"]?.({
      params: { sessionKey: "agent:main:session-1", question: "Why?" },
      client: { connId: "conn-1" },
      context: {
        sessionObserver: {
          ask: vi.fn(async () => {
            throw new SessionObserverAskError("busy", "Already answering.");
          }),
        },
      },
      respond,
    } as never);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: true,
        details: { code: GatewayErrorDetailCodes.SESSION_OBSERVER_BUSY },
      }),
    );
  });
});

describe("sessions.observer.visibility", () => {
  it("records visibility for the authenticated connection", async () => {
    const respond = vi.fn();
    const setConnectionVisibility = vi.fn();
    await sessionObserverHandlers["sessions.observer.visibility"]?.({
      params: { visible: true },
      client: { connId: "conn-1" },
      context: { sessionObserver: { setConnectionVisibility } },
      respond,
    } as never);

    expect(setConnectionVisibility).toHaveBeenCalledWith("conn-1", true);
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it.each([{}, { visible: "true" }])("rejects invalid params %#", async (params) => {
    const respond = vi.fn();
    await sessionObserverHandlers["sessions.observer.visibility"]?.({
      params,
      client: { connId: "conn-1" },
      context: { sessionObserver: { setConnectionVisibility: vi.fn() } },
      respond,
    } as never);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
