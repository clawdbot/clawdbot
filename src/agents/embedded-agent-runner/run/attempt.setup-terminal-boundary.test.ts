import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentRunTerminalOutcomeFromAttempt,
  projectAgentRunAttemptTerminal,
} from "../../agent-run-terminal-outcome.js";
import { createCandidateAgentDurationOwner } from "../../command/candidate-agent-duration.js";
import {
  cleanupTempPaths,
  createDefaultEmbeddedSession,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

describe("runEmbeddedAttempt setup terminal boundary", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it.each([
    { name: "error", error: new Error("sandbox setup failed") },
    {
      name: "abort",
      error: Object.assign(new Error("sandbox setup aborted"), { name: "AbortError" }),
    },
    {
      name: "timeout",
      error: Object.assign(new Error("sandbox setup timed out"), { name: "TimeoutError" }),
    },
  ])("ends agent timing before outer cleanup for a setup $name", async ({ error }) => {
    const events: string[] = [];
    let now = 10;
    const observeAgentDuration = vi.fn();
    const runtimeSelected = vi.fn();
    const durationOwner = createCandidateAgentDurationOwner(observeAgentDuration, () => now);
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    hoisted.resolveSandboxContextMock.mockRejectedValueOnce(error);

    const attempt = (async () => {
      try {
        return await createContextEngineAttemptRunner({
          contextEngine: createContextEngineBootstrapAndAssemble(),
          sessionKey: `agent:main:setup-${error.name}`,
          tempPaths,
          accountingObservers: {
            onAgentTerminal: () => {
              events.push("terminal");
              durationOwner.markTerminal();
            },
            onRuntimeSelected: runtimeSelected,
          },
        });
      } finally {
        events.push("cleanup-start");
        now = 10_000;
        await cleanupGate;
        durationOwner.markTerminal();
        events.push("cleanup-end");
      }
    })();
    const rejection = attempt.catch((caught: unknown) => caught);

    await vi.waitFor(() => {
      expect(events).toEqual(["terminal", "cleanup-start"]);
    });
    expect(observeAgentDuration).toHaveBeenCalledTimes(1);
    expect(observeAgentDuration).toHaveBeenCalledWith(0);
    expect(runtimeSelected).not.toHaveBeenCalled();
    expect(hoisted.createAgentSessionMock).not.toHaveBeenCalled();

    releaseCleanup();
    await expect(rejection).resolves.toBe(error);
    expect(events).toEqual(["terminal", "cleanup-start", "cleanup-end"]);
    expect(observeAgentDuration).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "error", error: new Error("session runtime failed") },
    {
      name: "abort",
      error: Object.assign(new Error("session runtime aborted"), { name: "AbortError" }),
    },
    {
      name: "timeout",
      error: Object.assign(new Error("session runtime timed out"), { name: "TimeoutError" }),
    },
  ])("ends agent timing before session cleanup for a runtime $name", async ({ error }) => {
    const events: string[] = [];
    let now = 10;
    const observeAgentDuration = vi.fn();
    const runtimeSelected = vi.fn();
    const prompt = vi.fn(async () => {});
    const durationOwner = createCandidateAgentDurationOwner(observeAgentDuration, () => now);
    const resolveMessage = vi.fn(async () => ({
      role: "user" as const,
      content: "hello",
      timestamp: 1,
    }));
    const waitForRuntimePersistence = vi.fn(async () => {
      now = 45;
      throw error;
    });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    hoisted.flushPendingToolResultsAfterIdleMock.mockImplementationOnce(async () => {
      events.push("cleanup-start");
      now = 10_000;
      await cleanupGate;
      events.push("cleanup-end");
      throw new Error("cleanup failed");
    });

    const attempt = createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: `agent:main:session-runtime-${error.name}`,
      tempPaths,
      sessionPrompt: prompt,
      accountingObservers: {
        onAgentTerminal: () => {
          events.push("terminal");
          durationOwner.markTerminal();
        },
        onRuntimeSelected: runtimeSelected,
      },
      attemptOverrides: {
        userTurnTranscriptRecorder: {
          resolveMessage,
          waitForRuntimePersistence,
        } as never,
      },
    });
    const rejection = attempt.catch((caught: unknown) => caught);

    await vi.waitFor(() => {
      expect(events).toEqual(["terminal", "cleanup-start"]);
    });
    expect(observeAgentDuration).toHaveBeenCalledTimes(1);
    expect(observeAgentDuration).toHaveBeenCalledWith(35);
    expect(runtimeSelected).not.toHaveBeenCalled();
    expect(hoisted.createAgentSessionMock).toHaveBeenCalledOnce();
    expect(resolveMessage).toHaveBeenCalledOnce();
    expect(waitForRuntimePersistence).toHaveBeenCalledOnce();
    expect(prompt).not.toHaveBeenCalled();

    releaseCleanup();
    await expect(rejection).resolves.toBe(error);
    expect(events).toEqual(["terminal", "cleanup-start", "cleanup-end"]);
    expect(hoisted.flushPendingToolResultsAfterIdleMock).toHaveBeenCalledOnce();
    expect(observeAgentDuration).toHaveBeenCalledTimes(1);
  });

  it("surfaces a session disposal failure after a successful attempt", async () => {
    const cleanupError = new Error("session disposal failed");
    const dispose = vi.fn(() => {
      throw cleanupError;
    });

    await expect(
      createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:successful-cleanup-failure",
        tempPaths,
        createSession: () => {
          const session = createDefaultEmbeddedSession();
          session.dispose = dispose;
          return session;
        },
      }),
    ).rejects.toBe(cleanupError);

    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "false", reason: false },
    { name: "zero", reason: 0 },
    { name: "empty string", reason: "" },
    { name: "null", reason: null },
    { name: "undefined", reason: undefined },
  ])(
    "keeps a $name prompt rejection terminal over session disposal failure",
    async ({ name, reason }) => {
      const cleanupError = new Error(`session disposal failed after ${name}`);
      const dispose = vi.fn(() => {
        throw cleanupError;
      });
      const result = await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: `agent:main:falsy-prompt-${name.replaceAll(" ", "-")}`,
        tempPaths,
        createSession: () => {
          const session = createDefaultEmbeddedSession({
            // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Exercise hostile provider rejection payloads.
            prompt: async () => await Promise.reject(reason),
          });
          session.dispose = dispose;
          return session;
        },
      });

      expect(result.terminal).toMatchObject({ kind: "failed", source: "prompt" });
      const projected = projectAgentRunAttemptTerminal(result.terminal);
      expect(projected.failed).toBe(true);
      expect(projected.promptFailure?.error).toBeInstanceOf(Error);
      const normalizedError = projected.promptFailure?.error as Error & { cause?: unknown };
      if (typeof reason === "string") {
        expect(normalizedError.message).toBe(reason);
      } else {
        expect(normalizedError.message).toBe("Non-Error rejection");
        expect(normalizedError.cause).toBe(reason);
      }
      expect(buildAgentRunTerminalOutcomeFromAttempt({ terminal: result.terminal })).toMatchObject({
        reason: "failed",
        status: "error",
      });
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      name: "abort",
      error: Object.assign(new Error("runtime aborted"), { name: "AbortError" }),
    },
    {
      name: "timeout",
      error: Object.assign(new Error("runtime timed out"), { name: "TimeoutError" }),
    },
  ])("keeps a terminal $name primary over session disposal failure", async ({ error }) => {
    const cleanupError = new Error("session disposal failed");
    const dispose = vi.fn(() => {
      throw cleanupError;
    });
    const resolveMessage = vi.fn(async () => ({
      role: "user" as const,
      content: "hello",
      timestamp: 1,
    }));
    const waitForRuntimePersistence = vi.fn(async () => {
      throw error;
    });

    const attempt = createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: `agent:main:${error.name}-cleanup-failure`,
      tempPaths,
      createSession: () => {
        const session = createDefaultEmbeddedSession();
        session.dispose = dispose;
        return session;
      },
      attemptOverrides: {
        userTurnTranscriptRecorder: {
          resolveMessage,
          waitForRuntimePersistence,
        } as never,
      },
    });

    await expect(attempt).rejects.toBe(error);
    expect(dispose).toHaveBeenCalledOnce();
    expect(resolveMessage).toHaveBeenCalledOnce();
    expect(waitForRuntimePersistence).toHaveBeenCalledOnce();
  });

  it("keeps a resolved external abort result over session disposal failure", async () => {
    const abortController = new AbortController();
    const abortError = Object.assign(new Error("external abort"), { name: "AbortError" });
    const cleanupError = new Error("session disposal failed");
    const dispose = vi.fn(() => {
      throw cleanupError;
    });

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:resolved-abort-cleanup-failure",
      tempPaths,
      createSession: () => {
        const session = createDefaultEmbeddedSession({
          prompt: async () => {
            abortController.abort(abortError);
            await Promise.resolve();
          },
        });
        session.dispose = dispose;
        return session;
      },
      attemptOverrides: {
        abortSignal: abortController.signal,
      },
    });

    expect(result.terminal).toMatchObject({ kind: "aborted", source: "external" });
    expect(
      buildAgentRunTerminalOutcomeFromAttempt({
        terminal: result.terminal,
        abortSignal: abortController.signal,
      }),
    ).toMatchObject({ status: "error", stopReason: "aborted" });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("keeps a resolved run-budget timeout result over session disposal failure", async () => {
    const cleanupError = new Error("session disposal failed");
    const dispose = vi.fn(() => {
      throw cleanupError;
    });
    let releasePendingEvents!: () => void;
    const pendingEvents = new Promise<void>((resolve) => {
      releasePendingEvents = resolve;
    });
    const baseSubscribe = hoisted.subscribeEmbeddedAgentSessionMock.getMockImplementation();
    if (!baseSubscribe) {
      throw new Error("missing embedded subscription mock");
    }
    hoisted.subscribeEmbeddedAgentSessionMock.mockImplementation((params) => ({
      ...baseSubscribe(params),
      waitForPendingEvents: async () => await pendingEvents,
    }));

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:resolved-timeout-cleanup-failure",
      tempPaths,
      sessionPrompt: async () => {},
      createSession: () => {
        const session = createDefaultEmbeddedSession();
        session.dispose = dispose;
        return session;
      },
      attemptOverrides: {
        timeoutMs: 20,
        onAttemptTimeout: () => releasePendingEvents(),
      },
    });

    expect(result.terminal).toMatchObject({
      kind: "timeout",
      phase: "prompt",
      source: "run_budget",
    });
    expect(result.terminal).not.toMatchObject({ source: "runtime" });
    expect(buildAgentRunTerminalOutcomeFromAttempt({ terminal: result.terminal })).toMatchObject({
      reason: "hard_timeout",
      status: "timeout",
      timeoutPhase: "provider",
    });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
