// Qa Lab tests cover Slack live adapter message reconciliation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "../../bus-state.js";

const mocks = vi.hoisted(() => ({
  acquireCaptureStore: vi.fn(),
  acquireCredentialLease: vi.fn(),
  captureRelease: vi.fn(),
  createCaptureReader: vi.fn(),
  credentialRelease: vi.fn(),
  getSlackIdentity: vi.fn(),
  heartbeatStop: vi.fn(),
  heartbeatThrowIfFailed: vi.fn(),
  prepareFlow: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/proxy-capture", () => ({
  acquireDebugProxyCaptureStore: mocks.acquireCaptureStore,
  createDebugProxyCaptureReader: mocks.createCaptureReader,
}));

vi.mock("../shared/credential-lease.runtime.js", () => ({
  acquireQaCredentialLease: mocks.acquireCredentialLease,
  startQaCredentialLeaseHeartbeat: () => ({
    stop: mocks.heartbeatStop,
    throwIfFailed: mocks.heartbeatThrowIfFailed,
    whenFailed: new Promise<Error>(() => {}),
  }),
}));

vi.mock("./scenario-environment.js", () => ({
  createSlackQaScenarioEnvironment: () => ({ prepareFlow: mocks.prepareFlow }),
}));

vi.mock("./slack-live.config.js", () => ({
  buildSlackQaConfig: () => ({}),
  parseSlackQaCredentialPayload: vi.fn(),
  resolveSlackQaRuntimeEnv: vi.fn(),
}));

vi.mock("./slack-live.message-observations.js", () => ({
  waitForSlackChannelStable: vi.fn(),
}));

vi.mock("./slack-live.observations.js", () => ({
  getSlackIdentity: mocks.getSlackIdentity,
  listSlackMessages: vi.fn(),
  listSlackThreadMessages: vi.fn(),
  sendSlackChannelMessage: vi.fn(),
}));

vi.mock("./slack-plugin.runtime.js", () => ({
  loadSlackQaRuntime: () => ({
    createSlackWebClient: vi.fn(() => ({})),
    createSlackWriteClient: vi.fn(() => ({})),
    resolveSlackWebClientOptions: vi.fn(() => ({ fetch: vi.fn() })),
  }),
}));

import { createSlackQaTransportAdapter, testing } from "./adapter.runtime.js";
import type { SlackQaFetchFunction as FetchFunction } from "./slack-live.contracts.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.acquireCaptureStore.mockReturnValue({
    store: {
      getSessionEvents: vi.fn(() => []),
      readBlob: vi.fn(() => null),
    },
    release: mocks.captureRelease,
  });
  mocks.createCaptureReader.mockReturnValue({
    getSessionEvents: vi.fn(() => []),
    readBlob: vi.fn(() => null),
  });
  mocks.acquireCredentialLease.mockResolvedValue({
    payload: {
      channelId: "C123",
      driverBotToken: "driver-token",
      sutAppToken: "sut-app-token",
      sutBotToken: "sut-token",
    },
    release: mocks.credentialRelease,
  });
  mocks.getSlackIdentity
    .mockResolvedValueOnce({ userId: "U-driver" })
    .mockResolvedValueOnce({ userId: "U-sut" });
  mocks.prepareFlow.mockResolvedValue({});
});

describe("Slack live adapter reconciliation", () => {
  it("reuses a read-only capture reader for the exact candidate runtime environment", async () => {
    const adapter = await createSlackQaTransportAdapter({
      messages: {
        addInboundMessage: vi.fn(),
        addOutboundMessage: vi.fn(),
        editMessage: vi.fn(),
      },
    } as never);
    const runtimeEnv = { OPENCLAW_STATE_DIR: "/candidate/state" };
    const input = {
      config: {},
      gateway: { runtimeEnv },
      outputDir: "/output",
      scenarioId: "slack-progress",
      scenarioTitle: "Slack progress",
      timeoutMs: 30_000,
      waitForConfigRestartSettle: vi.fn(),
    } as never;

    await adapter.prepareFlow?.(input);
    await adapter.prepareFlow?.(input);
    await adapter.cleanup?.();
    await adapter.cleanupAfterGatewayStop?.();

    expect(mocks.createCaptureReader).toHaveBeenCalledOnce();
    expect(mocks.createCaptureReader).toHaveBeenCalledWith({ env: runtimeEnv });
    expect(mocks.acquireCaptureStore).not.toHaveBeenCalled();
    expect(mocks.captureRelease).not.toHaveBeenCalled();
    expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
    expect(mocks.credentialRelease).toHaveBeenCalledOnce();
  });

  it("aborts an in-flight observer fetch when the adapter stops", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl: FetchFunction = async (_url, init) => {
      observedSignal = init?.signal;
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("observer aborted")), {
          once: true,
        });
      });
      throw new Error("unreachable");
    };
    const lifecycle = new AbortController();
    const request = new AbortController();

    const pending = testing.withSlackLifecycleSignal(fetchImpl, lifecycle.signal)(
      "https://slack.test",
      {
        signal: request.signal,
      },
    );
    lifecycle.abort();

    await expect(pending).rejects.toThrow("observer aborted");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("records streamed updates to the same Slack timestamp as bus edits", async () => {
    const state = createQaBusState();
    const busMessageIds = new Map<string, string>();
    const observedText = new Map<string, string>();
    const messages: Parameters<typeof testing.recordSlackObservedMessage>[0]["messages"] = {
      addInboundMessage: (input) => state.addInboundMessage(input),
      addOutboundMessage: (input) => state.addOutboundMessage(input),
      editMessage: (input) => state.editMessage(input),
    };
    const base = {
      accountId: "sut",
      busMessageIds,
      logicalConversationId: "C123",
      messages,
      observedText,
      sutUserId: "U123",
    };

    await testing.recordSlackObservedMessage({
      ...base,
      message: { text: "QA-", ts: "123.000001", user: "U123" },
    });
    await testing.recordSlackObservedMessage({
      ...base,
      message: { text: "QA-CHANNEL-BASELINE-OK", ts: "123.000001", user: "U123" },
    });

    const snapshot = state.getSnapshot();
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]?.text).toBe("QA-CHANNEL-BASELINE-OK");
    expect(snapshot.events.map((event) => event.kind)).toEqual([
      "outbound-message",
      "message-edited",
    ]);
  });

  it("maps observed thread replies to the root bus message", async () => {
    const state = createQaBusState();
    const root = state.addInboundMessage({
      accountId: "sut",
      conversation: { id: "C123", kind: "channel" },
      senderId: "U456",
      text: "root",
    });
    const busMessageIds = new Map([["123.000001", root.id]]);

    await testing.recordSlackObservedMessage({
      accountId: "sut",
      busMessageIds,
      logicalConversationId: "C123",
      message: {
        text: "thread reply",
        thread_ts: "123.000001",
        ts: "123.000002",
        user: "U123",
      },
      messages: {
        addInboundMessage: (input) => state.addInboundMessage(input),
        addOutboundMessage: (input) => state.addOutboundMessage(input),
        editMessage: (input) => state.editMessage(input),
      },
      observedText: new Map(),
      sutUserId: "U123",
    });

    expect(state.getSnapshot().messages.at(-1)).toMatchObject({
      direction: "outbound",
      text: "thread reply",
      threadId: root.id,
    });
  });
});
