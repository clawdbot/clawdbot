import { describe, expect, it, vi } from "vitest";
import { cleanupCodexAttempt } from "./run-attempt-cleanup.js";

describe("cleanupCodexAttempt", () => {
  it("preserves completion after a recovered turn-watch timeout", async () => {
    const cleanup = vi.fn(async (_reason: string) => undefined);
    const runCleanups = [cleanup];
    const runAbortController = new AbortController();
    const abortListener = () => undefined;
    const runCleanupStep = vi.fn(
      async (_step: string, operation: () => Promise<void> | void | undefined) => {
        await operation();
      },
    );
    const resources = {
      prompt: {
        context: {
          runtime: {
            connection: {
              params: {
                isFinalFallbackAttempt: false,
                sessionId: "session-1",
                sessionKey: "agent:main:dashboard:incognito-tool-cleanup",
                runId: "run-1",
              },
              options: {},
              runAbortController,
              terminalState: { turnSucceeded: true },
              bindingStore: {},
              bindingIdentity: {},
            },
          },
          attemptTools: {
            scheduledAppAuthoritySourceRef: {},
            runCleanups,
          },
        },
      },
      state: {
        trajectoryEndRecorded: true,
        thread: { threadId: "thread-1" },
        nativeHookRelay: undefined,
      },
      trajectoryRecorder: undefined,
      releaseCurrentRoute: vi.fn(),
      releaseSharedClientLeaseAndRetireOneShotClient: vi.fn(),
      releaseSandboxExecEnvironment: vi.fn(),
      runCleanupStep,
    };
    const turnRuntime = {
      state: {
        clientClosedAbort: false,
        timedOut: true,
        shouldDelayNativeHookRelayUnregister: false,
      },
      steeringQueueRef: {},
      userInputBridgeRef: {},
      turnWatches: { clearAllTimers: vi.fn() },
    };
    const lifecycle = {
      maybeEmitFastModeAutoResetBestEffort: vi.fn(),
      emitLifecycleTerminal: vi.fn(),
      buildLifecycleTerminalMeta: vi.fn(() => ({})),
    };
    const requestRuntime = {
      codexModelCallDiagnostics: { emitError: vi.fn() },
    };
    const activeTurn = {
      activeTurnId: "turn-1",
      abortListener,
      handle: {},
      freezeRunTerminalOutcome: vi.fn(),
    };

    await cleanupCodexAttempt(
      resources as never,
      turnRuntime as never,
      lifecycle as never,
      requestRuntime as never,
      activeTurn as never,
    );

    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith("completion");
    expect(runCleanups).toEqual([]);
    expect(runCleanupStep.mock.calls.map(([step]) => step)).toContain("codex-dynamic-tool-cleanup");
  });
});
