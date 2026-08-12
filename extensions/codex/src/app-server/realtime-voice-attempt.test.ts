import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  closeClient: vi.fn(),
  createBridge: vi.fn(),
  createLifecycle: vi.fn(),
  createServerRequests: vi.fn(),
  createTurnState: vi.fn(),
  prepareConnection: vi.fn(),
  prepareContext: vi.fn(),
  preparePrompt: vi.fn(),
  prepareResources: vi.fn(),
  prepareRuntime: vi.fn(),
  prepareTools: vi.fn(),
  startRuntime: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("./attempt-client-cleanup.js", () => ({
  closeCodexStartupClientBestEffort: mocks.closeClient,
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS: 1_000,
  unsubscribeCodexThreadBestEffort: mocks.unsubscribe,
}));
vi.mock("./realtime-voice-session.js", () => ({
  createCodexAppServerRealtimeVoiceBridge: mocks.createBridge,
}));
vi.mock("./run-attempt-connection.js", () => ({
  prepareCodexAttemptConnection: mocks.prepareConnection,
}));
vi.mock("./run-attempt-context.js", () => ({ prepareCodexAttemptContext: mocks.prepareContext }));
vi.mock("./run-attempt-lifecycle-controller.js", () => ({
  createCodexAttemptLifecycleController: mocks.createLifecycle,
}));
vi.mock("./run-attempt-prompt.js", () => ({ prepareCodexAttemptPrompt: mocks.preparePrompt }));
vi.mock("./run-attempt-resources.js", () => ({
  prepareCodexAttemptResources: mocks.prepareResources,
}));
vi.mock("./run-attempt-runtime.js", () => ({ prepareCodexAttemptRuntime: mocks.prepareRuntime }));
vi.mock("./run-attempt-server-requests.js", () => ({
  createCodexAttemptServerRequestController: mocks.createServerRequests,
}));
vi.mock("./run-attempt-start.js", () => ({ startCodexAttemptRuntime: mocks.startRuntime }));
vi.mock("./run-attempt-tool-setup.js", () => ({ prepareCodexAttemptTools: mocks.prepareTools }));
vi.mock("./run-attempt-turn-state.js", () => ({
  createCodexAttemptTurnState: mocks.createTurnState,
}));

import { runCodexAppServerRealtimeVoiceSession } from "./realtime-voice-attempt.js";

function createAttemptParams(abortSignal: AbortSignal): AgentHarnessAttemptParamsV2 {
  return {
    sessionId: "session-1",
    abortSignal,
    realtimeVoice: {
      request: {
        providerConfig: {},
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
      },
      onBridgeReady: vi.fn(),
    },
  } as unknown as AgentHarnessAttemptParamsV2;
}

