import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMatrixTurnTakingCoordinator as createCoordinator,
  register,
  getTurnTakingCoordinatorCompletionMocks,
  resetTurnTakingCoordinatorTestMocks,
} from "./turn-taking-coordinator.test-fixtures.js";

function createMatrixTurnTakingCoordinator() {
  const coordinator = createCoordinator();
  register(coordinator, {
    accountId: "alpha",
    userId: "@alpha:example.org",
    getJoinedRoomMembers: vi.fn(async () => ["@alpha:example.org"]),
  });
  return coordinator;
}

const completionMocks = getTurnTakingCoordinatorCompletionMocks();

beforeEach(resetTurnTakingCoordinatorTestMocks);
afterEach(() => vi.useRealTimers());

describe("Matrix turn-taking coordinator: freshness", () => {
  it.each(["retired", "replaced"] as const)(
    "withholds context when the receiver is %s during access preparation",
    async (lifecycle) => {
      vi.useFakeTimers();
      const coordinator = createMatrixTurnTakingCoordinator();
      const joined = vi.fn(async () => ["@alpha:example.org", "@beta:example.org"]);
      register(coordinator, {
        accountId: "beta",
        userId: "@beta:example.org",
        getJoinedRoomMembers: joined,
      });
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prepareAccess = vi.fn(async () => {
        await hold;
        return {
          agentId: "agent-alpha",
          isDirectMessage: false,
          canParticipate: true,
          includesContext: () => true,
        };
      });
      const retire = register(coordinator, {
        accountId: "alpha",
        userId: "@alpha:example.org",
        getJoinedRoomMembers: joined,
        prepareAccess,
      });
      coordinator.observeMessage({
        roomId: "!lifecycle:example.org",
        eventId: "$newer",
        senderId: "@beta:example.org",
        body: "private sibling update",
      });
      const gate = coordinator.createFreshnessGate({
        cfg: {} as never,
        accountId: "alpha",
        agentId: "agent-alpha",
        roomId: "!lifecycle:example.org",
        selfUserId: "@alpha:example.org",
        triggerSenderId: "@human:example.org",
        triggerEventId: "$trigger",
        baselineSequence: 0,
        config: { enabled: true, redraftDepth: 1, nextStep: { decider: "ai" } },
        log: vi.fn(),
      })!;
      const pending = gate({
        runId: "run",
        sessionId: "session",
        provider: "full",
        model: "full-model",
        lastAssistantMessage: "draft",
        revisionAttempt: 0,
      });
      await vi.advanceTimersByTimeAsync(200);
      expect(prepareAccess).toHaveBeenCalledOnce();
      if (lifecycle === "retired") {
        retire();
      } else {
        register(coordinator, {
          accountId: "alpha",
          userId: "@alpha:example.org",
          getJoinedRoomMembers: joined,
        });
      }
      release();
      await expect(pending).resolves.toEqual({ action: "continue" });
      expect(completionMocks.prepare).not.toHaveBeenCalled();
      expect(completionMocks.complete).not.toHaveBeenCalled();
    },
  );

  it("refreshes the receiver policy before a second freshness snapshot", async () => {
    vi.useFakeTimers();
    const coordinator = createMatrixTurnTakingCoordinator();
    let includesSibling = true;
    const prepareAccess = vi.fn(async () => {
      const permitted = includesSibling;
      return {
        agentId: "agent-alpha",
        isDirectMessage: false,
        canParticipate: true,
        includesContext: () => permitted,
      };
    });
    coordinator.configureMonitorAccess("alpha", prepareAccess);
    const gate = coordinator.createFreshnessGate({
      cfg: {} as never,
      accountId: "alpha",
      agentId: "agent-alpha",
      roomId: "!policy:example.org",
      selfUserId: "@alpha:example.org",
      triggerSenderId: "@human:example.org",
      triggerEventId: "$trigger",
      baselineSequence: 0,
      config: { enabled: true, redraftDepth: 2, nextStep: { decider: "user", action: "redraft" } },
      log: vi.fn(),
    })!;
    const finalize = () =>
      gate({
        runId: "run",
        sessionId: "session",
        provider: "full",
        model: "full-model",
        lastAssistantMessage: "draft",
        revisionAttempt: 0,
      });
    coordinator.observeMessage({
      roomId: "!policy:example.org",
      eventId: "$first",
      senderId: "@beta:example.org",
      body: "allowed update",
    });
    const first = finalize();
    await vi.advanceTimersByTimeAsync(200);
    await expect(first).resolves.toMatchObject({
      action: "revise",
      instruction: expect.stringContaining("allowed update"),
    });
    includesSibling = false;
    coordinator.observeMessage({
      roomId: "!policy:example.org",
      eventId: "$second",
      senderId: "@beta:example.org",
      body: "now excluded",
    });
    const second = finalize();
    await vi.advanceTimersByTimeAsync(200);
    await expect(second).resolves.toEqual({ action: "continue" });
    expect(prepareAccess).toHaveBeenCalledTimes(2);
  });

  it("rechecks room activity that arrives while the AI next-step decision is pending", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = createMatrixTurnTakingCoordinator();
      coordinator.observeMessage({
        roomId: "!decision-race:example.org",
        eventId: "$trigger",
        senderId: "@human:example.org",
        body: "question",
      });
      const baselineSequence = coordinator.currentSequence();
      coordinator.observeMessage({
        roomId: "!decision-race:example.org",
        eventId: "$first-newer",
        senderId: "@beta:example.org",
        body: "I started answering",
      });
      let resolveFirstDecision: ((value: { text: string }) => void) | undefined;
      completionMocks.complete
        .mockImplementationOnce(
          async () =>
            await new Promise<{ text: string }>((resolve) => {
              resolveFirstDecision = resolve;
            }),
        )
        .mockResolvedValueOnce({ text: '{"action":"redraft"}' });
      const gate = coordinator.createFreshnessGate({
        accountId: "alpha",
        triggerSenderId: "@human:example.org",
        cfg: {} as never,
        agentId: "agent-alpha",
        roomId: "!decision-race:example.org",
        selfUserId: "@alpha:example.org",
        baselineSequence,
        triggerEventId: "$trigger",
        config: { enabled: true, redraftDepth: 1, nextStep: { decider: "ai" } },
        log: vi.fn(),
      })!;
      const pending = gate({
        runId: "run",
        sessionId: "session",
        provider: "full",
        model: "full-model",
        lastAssistantMessage: "Original draft",
        revisionAttempt: 0,
      });
      await vi.advanceTimersByTimeAsync(200);
      expect(completionMocks.complete).toHaveBeenCalledOnce();

      const releaseSecondActivity = coordinator.beginIngressObservation({
        roomId: "!decision-race:example.org",
        eventId: "$second-newer",
        senderId: "@gamma:example.org",
        accountId: "gamma",
      });
      resolveFirstDecision?.({ text: '{"action":"send-as-is"}' });
      await Promise.resolve();
      expect(completionMocks.complete).toHaveBeenCalledOnce();
      coordinator.observeMessage({
        roomId: "!decision-race:example.org",
        eventId: "$second-newer",
        senderId: "@gamma:example.org",
        body: "That issue is already fixed",
      });
      releaseSecondActivity();

      await expect(pending).resolves.toMatchObject({
        action: "revise",
        instruction: expect.stringContaining("That issue is already fixed"),
      });
      expect(completionMocks.complete).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not miss an already-arrived Matrix event whose handler journals it after the first snapshot", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = createMatrixTurnTakingCoordinator();
      coordinator.observeMessage({
        roomId: "!delayed-ingress:example.org",
        eventId: "$trigger",
        senderId: "@human:example.org",
        body: "Use tags in the answer",
      });
      const releaseCorrection = coordinator.beginIngressObservation({
        roomId: "!delayed-ingress:example.org",
        eventId: "$correction",
        senderId: "@human:example.org",
        accountId: "alpha",
      });
      const gate = coordinator.createFreshnessGate({
        accountId: "alpha",
        triggerSenderId: "@human:example.org",
        cfg: {} as never,
        agentId: "agent-alpha",
        roomId: "!delayed-ingress:example.org",
        selfUserId: "@alpha:example.org",
        baselineSequence: coordinator.currentSequence(),
        triggerEventId: "$trigger",
        config: {
          enabled: true,
          redraftDepth: 1,
          nextStep: { decider: "user", action: "redraft" },
        },
        log: vi.fn(),
      })!;
      const pending = gate({
        runId: "run",
        sessionId: "session",
        provider: "full",
        model: "full-model",
        lastAssistantMessage: "@Sentinel old tagged answer",
        revisionAttempt: 0,
      });
      await vi.advanceTimersByTimeAsync(200);
      coordinator.observeMessage({
        roomId: "!delayed-ingress:example.org",
        eventId: "$correction",
        senderId: "@human:example.org",
        body: "Don't use @ tags for this exercise",
      });
      releaseCorrection();

      await expect(pending).resolves.toMatchObject({
        action: "revise",
        instruction: expect.stringContaining("Don't use @ tags"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a dropped event only after every account handler settles without inventing freshness", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = createMatrixTurnTakingCoordinator();
      const releaseAlpha = coordinator.beginIngressObservation({
        roomId: "!dropped-ingress:example.org",
        eventId: "$dropped",
        senderId: "@blocked:example.org",
        accountId: "alpha",
      });
      const releaseBeta = coordinator.beginIngressObservation({
        roomId: "!dropped-ingress:example.org",
        eventId: "$dropped",
        senderId: "@blocked:example.org",
        accountId: "beta",
      });
      const gate = coordinator.createFreshnessGate({
        accountId: "alpha",
        triggerSenderId: "@human:example.org",
        cfg: {} as never,
        agentId: "agent-alpha",
        roomId: "!dropped-ingress:example.org",
        selfUserId: "@alpha:example.org",
        baselineSequence: coordinator.currentSequence(),
        triggerEventId: "$trigger",
        config: {
          enabled: true,
          redraftDepth: 1,
          nextStep: { decider: "user", action: "redraft" },
        },
        log: vi.fn(),
      })!;
      let settled = false;
      const pending = Promise.resolve(
        gate({
          runId: "run",
          sessionId: "session",
          provider: "full",
          model: "full-model",
          lastAssistantMessage: "draft",
          revisionAttempt: 0,
        }),
      ).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(200);
      releaseAlpha();
      await Promise.resolve();
      expect(settled).toBe(false);
      releaseBeta();

      await expect(pending).resolves.toEqual({ action: "continue" });
      expect(completionMocks.complete).not.toHaveBeenCalled();
      expect(
        coordinator.readFreshness({
          view: { includesContext: () => true },
          roomId: "!dropped-ingress:example.org",
          afterSequence: 0,
        }).entries,
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces six account handlers for one native event and keeps other-thread text out of context", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = createMatrixTurnTakingCoordinator();
      const releases = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].map((accountId) =>
        coordinator.beginIngressObservation({
          roomId: "!six-monitors:example.org",
          eventId: "$one-native-event",
          senderId: "@human:example.org",
          accountId,
        }),
      );
      const gate = coordinator.createFreshnessGate({
        accountId: "alpha",
        triggerSenderId: "@human:example.org",
        cfg: {} as never,
        agentId: "agent-alpha",
        roomId: "!six-monitors:example.org",
        threadId: "$thread-a",
        selfUserId: "@alpha:example.org",
        baselineSequence: coordinator.currentSequence(),
        triggerEventId: "$trigger",
        config: {
          enabled: true,
          redraftDepth: 1,
          nextStep: { decider: "user", action: "redraft" },
        },
        log: vi.fn(),
      })!;
      let settled = false;
      const pending = Promise.resolve(
        gate({
          runId: "run",
          sessionId: "session",
          provider: "full",
          model: "full-model",
          lastAssistantMessage: "thread A draft",
          revisionAttempt: 0,
        }),
      ).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(200);
      for (const release of releases.slice(0, -1)) {
        release();
      }
      await Promise.resolve();
      expect(settled).toBe(false);
      coordinator.observeMessage({
        roomId: "!six-monitors:example.org",
        threadId: "$thread-b",
        eventId: "$one-native-event",
        senderId: "@human:example.org",
        body: "activity in thread B",
      });
      releases.at(-1)?.();

      await expect(pending).resolves.toEqual({ action: "continue" });
      expect(completionMocks.complete).not.toHaveBeenCalled();
      expect(
        coordinator.readFreshness({
          view: { includesContext: () => true },
          roomId: "!six-monitors:example.org",
          threadId: "$thread-b",
          afterSequence: 0,
        }).entries,
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a slower account re-register an event that is already journaled", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = createMatrixTurnTakingCoordinator();
      coordinator.observeMessage({
        roomId: "!late-monitor:example.org",
        eventId: "$already-observed",
        senderId: "@human:example.org",
        body: "already in the exact-thread journal",
      });
      const releaseLateMonitor = coordinator.beginIngressObservation({
        roomId: "!late-monitor:example.org",
        eventId: "$already-observed",
        senderId: "@human:example.org",
        accountId: "late-monitor",
      });
      const gate = coordinator.createFreshnessGate({
        accountId: "alpha",
        triggerSenderId: "@human:example.org",
        cfg: {} as never,
        agentId: "agent-alpha",
        roomId: "!late-monitor:example.org",
        selfUserId: "@alpha:example.org",
        baselineSequence: coordinator.currentSequence(),
        triggerEventId: "$trigger",
        config: {
          enabled: true,
          redraftDepth: 1,
          nextStep: { decider: "user", action: "redraft" },
        },
        log: vi.fn(),
      })!;
      let settled = false;
      const pending = Promise.resolve(
        gate({
          runId: "run",
          sessionId: "session",
          provider: "full",
          model: "full-model",
          lastAssistantMessage: "draft",
          revisionAttempt: 0,
        }),
      ).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(200);

      expect(settled).toBe(true);
      await expect(pending).resolves.toEqual({ action: "continue" });
      releaseLateMonitor();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out and removes a wedged ingress record without delaying the next gate", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = createMatrixTurnTakingCoordinator();
      const release = coordinator.beginIngressObservation({
        roomId: "!wedged-ingress:example.org",
        eventId: "$wedged",
        senderId: "@human:example.org",
        accountId: "alpha",
      });
      const log = vi.fn();
      const gate = coordinator.createFreshnessGate({
        accountId: "alpha",
        triggerSenderId: "@human:example.org",
        cfg: {} as never,
        agentId: "agent-alpha",
        roomId: "!wedged-ingress:example.org",
        selfUserId: "@alpha:example.org",
        baselineSequence: coordinator.currentSequence(),
        triggerEventId: "$trigger",
        config: {
          enabled: true,
          redraftDepth: 1,
          nextStep: { decider: "user", action: "redraft" },
        },
        log,
      })!;
      const first = gate({
        runId: "run",
        sessionId: "session",
        provider: "full",
        model: "full-model",
        lastAssistantMessage: "draft",
        revisionAttempt: 0,
      });
      await vi.advanceTimersByTimeAsync(5_200);

      await expect(first).resolves.toEqual({ action: "continue" });
      expect(log).toHaveBeenCalledWith(expect.stringContaining("freshness ingress wait timed out"));

      const second = gate({
        runId: "run",
        sessionId: "session",
        provider: "full",
        model: "full-model",
        lastAssistantMessage: "second draft",
        revisionAttempt: 0,
      });
      await vi.advanceTimersByTimeAsync(200);
      await expect(second).resolves.toEqual({ action: "continue" });
      release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait on an ingress event sent by the replying account itself", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = createMatrixTurnTakingCoordinator();
      const release = coordinator.beginIngressObservation({
        roomId: "!self-ingress:example.org",
        eventId: "$self",
        senderId: "@alpha:example.org",
        accountId: "beta",
      });
      const gate = coordinator.createFreshnessGate({
        accountId: "alpha",
        triggerSenderId: "@human:example.org",
        cfg: {} as never,
        agentId: "agent-alpha",
        roomId: "!self-ingress:example.org",
        selfUserId: "@alpha:example.org",
        baselineSequence: 0,
        triggerEventId: "$trigger",
        config: {
          enabled: true,
          redraftDepth: 1,
          nextStep: { decider: "user", action: "redraft" },
        },
        log: vi.fn(),
      })!;
      const pending = gate({
        runId: "run",
        sessionId: "session",
        provider: "full",
        model: "full-model",
        lastAssistantMessage: "draft",
        revisionAttempt: 0,
      });
      await vi.advanceTimersByTimeAsync(200);

      await expect(pending).resolves.toEqual({ action: "continue" });
      release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a replayed control event's original baseline behind newer room activity", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = createMatrixTurnTakingCoordinator();
      const originalBaseline = coordinator.observeMessage({
        roomId: "!control-replay:example.org",
        eventId: "$control",
        senderId: "@human:example.org",
        body: "/new",
      });
      coordinator.observeMessage({
        roomId: "!control-replay:example.org",
        eventId: "$newer",
        senderId: "@beta:example.org",
        body: "I already answered",
      });
      const replayBaseline = coordinator.observeMessage({
        roomId: "!control-replay:example.org",
        eventId: "$control",
        senderId: "@human:example.org",
        body: "/new",
      });

      expect(originalBaseline).toBe(1);
      expect(replayBaseline).toBe(originalBaseline);
      expect(coordinator.currentSequence()).toBe(2);

      const gate = coordinator.createFreshnessGate({
        accountId: "alpha",
        triggerSenderId: "@human:example.org",
        cfg: {} as never,
        agentId: "agent-alpha",
        roomId: "!control-replay:example.org",
        selfUserId: "@alpha:example.org",
        baselineSequence: replayBaseline!,
        triggerEventId: "$control",
        config: {
          enabled: true,
          redraftDepth: 1,
          nextStep: { decider: "user", action: "redraft" },
        },
        log: vi.fn(),
      })!;
      const pending = gate({
        runId: "run",
        sessionId: "session",
        provider: "full",
        model: "full-model",
        lastAssistantMessage: "stale draft",
        revisionAttempt: 0,
      });
      await vi.advanceTimersByTimeAsync(200);

      await expect(pending).resolves.toMatchObject({
        action: "revise",
        instruction: expect.stringContaining("I already answered"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables freshness checks entirely at redraftDepth zero", () => {
    const coordinator = createMatrixTurnTakingCoordinator();
    expect(
      coordinator.createFreshnessGate({
        accountId: "alpha",
        triggerSenderId: "@human:example.org",
        cfg: {} as never,
        agentId: "agent-alpha",
        roomId: "!room:example.org",
        selfUserId: "@alpha:example.org",
        baselineSequence: 0,
        triggerEventId: "$trigger",
        config: { enabled: true, redraftDepth: 0, nextStep: { decider: "ai" } },
        log: vi.fn(),
      }),
    ).toBeUndefined();
  });

  it("fails open to send-as-is when the AI next-step response is malformed", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = createMatrixTurnTakingCoordinator();
      coordinator.observeMessage({
        roomId: "!next-step:example.org",
        eventId: "$trigger",
        senderId: "@human:example.org",
        body: "question",
      });
      const baselineSequence = coordinator.currentSequence();
      coordinator.observeMessage({
        roomId: "!next-step:example.org",
        eventId: "$newer",
        senderId: "@beta:example.org",
        body: "new detail",
      });
      completionMocks.complete.mockResolvedValue({ text: "not strict JSON" });
      const gate = coordinator.createFreshnessGate({
        accountId: "alpha",
        triggerSenderId: "@human:example.org",
        cfg: {} as never,
        agentId: "agent-alpha",
        roomId: "!next-step:example.org",
        selfUserId: "@alpha:example.org",
        baselineSequence,
        triggerEventId: "$trigger",
        triggerRequest: "Both agent-alpha and agent-beta should answer",
        config: { enabled: true, redraftDepth: 1, nextStep: { decider: "ai" } },
        log: vi.fn(),
      })!;
      const pending = gate({
        runId: "run",
        sessionId: "session",
        provider: "full-provider",
        model: "full-model",
        lastAssistantMessage: "draft",
        revisionAttempt: 0,
      });
      await vi.advanceTimersByTimeAsync(200);

      await expect(pending).resolves.toEqual({ action: "continue" });
      expect(completionMocks.prepare).toHaveBeenCalledWith(
        expect.objectContaining({ useUtilityModel: true }),
      );
      const nextStepCall = completionMocks.complete.mock.calls[0]?.[0] as {
        context: {
          systemPrompt?: string;
          messages: Array<{ role: string; content: string; timestamp: number }>;
          tools?: unknown[];
        };
      };
      expect(nextStepCall.context.systemPrompt).toContain("Choose what to do");
      expect(nextStepCall.context.messages).toHaveLength(1);
      expect(nextStepCall.context.messages[0]?.role).toBe("user");
      expect(nextStepCall.context.messages[0]?.timestamp).toEqual(expect.any(Number));
      expect(nextStepCall.context.tools).toEqual([]);
      expect(JSON.parse(nextStepCall.context.messages[0]?.content ?? "{}")).toMatchObject({
        roomId: "!next-step:example.org",
        triggerRequest: "Both agent-alpha and agent-beta should answer",
        draft: "draft",
        newerActivity: [expect.objectContaining({ eventId: "$newer" })],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the AI discard a late fruit reply after a plain human stop message", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = createMatrixTurnTakingCoordinator();
      coordinator.observeMessage({
        roomId: "!fruit:example.org",
        eventId: "$trigger",
        senderId: "@human:example.org",
        body: "Name some fruit",
      });
      const baselineSequence = coordinator.currentSequence();
      coordinator.observeMessage({
        roomId: "!fruit:example.org",
        eventId: "$enough",
        senderId: "@human:example.org",
        body: "Ok, that's enough fruit.",
      });
      completionMocks.complete.mockResolvedValue({ text: '{"action":"discard"}' });
      const onDiscardAccepted = vi.fn();
      const gate = coordinator.createFreshnessGate({
        accountId: "alpha",
        triggerSenderId: "@human:example.org",
        cfg: {} as never,
        agentId: "agent-alpha",
        roomId: "!fruit:example.org",
        selfUserId: "@alpha:example.org",
        baselineSequence,
        triggerEventId: "$trigger",
        onDiscardAccepted,
        config: { enabled: true, redraftDepth: 1, nextStep: { decider: "ai" } },
        log: vi.fn(),
      })!;
      const pending = gate({
        runId: "run",
        sessionId: "session",
        provider: "full",
        model: "full-model",
        lastAssistantMessage: "Mango",
        revisionAttempt: 0,
      });
      await vi.advanceTimersByTimeAsync(200);

      const result = await pending;
      expect(result).toEqual({ action: "discard", onAccepted: onDiscardAccepted });
      expect(completionMocks.complete).toHaveBeenCalledOnce();
      expect(onDiscardAccepted).not.toHaveBeenCalled();
      if (result.action === "discard") {
        await result.onAccepted?.({ isSourceLive: () => true });
      }
      expect(onDiscardAccepted).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