describe("Codex realtime voice attempt", () => {
  it("settles a host-aborted startup as a normal silent close", async () => {
    const abortController = new AbortController();
    mocks.prepareConnection.mockImplementationOnce(
      ({ params }: { params: AgentHarnessAttemptParamsV2 }) =>
        new Promise((_, reject) => {
          params.abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("codex app-server startup aborted")),
            { once: true },
          );
        }),
    );

    const attempt = runCodexAppServerRealtimeVoiceSession(
      createAttemptParams(abortController.signal),
      {} as never,
    );
    abortController.abort(new Error("voice session closed"));

    await expect(attempt).resolves.toMatchObject({
      terminal: { kind: "ok" },
      assistantTexts: ["NO_REPLY"],
    });
  });

  it("keeps non-abort startup failures terminal", async () => {
    mocks.prepareConnection.mockRejectedValueOnce(new Error("subscription auth failed"));

    await expect(
      runCodexAppServerRealtimeVoiceSession(
        createAttemptParams(new AbortController().signal),
        {} as never,
      ),
    ).rejects.toThrow("subscription auth failed");
  });

  it("releases a realtime thread published before startup fails", async () => {
    mocks.unsubscribe.mockClear();
    const runAbortController = new AbortController();
    const client = { closeAndWait: vi.fn() };
    const scopedDispose = vi.fn();
    const scheduledDispose = vi.fn();
    const releaseRoute = vi.fn();
    const releaseSandbox = vi.fn();
    const releaseLease = vi.fn();
    const resources = {
      state: {
        client,
        thread: { threadId: "thread-startup-failure" },
        nativeHookRelay: undefined,
      },
      releaseCurrentRoute: releaseRoute,
      releaseSandboxExecEnvironment: releaseSandbox,
      releaseSharedClientLeaseOnce: releaseLease,
      runCleanupStep: vi.fn(async (_step: string, operation: () => unknown) => {
        await operation();
      }),
    };
    mocks.prepareConnection.mockResolvedValueOnce({
      abortFromUpstream: vi.fn(),
      runAbortController,
    });
    mocks.prepareRuntime.mockResolvedValueOnce({});
    mocks.prepareTools.mockResolvedValueOnce({
      scopedMcpTools: { dispose: scopedDispose },
      scheduledConfiguredMcp: { dispose: scheduledDispose },
    });
    mocks.prepareContext.mockResolvedValueOnce({});
    mocks.preparePrompt.mockResolvedValueOnce({});
    mocks.prepareResources.mockReturnValueOnce(resources);
    mocks.startRuntime.mockRejectedValueOnce(new Error("post-start validation failed"));
    mocks.unsubscribe.mockResolvedValueOnce(true);

    await expect(
      runCodexAppServerRealtimeVoiceSession(
        createAttemptParams(new AbortController().signal),
        {} as never,
      ),
    ).rejects.toThrow("post-start validation failed");

    expect(mocks.unsubscribe).toHaveBeenCalledWith(client, {
      threadId: "thread-startup-failure",
      timeoutMs: 1_000,
    });
    expect(releaseRoute).toHaveBeenCalledOnce();
    expect(releaseSandbox).toHaveBeenCalledOnce();
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(scopedDispose).toHaveBeenCalledOnce();
    expect(scheduledDispose).toHaveBeenCalledOnce();
  });

  it.each([
    { released: true, expectedCloseCalls: 0 },
    { released: false, expectedCloseCalls: 1 },
  ])(
    "retires the client only when realtime thread unsubscribe returns $released",
    async ({ released, expectedCloseCalls }) => {
      mocks.closeClient.mockClear();
      const runAbortController = new AbortController();
      const routeAbortController = new AbortController();
      const client = { closeAndWait: vi.fn() };
      const releaseSharedClientLeaseOnce = vi.fn();
      const route = {
        signal: routeAbortController.signal,
        activate: vi.fn(async () => undefined),
      };
      const resources = {
        state: {
          client,
          thread: { threadId: "thread-1" },
          turnRoute: route,
          nativeHookRelay: undefined,
        },
        registerNativeSubagentMonitor: vi.fn(),
        releaseCurrentRoute: vi.fn(),
        releaseSandboxExecEnvironment: vi.fn(),
        releaseSharedClientLeaseOnce,
        runCleanupStep: vi.fn(async (_step: string, operation: () => unknown) => {
          await operation();
        }),
      };
      const turnState = {
        turnIdRef: { current: undefined },
        turnWatches: { clearAllTimers: vi.fn() },
        userInputBridgeRef: { current: undefined },
      };
      const bridge = {
        close: vi.fn(),
        completion: { promise: Promise.resolve("completed") },
        getFailure: vi.fn(),
        handleNotification: vi.fn(),
        handleRouteFailure: vi.fn(),
      };
      mocks.prepareConnection.mockResolvedValueOnce({
        abortFromUpstream: vi.fn(),
        runAbortController,
      });
      mocks.prepareRuntime.mockResolvedValueOnce({});
      mocks.prepareTools.mockResolvedValueOnce({
        scheduledConfiguredMcp: { dispose: vi.fn() },
        scopedMcpTools: { dispose: vi.fn() },
      });
      mocks.prepareContext.mockResolvedValueOnce({});
      mocks.preparePrompt.mockResolvedValueOnce({});
      mocks.prepareResources.mockReturnValueOnce(resources);
      mocks.startRuntime.mockResolvedValueOnce(undefined);
      mocks.createTurnState.mockReturnValueOnce(turnState);
      mocks.createLifecycle.mockReturnValueOnce({});
      mocks.createServerRequests.mockReturnValueOnce({ handleServerRequest: vi.fn() });
      mocks.createBridge.mockReturnValueOnce(bridge);
      mocks.unsubscribe.mockResolvedValueOnce(released);

      await expect(
        runCodexAppServerRealtimeVoiceSession(
          createAttemptParams(new AbortController().signal),
          {} as never,
        ),
      ).resolves.toMatchObject({ terminal: { kind: "ok" } });

      expect(mocks.closeClient).toHaveBeenCalledTimes(expectedCloseCalls);
      if (!released) {
        expect(mocks.closeClient.mock.invocationCallOrder[0]).toBeLessThan(
          releaseSharedClientLeaseOnce.mock.invocationCallOrder[0] ?? Infinity,
        );
      }
    },
  );
});
