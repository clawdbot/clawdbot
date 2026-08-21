import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
/**
 * Tests talk realtime relay event forwarding and connection cleanup.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setActiveEmbeddedRun } from "../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../agents/embedded-agent-runner/runs.test-support.js";
import {
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { clientVoiceSessionTesting } from "../talk/client-voice-session.test-support.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "../talk/provider-types.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { createChatRunState } from "./server-chat-state.js";
import { drainingRelaySessions, relaySessions } from "./talk-realtime-relay-state.js";
import { MAX_RELAY_TOOL_CALL_IDENTITIES } from "./talk-realtime-relay-tool-call-ledger.js";
import {
  acknowledgeTalkRealtimeRelayMark,
  cancelTalkRealtimeRelayTurn,
  createTalkRealtimeRelaySession as createTalkRealtimeRelaySessionRaw,
  ensureTalkRealtimeRelayVoiceSession,
  flushTalkRealtimeRelayVoiceWrites,
  registerTalkRealtimeRelayAgentRun,
  sendTalkRealtimeRelayAudio,
  steerTalkRealtimeRelayAgentRun,
  stopTalkRealtimeRelaySession as stopTalkRealtimeRelaySessionRaw,
  submitTalkRealtimeRelayToolResult,
} from "./talk-realtime-relay.js";
import { cleanupTalkConnection } from "./talk-session-registry.js";

const activeRelaySessions = new Map<string, string>();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeRelayTransport<Overrides extends Partial<RealtimeVoiceBridge> = Record<never, never>>(
  overrides: Overrides = {} as Overrides,
) {
  return {
    connect: vi.fn(async () => undefined),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    handleBargeIn: vi.fn(),
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn(() => true),
    ...overrides,
  };
}

function createTalkRealtimeRelaySession(
  params: Parameters<typeof createTalkRealtimeRelaySessionRaw>[0],
): ReturnType<typeof createTalkRealtimeRelaySessionRaw> {
  const session = createTalkRealtimeRelaySessionRaw({
    cfg: { agents: { entries: { main: { default: true } } } },
    ...params,
  });
  activeRelaySessions.set(session.relaySessionId, params.connId);
  return session;
}

function stopTalkRealtimeRelaySession(
  params: Parameters<typeof stopTalkRealtimeRelaySessionRaw>[0],
): void {
  stopTalkRealtimeRelaySessionRaw(params);
  activeRelaySessions.delete(params.relaySessionId);
}

function ensureActiveRelayTurnId(relaySessionId: string): string {
  const relay = relaySessions.get(relaySessionId);
  if (!relay) {
    throw new Error(`Missing relay test session ${relaySessionId}`);
  }
  if (!relay.harness.talk.activeTurnId) {
    relay.harness.talk.startTurn({ turnId: "turn-1" });
  }
  return relay.harness.talk.activeTurnId ?? "turn-1";
}

describe("talk realtime gateway relay", () => {
  it.each([
    [
      { status: "failed" as const, responseId: "response-1", message: "provider failed" },
      "turn.ended",
    ],
    [
      {
        status: "incomplete" as const,
        responseId: "response-1",
        reason: "max_output_tokens",
        message: "provider response incomplete",
      },
      "turn.ended",
    ],
    [
      { status: "cancelled" as const, responseId: "response-1", reason: "client_cancelled" },
      "turn.cancelled",
    ],
  ])("keeps a relay reusable after each terminal response", async (outcome, terminalType) => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const close = vi.fn();
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (request) => {
        bridgeRequest = request;
        return makeRelayTransport({ close });
      },
    };
    const events: Array<{ payload: unknown }> = [];
    const context = {
      broadcastToConnIds: (_event: string, payload: unknown) => events.push({ payload }),
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
    });
    await Promise.resolve();
    if (!bridgeRequest) {
      throw new Error("expected realtime bridge request");
    }

    void sendTalkRealtimeRelayAudio({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      audioBase64: Buffer.from("first").toString("base64"),
      timestamp: 1,
    });
    bridgeRequest.onEvent?.({
      direction: "server",
      type: "response.created",
      responseId: outcome.responseId,
    });
    bridgeRequest.onResponseDone?.(outcome);
    bridgeRequest.onEvent?.({
      direction: "server",
      responseId: outcome.responseId,
      type: "response.done",
    });

    const firstPayloads = events.map(({ payload }) => payload as Record<string, unknown>);
    const firstTalkEvents = firstPayloads
      .map((payload) => payload.talkEvent)
      .filter((event): event is Record<string, unknown> => Boolean(event));
    expect(firstTalkEvents.filter((event) => event.type === terminalType)).toHaveLength(1);
    expect(firstPayloads.filter((payload) => payload.type === "error")).toHaveLength(
      outcome.status === "cancelled" ? 0 : 1,
    );
    expect(firstPayloads.filter((payload) => payload.type === "audioDone")).toHaveLength(1);
    expect(relaySessions.has(session.relaySessionId)).toBe(true);
    expect(close).not.toHaveBeenCalled();

    void sendTalkRealtimeRelayAudio({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      audioBase64: Buffer.from("later").toString("base64"),
      timestamp: 2,
    });
    bridgeRequest.onEvent?.({
      direction: "server",
      type: "response.created",
      responseId: "response-2",
    });
    bridgeRequest.onResponseDone?.({ status: "completed" });
    bridgeRequest.onEvent?.({
      direction: "server",
      responseId: "response-2",
      type: "response.done",
    });

    expect(
      events.filter(
        ({ payload }) =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "audioDone",
      ),
    ).toHaveLength(2);
    expect(relaySessions.has(session.relaySessionId)).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  afterEach(async () => {
    for (const [relaySessionId, connId] of activeRelaySessions) {
      try {
        stopTalkRealtimeRelaySessionRaw({ relaySessionId, connId });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("Unknown realtime relay session")
        ) {
          throw error;
        }
      }
    }
    activeRelaySessions.clear();
    await Promise.all(
      [...drainingRelaySessions].map((session) => session.voiceSessionClose ?? Promise.resolve()),
    );
    vi.useRealTimers();
    embeddedRunTesting.resetActiveEmbeddedRuns();
  });

  function createIdleRelayProvider(): RealtimeVoiceProviderPlugin {
    return {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => makeRelayTransport(),
    };
  }

  it("closes only realtime relays owned by the disconnected connection", async () => {
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    const tempDir = tempDirs.make("openclaw-relay-disconnect-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const bridgeCloses: Array<ReturnType<typeof vi.fn>> = [];
    const bridgeAudioSends: Array<ReturnType<typeof vi.fn>> = [];
    const bridgeRequests: RealtimeVoiceBridgeCreateRequest[] = [];
    const bridgeToolResults: Array<ReturnType<typeof vi.fn>> = [];
    const provider = createIdleRelayProvider();
    provider.createBridge = (request) => {
      const bridgeIndex = bridgeCloses.length;
      const close = vi.fn();
      const sendAudio = vi.fn();
      const submitToolResult = vi.fn();
      bridgeRequests.push(request);
      bridgeCloses.push(close);
      bridgeAudioSends.push(sendAudio);
      bridgeToolResults.push(submitToolResult);
      return makeRelayTransport({
        connect: vi.fn(async () => {
          if (bridgeIndex === 1) {
            throw new Error("late connect failure");
          }
        }),
        sendAudio,
        submitToolResult,
        close,
      });
    };
    try {
      const logGateway = { warn: vi.fn() };
      const broadcastToConnIds = vi.fn();
      const context = {
        broadcastToConnIds,
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => ({}),
        logGateway,
      } as never;
      const createSession = (connId: string) =>
        createTalkRealtimeRelaySession({
          context,
          connId,
          provider,
          providerConfig: {},
          instructions: "brief",
          tools: [],
        });
      const firstOwned = createSession("conn-owner");
      const secondOwned = createSession("conn-owner");
      const unrelated = createSession("conn-other");
      ensureTalkRealtimeRelayVoiceSession({
        relaySessionId: firstOwned.relaySessionId,
        connId: "conn-owner",
        sessionKey: "agent:main:main",
      });
      expect(clientVoiceSessionTesting.readRecord("main", firstOwned.relaySessionId)).toMatchObject(
        {
          status: "open",
        },
      );
      bridgeCloses[0]?.mockImplementationOnce(() => {
        throw new Error("provider close failed");
      });

      expect(() => cleanupTalkConnection("conn-owner", logGateway)).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();

      expect(bridgeCloses[0]).toHaveBeenCalledOnce();
      expect(bridgeCloses[1]).toHaveBeenCalledOnce();
      expect(bridgeCloses[2]).not.toHaveBeenCalled();
      expect(logGateway.warn).toHaveBeenCalledWith(
        "failed to close realtime relay session after connection disconnect: provider close failed",
      );
      await vi.waitFor(() =>
        expect(
          clientVoiceSessionTesting.readRecord("main", firstOwned.relaySessionId)?.status,
        ).toBe("closed"),
      );
      expect(
        broadcastToConnIds.mock.calls.some(
          ([event, payload]) =>
            event === "talk.event" &&
            payload.relaySessionId === firstOwned.relaySessionId &&
            payload.type === "close" &&
            payload.talkEvent?.type === "session.closed" &&
            payload.talkEvent.final === true,
        ),
      ).toBe(true);
      expect(
        broadcastToConnIds.mock.calls.some(
          ([event, payload]) =>
            event === "talk.event" &&
            payload.relaySessionId === secondOwned.relaySessionId &&
            payload.type === "error",
        ),
      ).toBe(false);
      const eventCountAfterClose = broadcastToConnIds.mock.calls.length;
      const lateRequest = bridgeRequests[0];
      if (!lateRequest?.runAgentConsult) {
        throw new Error("expected relay provider request to include the agent consult runner");
      }
      lateRequest.onReady?.();
      lateRequest.onError?.(new Error("late provider error"));
      lateRequest.onEvent?.({ direction: "server", type: "response.done" });
      lateRequest.onAudio(Buffer.from("late audio"));
      lateRequest.onClearAudio("barge-in");
      lateRequest.onMark?.("late-mark");
      lateRequest.onTranscript?.("user", "late transcript", true);
      lateRequest.onToolCall?.({
        itemId: "late-item",
        callId: "late-call",
        name: "openclaw_agent_consult",
        args: { question: "late consult" },
      });
      lateRequest.onClose?.("error");
      await expect(lateRequest.runAgentConsult({ prompt: "late direct consult" })).rejects.toThrow(
        "Realtime gateway-relay session is closed",
      );
      await Promise.resolve();
      expect(broadcastToConnIds).toHaveBeenCalledTimes(eventCountAfterClose);
      expect(bridgeToolResults[0]).not.toHaveBeenCalled();
      expect(
        () =>
          void sendTalkRealtimeRelayAudio({
            relaySessionId: firstOwned.relaySessionId,
            connId: "conn-owner",
            audioBase64: "AQI=",
          }),
      ).toThrow("Unknown realtime relay session");
      expect(
        () =>
          void sendTalkRealtimeRelayAudio({
            relaySessionId: secondOwned.relaySessionId,
            connId: "conn-owner",
            audioBase64: "AQI=",
          }),
      ).toThrow("Unknown realtime relay session");

      void sendTalkRealtimeRelayAudio({
        relaySessionId: unrelated.relaySessionId,
        connId: "conn-other",
        audioBase64: "AQI=",
      });
      expect(bridgeAudioSends[2]).toHaveBeenCalledOnce();
      stopTalkRealtimeRelaySession({
        relaySessionId: unrelated.relaySessionId,
        connId: "conn-other",
      });
      cleanupTalkConnection("conn-other", logGateway);
      expect(bridgeCloses[2]).toHaveBeenCalledOnce();
    } finally {
      clientVoiceSessionTesting.reset();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      envSnapshot.restore();
    }
  });

  it("injects the host agent runner only into gateway-relay bridge creation", () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider = createIdleRelayProvider();
    provider.createBridge = (request) => {
      bridgeRequest = request;
      return createIdleRelayProvider().createBridge(request);
    };
    const session = createTalkRealtimeRelaySession({
      context: {
        broadcastToConnIds: vi.fn(),
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => ({}),
        logGateway: { warn: vi.fn() },
      } as never,
      connId: "conn-runner",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
      sessionKey: "agent:main:main",
    });

    expect(bridgeRequest?.runAgentConsult).toEqual(expect.any(Function));
    expect(bridgeRequest?.agentId).toBe("main");
    stopTalkRealtimeRelaySession({
      relaySessionId: session.relaySessionId,
      connId: "conn-runner",
    });
  });

  it.each([
    {
      name: "error before close",
      terminate: (request: RealtimeVoiceBridgeCreateRequest) => {
        request.onError?.(new Error("provider rejected session"));
        request.onClose?.("error");
      },
      expectedError: "provider rejected session",
    },
    {
      name: "close before error",
      terminate: (request: RealtimeVoiceBridgeCreateRequest) => {
        request.onClose?.("completed");
        request.onError?.(new Error("late provider error"));
      },
      expectedError: "Realtime provider closed during session creation: completed",
    },
  ])(
    "rejects a synchronous provider $name during bridge creation",
    ({ terminate, expectedError }) => {
      const connect = vi.fn(async () => undefined);
      const sendAudio = vi.fn();
      const close = vi.fn();
      const bridge = makeRelayTransport({
        connect,
        sendAudio,
        close,
      });
      const provider = createIdleRelayProvider();
      provider.createBridge = (request) => {
        terminate(request);
        return bridge;
      };
      const broadcastToConnIds = vi.fn();

      expect(() =>
        createTalkRealtimeRelaySession({
          context: {
            broadcastToConnIds,
            chatAbortControllers: new Map(),
            getRuntimeConfig: () => ({}),
            logGateway: { warn: vi.fn() },
          } as never,
          connId: "conn-early-terminal",
          provider,
          providerConfig: {},
          instructions: "brief",
          tools: [],
        }),
      ).toThrow(expectedError);

      expect(connect).not.toHaveBeenCalled();
      expect(sendAudio).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    },
  );

  it("appends finalized relay transcripts to the canonical agent session", async () => {
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    const tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-voice-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    try {
      await replaceSessionEntry(
        { agentId: "main", sessionKey: "agent:main:main" },
        { sessionId: "relay-voice-session", updatedAt: Date.now() },
      );
      const provider = createIdleRelayProvider();
      provider.createBridge = (request) => {
        bridgeRequest = request;
        return createIdleRelayProvider().createBridge?.(request) as RealtimeVoiceBridge;
      };
      const session = createTalkRealtimeRelaySession({
        context: {
          broadcastToConnIds: vi.fn(),
          chatAbortControllers: new Map(),
          getRuntimeConfig: () => ({}),
          logGateway: { warn: vi.fn() },
        } as never,
        connId: "conn-voice",
        cfg: {},
        provider,
        providerConfig: {},
        instructions: "brief",
        tools: [],
        sessionKey: "agent:main:main",
      });
      bridgeRequest?.onTranscript?.("user", "relay hello", true);
      bridgeRequest?.onTranscript?.("assistant", "relay response", true);
      await flushTalkRealtimeRelayVoiceWrites({
        relaySessionId: session.relaySessionId,
        connId: "conn-voice",
      });

      const events = readSessionTranscriptMessageEvents({
        agentId: "main",
        sessionId: "relay-voice-session",
      });
      expect(events).toHaveLength(2);
      expect(events[0]?.event).toMatchObject({
        id: `voice:${session.relaySessionId}:1`,
        message: { role: "user", content: [{ type: "text", text: "relay hello" }] },
      });
      expect(events[1]?.event).toMatchObject({
        id: `voice:${session.relaySessionId}:2`,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "relay response" }],
          api: "realtime",
          provider: "relay-test",
          model: "realtime-voice",
        },
      });
      stopTalkRealtimeRelaySession({
        relaySessionId: session.relaySessionId,
        connId: "conn-voice",
      });
      await vi.waitFor(() =>
        expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)?.status).toBe(
          "closed",
        ),
      );
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      envSnapshot.restore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("emits one terminal error and close when transcript persistence overflows", async () => {
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    const tempDir = tempDirs.make("openclaw-relay-voice-overflow-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridgeClose = vi.fn();
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    let releaseQueue!: () => void;
    const queueBlocked = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    try {
      await replaceSessionEntry(
        { agentId: "main", sessionKey: "agent:main:main" },
        { sessionId: "relay-voice-overflow-session", updatedAt: Date.now() },
      );
      const provider = createIdleRelayProvider();
      provider.createBridge = (request) => {
        bridgeRequest = request;
        return makeRelayTransport({
          close: bridgeClose,
        });
      };
      const session = createTalkRealtimeRelaySession({
        context: {
          broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
            events.push({ event, payload, connIds: [...connIds] });
          },
          chatAbortControllers: new Map(),
          getRuntimeConfig: () => ({}),
          logGateway: { warn: vi.fn() },
        } as never,
        connId: "conn-voice-overflow",
        provider,
        providerConfig: {},
        instructions: "brief",
        tools: [],
        sessionKey: "agent:main:main",
      });
      const relay = relaySessions.get(session.relaySessionId);
      if (!relay) {
        throw new Error("expected active relay");
      }
      relay.voiceTranscriptQueue.enqueue(async () => await queueBlocked);

      for (let index = 0; index < 10_000; index += 1) {
        bridgeRequest?.onTranscript?.("user", `message ${index}`, true);
      }

      const errorPayloads = events
        .map((entry) => entry.payload)
        .filter(
          (payload): payload is Record<string, unknown> =>
            typeof payload === "object" &&
            payload !== null &&
            (payload as Record<string, unknown>).type === "error",
        );
      const closePayloads = events
        .map((entry) => entry.payload)
        .filter(
          (payload): payload is Record<string, unknown> =>
            typeof payload === "object" &&
            payload !== null &&
            (payload as Record<string, unknown>).type === "close",
        );
      expect(errorPayloads).toHaveLength(1);
      expect(errorPayloads[0]).toMatchObject({
        relaySessionId: session.relaySessionId,
        type: "error",
        message: expect.stringContaining("persistence could not keep up"),
      });
      expect(errorPayloads[0]).not.toHaveProperty("code");
      expect(closePayloads).toEqual([
        expect.objectContaining({
          relaySessionId: session.relaySessionId,
          type: "close",
          reason: "error",
        }),
      ]);
      expect(bridgeClose).toHaveBeenCalledOnce();
      expect(relaySessions.has(session.relaySessionId)).toBe(false);
      expect(drainingRelaySessions.has(relay)).toBe(true);

      createTalkRealtimeRelaySession({
        context: {
          broadcastToConnIds: vi.fn(),
          getRuntimeConfig: () => ({}),
          logGateway: { warn: vi.fn() },
        } as never,
        connId: "conn-voice-overflow",
        provider,
        providerConfig: {},
        instructions: "brief",
        tools: [],
      });
      expect(() =>
        createTalkRealtimeRelaySession({
          context: {
            broadcastToConnIds: vi.fn(),
            getRuntimeConfig: () => ({}),
            logGateway: { warn: vi.fn() },
          } as never,
          connId: "conn-voice-overflow",
          provider,
          providerConfig: {},
          instructions: "brief",
          tools: [],
        }),
      ).toThrow("Too many active realtime relay sessions for this connection");

      releaseQueue();
      await relay.voiceSessionClose;
      expect(drainingRelaySessions.has(relay)).toBe(false);
      expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)?.status).toBe(
        "closed",
      );
    } finally {
      releaseQueue();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      envSnapshot.restore();
    }
  });

  it("creates the relay voice record before binding a transcript-free consult", async () => {
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    const tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-voice-consult-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    try {
      const session = createTalkRealtimeRelaySession({
        context: {
          broadcastToConnIds: vi.fn(),
          chatAbortControllers: new Map(),
          getRuntimeConfig: () => ({}),
          logGateway: { warn: vi.fn() },
        } as never,
        connId: "conn-consult",
        cfg: {},
        provider: createIdleRelayProvider(),
        providerConfig: {},
        instructions: "brief",
        tools: [],
        sessionKey: "agent:main:main",
      });
      expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)).toBeUndefined();

      registerTalkRealtimeRelayAgentRun({
        relaySessionId: session.relaySessionId,
        connId: "conn-consult",
        sessionKey: "agent:main:main",
        runId: "run-before-transcript",
      });
      registerTalkRealtimeRelayAgentRun({
        relaySessionId: session.relaySessionId,
        connId: "conn-consult",
        sessionKey: "agent:main:other",
        runId: "run-other-session",
      });

      expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)).toMatchObject({
        status: "open",
        consultRunIds: ["run-before-transcript", "run-other-session"],
      });
      stopTalkRealtimeRelaySession({
        relaySessionId: session.relaySessionId,
        connId: "conn-consult",
      });
      await vi.waitFor(() =>
        expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)?.status).toBe(
          "closed",
        ),
      );
    } finally {
      clientVoiceSessionTesting.reset();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      envSnapshot.restore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("pins an unscoped relay owner before the configured default changes", async () => {
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    const tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-owner-pin-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    let runtimeConfig: OpenClawConfig = {
      agents: { entries: { main: { default: true }, ops: {} } },
    };
    try {
      const session = createTalkRealtimeRelaySessionRaw({
        context: {
          broadcastToConnIds: vi.fn(),
          chatAbortControllers: new Map(),
          getRuntimeConfig: () => runtimeConfig,
          logGateway: { warn: vi.fn() },
        } as never,
        connId: "conn-owner-pin",
        provider: createIdleRelayProvider(),
        providerConfig: {},
        instructions: "brief",
        tools: [],
        sessionKey: "main",
      });
      activeRelaySessions.set(session.relaySessionId, "conn-owner-pin");
      runtimeConfig = {
        agents: { entries: { main: {}, ops: { default: true } } },
      };

      ensureTalkRealtimeRelayVoiceSession({
        relaySessionId: session.relaySessionId,
        connId: "conn-owner-pin",
        sessionKey: "main",
      });
      stopTalkRealtimeRelaySession({
        relaySessionId: session.relaySessionId,
        connId: "conn-owner-pin",
      });
      await vi.waitFor(() =>
        expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)?.status).toBe(
          "closed",
        ),
      );
      expect(clientVoiceSessionTesting.readRecord("ops", session.relaySessionId)).toBeUndefined();
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      envSnapshot.restore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("pins a scoped relay owner from the trimmed session key", async () => {
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    const tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-trimmed-owner-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    try {
      const session = createTalkRealtimeRelaySessionRaw({
        context: {
          broadcastToConnIds: vi.fn(),
          chatAbortControllers: new Map(),
          getRuntimeConfig: () => ({
            agents: { entries: { main: {}, ops: { default: true } } },
          }),
          logGateway: { warn: vi.fn() },
        } as never,
        connId: "conn-trimmed-owner",
        provider: createIdleRelayProvider(),
        providerConfig: {},
        instructions: "brief",
        tools: [],
        sessionKey: " agent:main:main ",
      });
      activeRelaySessions.set(session.relaySessionId, "conn-trimmed-owner");

      ensureTalkRealtimeRelayVoiceSession({
        relaySessionId: session.relaySessionId,
        connId: "conn-trimmed-owner",
        sessionKey: "agent:main:main",
      });

      expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)).toMatchObject({
        status: "open",
      });
      expect(clientVoiceSessionTesting.readRecord("ops", session.relaySessionId)).toBeUndefined();
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      envSnapshot.restore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("logs relay transcript append failures", async () => {
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    const tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-voice-failure-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const warn = vi.fn();
    try {
      vi.useFakeTimers();
      const provider = createIdleRelayProvider();
      provider.createBridge = (request) => {
        bridgeRequest = request;
        return createIdleRelayProvider().createBridge?.(request) as RealtimeVoiceBridge;
      };
      const session = createTalkRealtimeRelaySession({
        context: {
          broadcastToConnIds: vi.fn(),
          getRuntimeConfig: () => ({}),
          logGateway: { warn },
        } as never,
        connId: "conn-voice-failure",
        cfg: {},
        provider,
        providerConfig: {},
        instructions: "brief",
        tools: [],
        sessionKey: "agent:main:missing",
      });
      bridgeRequest?.onTranscript?.("user", "cannot persist", true);
      await vi.advanceTimersByTimeAsync(0);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await flushTalkRealtimeRelayVoiceWrites({
        relaySessionId: session.relaySessionId,
        connId: "conn-voice-failure",
      });

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("realtime relay transcript append failed"),
      );
      stopTalkRealtimeRelaySession({
        relaySessionId: session.relaySessionId,
        connId: "conn-voice-failure",
      });
      await vi.waitFor(() =>
        expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)?.status).toBe(
          "closed",
        ),
      );
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      envSnapshot.restore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function createSuppressionUnsupportedForcedConsultFixture(
    nativeCallIds: string[],
    options: {
      firstSubmission?: Promise<void>;
      supportsToolResultContinuation?: boolean;
    } = {},
  ) {
    vi.useFakeTimers();
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const submitToolResult = vi.fn<RealtimeVoiceBridge["submitToolResult"]>();
    if (options.firstSubmission) {
      submitToolResult.mockReturnValueOnce(options.firstSubmission);
    }
    const sendUserMessage = vi.fn();
    const bridge = makeRelayTransport({
      supportsToolResultContinuation: options.supportsToolResultContinuation ?? false,
      supportsToolResultSuppression: false,
      sendUserMessage,
      submitToolResult,
    });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (request) => {
        bridgeRequest = request;
        return bridge;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const session = createTalkRealtimeRelaySession({
      context: {
        broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
          events.push({ event, payload, connIds: [...connIds] });
        },
      } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
      forceAgentConsultOnFinalTranscript: true,
    });
    await Promise.resolve();
    bridgeRequest?.onTranscript?.("user", "Can you check this?", true);
    await vi.advanceTimersByTimeAsync(250);
    const forcedToolCall = findEventPayload(
      events,
      (payload) => payload.type === "toolCall" && payload.forced === true,
    );
    for (const callId of nativeCallIds) {
      bridgeRequest?.onToolCall?.({
        itemId: `item-${callId}`,
        callId,
        name: "openclaw_agent_consult",
        args: { question: "Can you check this?" },
      });
    }
    return {
      bridgeRequest,
      callId: String(forcedToolCall.callId),
      events,
      sendUserMessage,
      session,
      submitToolResult,
    };
  }

  it("rejects session creation when relay expiry would exceed Date range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));

    expect(() =>
      createTalkRealtimeRelaySession({
        context: {} as never,
        connId: "conn-1",
        provider: createIdleRelayProvider(),
        providerConfig: {},
        instructions: "brief",
        tools: [],
      }),
    ).toThrow("Realtime relay session expiry is outside the supported Date range");
  });

  function createAbortableRelayRunFixture(
    provider = createIdleRelayProvider(),
    options: { register?: boolean } = {},
  ) {
    const abortController = new AbortController();
    const broadcastToConnIds = vi.fn();
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const removeChatRun = vi.fn(() => ({ sessionKey: "main", clientRunId: "run-1" }));
    const chatRunState = createChatRunState();
    Object.assign(chatRunState.getOrCreate("run-1"), {
      buffer: "partial answer",
      agentText: {
        assistant: {
          lastSentAt: Date.now(),
          bufferedEvent: {
            payload: {
              runId: "run-1",
              seq: 1,
              stream: "assistant",
              ts: Date.now(),
              data: { text: "pending", delta: "pending" },
            },
          },
        },
      },
    });
    const context = {
      broadcastToConnIds,
      broadcast,
      nodeSendToSession,
      chatAbortControllers: new Map([
        [
          "run-1",
          {
            controller: abortController,
            sessionId: "run-1",
            sessionKey: "main",
            startedAtMs: 1,
            expiresAtMs: Date.now() + 60_000,
          },
        ],
      ]),
      chatRunState,
      removeChatRun,
      agentRunSeq: new Map(),
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    ensureActiveRelayTurnId(session.relaySessionId);

    if (options.register !== false) {
      registerTalkRealtimeRelayAgentRun({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        sessionKey: "main",
        runId: "run-1",
        callId: "call-1",
      });
    }
    return {
      abortController,
      broadcast,
      nodeSendToSession,
      removeChatRun,
      chatRunState,
      broadcastToConnIds,
      session,
    };
  }

  it("aborts the exact relay consult when the provider cancels its tool call", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const submitToolResult = vi.fn();
    const provider = createIdleRelayProvider();
    provider.createBridge = (request) => {
      bridgeRequest = request;
      return makeRelayTransport({
        submitToolResult,
      });
    };
    const fixture = createAbortableRelayRunFixture(provider);
    await Promise.resolve();
    bridgeRequest?.onToolCall?.({
      itemId: "call-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "status?" },
    });

    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "tool.call.cancelled",
      itemId: "call-1",
    });

    expect(fixture.abortController.signal.aborted).toBe(true);
    expect(
      fixture.broadcastToConnIds.mock.calls
        .map(([, payload]) => payload)
        .filter(
          (payload) =>
            typeof payload === "object" &&
            payload !== null &&
            (payload as Record<string, unknown>).type === "toolCallCancelled",
        ),
    ).toEqual([
      expect.objectContaining({
        relaySessionId: fixture.session.relaySessionId,
        type: "toolCallCancelled",
        callId: "call-1",
      }),
    ]);
    await submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { result: "late" },
    });
    expect(submitToolResult).not.toHaveBeenCalled();

    const eventCount = fixture.broadcastToConnIds.mock.calls.length;
    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "tool.call.cancelled",
      itemId: "call-1",
    });
    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "tool.call.cancelled",
      itemId: "unknown",
    });
    expect(fixture.broadcastToConnIds).toHaveBeenCalledTimes(eventCount);
  });

  it("aborts a consult that registers after provider cancellation", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider = createIdleRelayProvider();
    provider.createBridge = (request) => {
      bridgeRequest = request;
      return createIdleRelayProvider().createBridge?.(request) as RealtimeVoiceBridge;
    };
    const fixture = createAbortableRelayRunFixture(provider, { register: false });
    await Promise.resolve();
    bridgeRequest?.onToolCall?.({
      itemId: "call-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "status?" },
    });
    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "tool.call.cancelled",
      itemId: "call-1",
    });

    expect(() =>
      registerTalkRealtimeRelayAgentRun({
        relaySessionId: fixture.session.relaySessionId,
        connId: "conn-1",
        sessionKey: "main",
        runId: "run-1",
        callId: "call-1",
      }),
    ).toThrow("Realtime provider cancelled the tool call before run registration");
    expect(fixture.abortController.signal.aborted).toBe(true);
    const relay = relaySessions.get(fixture.session.relaySessionId);
    expect(relay?.activeAgentRuns.size).toBe(0);
    expect(relay?.activeAgentToolCalls.size).toBe(0);
    expect(relay?.providerToolCallIds.size).toBe(0);
    expect(relay?.relayToolCallIdsByProviderId.size).toBe(0);
  });

  it("cancels the forced consult owner when a matching native call is cancelled", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const submitToolResult = vi.fn();
    const provider = createIdleRelayProvider();
    provider.createBridge = (request) => {
      bridgeRequest = request;
      return makeRelayTransport({
        submitToolResult,
      });
    };
    const fixture = createAbortableRelayRunFixture(provider, { register: false });
    const relay = relaySessions.get(fixture.session.relaySessionId);
    const forcedConsult = relay?.harness.forcedConsults.prepare("status?", { id: "forced-call" });
    if (!relay || !forcedConsult) {
      throw new Error("missing forced consult fixture");
    }
    relay.harness.forcedConsults.markStarted(forcedConsult);
    await Promise.resolve();
    bridgeRequest?.onToolCall?.({
      itemId: "native-call",
      callId: "native-call",
      name: "openclaw_agent_consult",
      args: { question: "status?" },
    });
    registerTalkRealtimeRelayAgentRun({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      sessionKey: "main",
      runId: "run-1",
      callId: forcedConsult.id,
    });

    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "tool.call.cancelled",
      itemId: "native-call",
    });

    expect(fixture.abortController.signal.aborted).toBe(true);
    expect(relay.harness.forcedConsults.isCancelled(forcedConsult)).toBe(true);
    expect(
      fixture.broadcastToConnIds.mock.calls
        .map(([, payload]) => payload)
        .filter(
          (payload) =>
            typeof payload === "object" &&
            payload !== null &&
            (payload as Record<string, unknown>).type === "toolCallCancelled",
        ),
    ).toEqual([
      expect.objectContaining({
        relaySessionId: fixture.session.relaySessionId,
        type: "toolCallCancelled",
        callId: forcedConsult.id,
      }),
    ]);
    expect(
      submitTalkRealtimeRelayToolResult({
        relaySessionId: fixture.session.relaySessionId,
        connId: "conn-1",
        callId: forcedConsult.id,
        result: { result: "late" },
      }),
    ).toBeUndefined();
    expect(submitToolResult).not.toHaveBeenCalled();
  });

  it("ignores provider replay and cancellation after accepted completion", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const submitToolResult = vi.fn();
    const provider = createIdleRelayProvider();
    provider.createBridge = (request) => {
      bridgeRequest = request;
      return makeRelayTransport({
        submitToolResult,
      });
    };
    const fixture = createAbortableRelayRunFixture(provider);
    await Promise.resolve();
    bridgeRequest?.onToolCall?.({
      itemId: "call-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "status?" },
    });
    await submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { result: "done" },
    });
    const toolEvents = () =>
      fixture.broadcastToConnIds.mock.calls
        .map(([, payload]) => payload)
        .filter(
          (payload) =>
            typeof payload === "object" &&
            payload !== null &&
            ["toolCall", "toolCallCancelled"].includes(
              String((payload as Record<string, unknown>).type),
            ),
        );
    expect(toolEvents()).toHaveLength(1);

    bridgeRequest?.onToolCall?.({
      itemId: "call-1-replay",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "status?" },
    });
    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "tool.call.cancelled",
      itemId: "call-1",
    });

    expect(toolEvents()).toHaveLength(1);
    expect(submitToolResult).toHaveBeenCalledTimes(1);
  });

  function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
    if (!record || typeof record !== "object") {
      throw new Error("Expected record");
    }
    const actual = record as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      expect(actual[key]).toEqual(value);
    }
    return actual;
  }

  function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
    const call = mock.mock.calls[callIndex];
    if (!call) {
      throw new Error(`Expected mock call ${callIndex}`);
    }
    return call[argIndex];
  }

  function findEventPayload(
    events: Array<{ payload: unknown }>,
    predicate: (payload: Record<string, unknown>) => boolean,
  ) {
    const event = events.find((entry) => {
      const payload = entry.payload;
      return (
        typeof payload === "object" &&
        payload !== null &&
        predicate(payload as Record<string, unknown>)
      );
    });
    if (!event) {
      throw new Error("Expected matching relay event");
    }
    return event.payload as Record<string, unknown>;
  }

  function expectChatAbortPayload(mock: ReturnType<typeof vi.fn>, stopReason: string) {
    expect(mockCallArg(mock)).toBe("chat");
    expectRecordFields(mockCallArg(mock, 0, 1), {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      stopReason,
    });
  }

  function expectNodeAbortPayload(mock: ReturnType<typeof vi.fn>) {
    expect(mockCallArg(mock)).toBe("main");
    expect(mockCallArg(mock, 0, 1)).toBe("chat");
    expectRecordFields(mockCallArg(mock, 0, 2), { runId: "run-1", state: "aborted" });
  }

  it("resets provider continuity without cancelling the replacement provider", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const pendingWorking = createDeferred();
    const handleBargeIn = vi.fn();
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockReturnValueOnce(pendingWorking.promise);
    const bridge = makeRelayTransport({
      supportsToolResultContinuation: true,
      sendUserMessage: vi.fn(),
      handleBargeIn,
      submitToolResult,
    });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (request) => {
        bridgeRequest = request;
        return bridge;
      },
    };
    const fixture = createAbortableRelayRunFixture(provider);
    const relay = relaySessions.get(fixture.session.relaySessionId);
    if (!relay || !bridgeRequest) {
      throw new Error("expected active relay continuity fixture");
    }
    const request = bridgeRequest;
    request.onReady?.();
    relay.harness.talk.startTurn({ turnId: "turn-old" });
    request.onEvent?.({
      direction: "server",
      type: "response.created",
      responseId: "old-response",
    });
    request.onEvent?.({
      direction: "server",
      type: "response.audio.delta",
      itemId: "old-item",
      responseId: "old-response",
    });
    request.onAudio(Buffer.from("old audio"));
    request.onToolCall?.({
      itemId: "old-item",
      callId: "call-1",
      name: "custom_tool",
      args: {},
    });
    const working = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { status: "working" },
      options: { willContinue: true },
    });

    request.onEvent?.({
      direction: "client",
      type: "session.continuity.reset",
    });
    request.onEvent?.({
      direction: "client",
      type: "session.continuity.reset",
    });

    expect(fixture.abortController.signal.aborted).toBe(true);
    expect(handleBargeIn).not.toHaveBeenCalled();
    expect(bridge.close).not.toHaveBeenCalled();
    expect(submitToolResult).toHaveBeenCalledTimes(1);
    expect(relay.pendingWorkingToolResults.size).toBe(0);
    expect(relay.activeAgentRuns.size).toBe(0);
    expect(relay.activeAgentToolCalls.size).toBe(0);
    const payloads = fixture.broadcastToConnIds.mock.calls.map(([, payload]) => payload);
    const clears = payloads.filter(
      (payload): payload is Record<string, unknown> =>
        typeof payload === "object" &&
        payload !== null &&
        (payload as Record<string, unknown>).type === "clear",
    );
    expect(clears).toHaveLength(1);
    expectRecordFields(clears[0]?.talkEvent, {
      type: "turn.cancelled",
      payload: { reason: "session.continuity.reset" },
      final: true,
    });

    pendingWorking.resolve();
    await working;
    expect(submitToolResult).toHaveBeenCalledTimes(1);

    request.onEvent?.({ direction: "server", type: "session.created" });
    relay.harness.talk.startTurn({ turnId: "turn-new" });
    request.onEvent?.({
      direction: "server",
      type: "response.created",
      responseId: "fresh-response",
    });
    request.onAudio(Buffer.from("fresh audio"));
    const freshAudio = fixture.broadcastToConnIds.mock.calls
      .map(([, payload]) => payload)
      .findLast(
        (payload): payload is Record<string, unknown> =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "audio",
      );
    expectRecordFields(freshAudio, {
      type: "audio",
      audioBase64: Buffer.from("fresh audio").toString("base64"),
    });
    expect(freshAudio).not.toHaveProperty("itemId");
    expect(freshAudio).toHaveProperty("responseId", "fresh-response");

    request.onToolCall?.({
      itemId: "fresh-item",
      callId: "call-1",
      name: "custom_tool",
      args: {},
    });
    const freshToolCall = fixture.broadcastToConnIds.mock.calls
      .map(([, payload]) => payload)
      .findLast(
        (payload): payload is Record<string, unknown> =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "toolCall",
      );
    const freshCallId = freshToolCall?.callId;
    expect(typeof freshCallId).toBe("string");
    expect(freshCallId).not.toBe("call-1");
    await submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { stale: true },
    });
    expect(submitToolResult).toHaveBeenCalledTimes(1);
    await submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: String(freshCallId),
      result: { ok: true },
    });
    expect(submitToolResult).toHaveBeenLastCalledWith("call-1", { ok: true }, undefined);

    request.onEvent?.({
      direction: "client",
      type: "session.continuity.reset",
    });
    request.onEvent?.({
      direction: "client",
      type: "session.continuity.reset",
    });
    expect(
      fixture.broadcastToConnIds.mock.calls
        .map(([, payload]) => payload)
        .filter(
          (payload) =>
            typeof payload === "object" &&
            payload !== null &&
            (payload as Record<string, unknown>).type === "clear",
        ),
    ).toHaveLength(2);
  });

  it("bridges browser audio, transcripts, and tool results through a backend provider", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridge = makeRelayTransport({
      supportsToolResultContinuation: true,
      connect: vi.fn(async () => {
        bridgeRequest?.onReady?.();
        bridgeRequest?.onTranscript?.("user", "hel", false);
        bridgeRequest?.onEvent?.({
          direction: "server",
          type: "response.created",
          responseId: "response-1",
        });
        bridgeRequest?.onAudio(Buffer.from("audio-out"));
        bridgeRequest?.onMark?.("mark-1");
        bridgeRequest?.onTranscript?.("user", "hello", true);
        bridgeRequest?.onTranscript?.("assistant", "hi there", true);
        bridgeRequest?.onToolCall?.({
          itemId: "item-1",
          callId: "call-1",
          name: "openclaw_agent_consult",
          args: { question: "hello" },
        });
      }),
      sendUserMessage: vi.fn(),
      triggerGreeting: vi.fn(),
    });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return bridge;
      },
    };
    const events: Array<{
      event: string;
      payload: unknown;
      connIds: string[];
      opts?: { dropIfSlow?: boolean };
    }> = [];
    const context = {
      broadcastToConnIds: (
        event: string,
        payload: unknown,
        connIds: ReadonlySet<string>,
        opts?: { dropIfSlow?: boolean },
      ) => {
        events.push({ event, payload, connIds: [...connIds], opts });
      },
    } as never;
    const expectDelivery = (payload: Record<string, unknown>, dropIfSlow: boolean) => {
      expectRecordFields(events.find((entry) => entry.payload === payload)?.opts, { dropIfSlow });
    };

    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: { model: "provider-model" },
      instructions: "be brief",
      tools: [],
      model: "browser-model",
      voice: "voice-a",
      language: "de",
    });
    await Promise.resolve();

    const sessionFields = expectRecordFields(session, {
      provider: "relay-test",
      transport: "gateway-relay",
      model: "browser-model",
      voice: "voice-a",
    });
    expectRecordFields(sessionFields.audio, {
      inputEncoding: "pcm16",
      inputSampleRateHz: 24000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24000,
    });
    expectRecordFields(bridgeRequest, {
      providerConfig: { model: "provider-model" },
      audioFormat: { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
      instructions: "be brief",
      language: "de",
      autoRespondToAudio: true,
      interruptResponseOnInputAudio: true,
    });

    const readyPayload = findEventPayload(events, (payload) => payload.type === "ready");
    expectRecordFields(readyPayload, {
      relaySessionId: session.relaySessionId,
      type: "ready",
    });
    expectRecordFields(readyPayload.talkEvent, {
      sessionId: session.relaySessionId,
      type: "session.ready",
      seq: 1,
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "relay-test",
    });
    const readyEvent = events.find((entry) => entry.payload === readyPayload);
    expectRecordFields(readyEvent, { event: "talk.event", connIds: ["conn-1"] });
    expectDelivery(readyPayload, false);

    const audioPayload = findEventPayload(events, (payload) => payload.type === "audio");
    expectRecordFields(audioPayload, {
      relaySessionId: session.relaySessionId,
      type: "audio",
      audioBase64: Buffer.from("audio-out").toString("base64"),
    });
    expectRecordFields(audioPayload.talkEvent, { type: "output.audio.delta" });
    expectDelivery(audioPayload, true);

    const markPayload = findEventPayload(events, (payload) => payload.type === "mark");
    expectRecordFields(markPayload, {
      relaySessionId: session.relaySessionId,
      type: "mark",
      markName: "mark-1",
    });
    expectDelivery(markPayload, false);

    const partialTranscript = findEventPayload(
      events,
      (payload) =>
        payload.type === "transcript" && payload.role === "user" && payload.final === false,
    );
    expectDelivery(partialTranscript, true);

    const userTranscript = findEventPayload(
      events,
      (payload) =>
        payload.type === "transcript" && payload.role === "user" && payload.final === true,
    );
    expectRecordFields(userTranscript, {
      relaySessionId: session.relaySessionId,
      type: "transcript",
      role: "user",
      text: "hello",
      final: true,
    });
    expectRecordFields(userTranscript.talkEvent, { type: "transcript.done", final: true });
    expectDelivery(userTranscript, false);

    const assistantTranscript = findEventPayload(
      events,
      (payload) => payload.type === "transcript" && payload.role === "assistant",
    );
    expectRecordFields(assistantTranscript, {
      relaySessionId: session.relaySessionId,
      type: "transcript",
      role: "assistant",
      text: "hi there",
      final: true,
    });
    expectRecordFields(assistantTranscript.talkEvent, {
      type: "output.text.done",
      final: true,
      payload: { text: "hi there" },
    });
    expectDelivery(assistantTranscript, false);

    const toolCallPayload = findEventPayload(events, (payload) => payload.type === "toolCall");
    expectRecordFields(toolCallPayload, {
      relaySessionId: session.relaySessionId,
      type: "toolCall",
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "hello" },
    });
    expectRecordFields(toolCallPayload.talkEvent, {
      type: "tool.call",
      itemId: "item-1",
      callId: "call-1",
    });
    expectDelivery(toolCallPayload, false);

    void sendTalkRealtimeRelayAudio({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      audioBase64: Buffer.from("audio-in").toString("base64"),
      timestamp: 123,
    });
    void submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { status: "working" },
      options: { willContinue: true },
    });
    void submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { ok: true },
    });
    void submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-2",
      result: { status: "already_delivered" },
      options: { suppressResponse: true },
    });
    acknowledgeTalkRealtimeRelayMark({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      markName: "mark-1",
    });
    void cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
      turnId: ensureActiveRelayTurnId(session.relaySessionId),
    });
    stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId: "conn-1" });

    expect(bridge.sendAudio).toHaveBeenCalledWith(Buffer.from("audio-in"));
    expect(bridge.sendUserMessage).not.toHaveBeenCalledWith("hello");
    expect(bridge.setMediaTimestamp).toHaveBeenCalledWith(123);
    expect(bridge.submitToolResult).toHaveBeenNthCalledWith(
      1,
      "call-1",
      {
        status: "working",
        tool: "openclaw_agent_consult",
        message:
          "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
      },
      { willContinue: true },
    );
    expect(bridge.submitToolResult).toHaveBeenNthCalledWith(
      2,
      "call-1",
      { status: "working" },
      { willContinue: true },
    );
    expect(bridge.submitToolResult).toHaveBeenNthCalledWith(3, "call-1", { ok: true }, undefined);
    expect(bridge.submitToolResult).toHaveBeenNthCalledWith(
      4,
      "call-2",
      { status: "already_delivered" },
      { suppressResponse: true },
    );
    expect(bridge.handleBargeIn).toHaveBeenCalledWith({ audioPlaybackActive: true });
    expect(bridge.acknowledgeMark).toHaveBeenCalledWith("mark-1");
    expect(bridge.close).toHaveBeenCalled();
    const inputAudioPayload = findEventPayload(
      events,
      (payload) =>
        payload.type === "inputAudio" && payload.byteLength === Buffer.from("audio-in").byteLength,
    );
    expectRecordFields(inputAudioPayload, {
      relaySessionId: session.relaySessionId,
      type: "inputAudio",
      byteLength: Buffer.from("audio-in").byteLength,
    });
    expectRecordFields(inputAudioPayload.talkEvent, { type: "input.audio.delta" });
    expectDelivery(inputAudioPayload, true);

    const clearPayload = findEventPayload(events, (payload) => payload.type === "clear");
    expectRecordFields(clearPayload, {
      relaySessionId: session.relaySessionId,
      type: "clear",
    });
    expectRecordFields(clearPayload.talkEvent, {
      type: "turn.cancelled",
      payload: { reason: "barge-in" },
      final: true,
    });
    expectDelivery(clearPayload, false);

    const toolResultPayloads = events
      .map((entry) => entry.payload)
      .filter(
        (payload): payload is Record<string, unknown> =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "toolResult" &&
          (payload as Record<string, unknown>).callId === "call-1",
      );
    expect(toolResultPayloads).toHaveLength(3);
    expectRecordFields(toolResultPayloads[0], {
      relaySessionId: session.relaySessionId,
      type: "toolResult",
      callId: "call-1",
    });
    expectRecordFields(toolResultPayloads[0]?.talkEvent, {
      type: "tool.progress",
      callId: "call-1",
      payload: { name: "openclaw_agent_consult", status: "working" },
    });
    expectRecordFields(toolResultPayloads[1], {
      relaySessionId: session.relaySessionId,
      type: "toolResult",
      callId: "call-1",
    });
    expectRecordFields(toolResultPayloads[1]?.talkEvent, {
      type: "tool.result",
      callId: "call-1",
      final: false,
    });
    expectRecordFields(toolResultPayloads[2], {
      relaySessionId: session.relaySessionId,
      type: "toolResult",
      callId: "call-1",
    });
    expectRecordFields(toolResultPayloads[2]?.talkEvent, {
      type: "tool.result",
      callId: "call-1",
      final: true,
    });
    expect(
      toolResultPayloads.map((payload) => events.find((event) => event.payload === payload)?.opts),
    ).toEqual([{ dropIfSlow: true }, { dropIfSlow: true }, { dropIfSlow: false }]);

    const closePayload = findEventPayload(events, (payload) => payload.type === "close");
    expectRecordFields(closePayload, {
      relaySessionId: session.relaySessionId,
      type: "close",
      reason: "completed",
    });
    expectRecordFields(closePayload.talkEvent, { type: "session.closed", final: true });
    expectDelivery(closePayload, false);
  });

  it("emits generic issue details when relay connect fails", async () => {
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI Realtime",
      isConfigured: () => true,
      createBridge: () =>
        makeRelayTransport({
          connect: vi.fn(async () => {
            throw new Error("OpenAI API key rejected with 401");
          }),
          isConnected: vi.fn(() => false),
        }),
    };
    const events: Array<{
      event: string;
      payload: unknown;
      connIds: string[];
      opts?: { dropIfSlow?: boolean };
    }> = [];
    const context = {
      broadcastToConnIds: (
        event: string,
        payload: unknown,
        connIds: ReadonlySet<string>,
        opts?: { dropIfSlow?: boolean },
      ) => {
        events.push({ event, payload, connIds: [...connIds], opts });
      },
    } as never;

    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
      model: "gpt-realtime-2",
    });
    await Promise.resolve();

    const errorPayload = findEventPayload(events, (payload) => payload.type === "error");
    expectRecordFields(errorPayload, {
      relaySessionId: session.relaySessionId,
      type: "error",
      message: "OpenAI API key rejected with 401",
      code: "realtime_unavailable",
      provider: "openai",
      model: "gpt-realtime-2",
      transport: "gateway-relay",
      phase: "connect",
    });
    expectRecordFields(errorPayload.talkEvent, {
      type: "session.error",
      final: true,
    });
    expectRecordFields((errorPayload.talkEvent as Record<string, unknown>).payload, {
      code: "realtime_unavailable",
      provider: "openai",
      model: "gpt-realtime-2",
      transport: "gateway-relay",
      phase: "connect",
    });
    expectRecordFields(events.find((event) => event.payload === errorPayload)?.opts, {
      dropIfSlow: false,
    });
  });

  it("emits an issue when the provider closes before ready", () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI Realtime",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return makeRelayTransport();
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
      model: "gpt-realtime-2",
    });

    bridgeRequest?.onClose?.("error");

    const errorPayload = findEventPayload(events, (payload) => payload.type === "error");
    expectRecordFields(errorPayload, {
      relaySessionId: session.relaySessionId,
      type: "error",
      code: "realtime_unavailable",
      provider: "openai",
      model: "gpt-realtime-2",
      transport: "gateway-relay",
      phase: "connect",
    });
    const closePayload = findEventPayload(events, (payload) => payload.type === "close");
    expectRecordFields(closePayload, {
      relaySessionId: session.relaySessionId,
      type: "close",
      reason: "error",
    });
  });

  it("does not replace provider errors with pre-ready close issues", () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI Realtime",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return makeRelayTransport();
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;
    createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
      model: "gpt-realtime-2",
    });

    bridgeRequest?.onError?.(new Error("OpenAI API key rejected with 401"));
    bridgeRequest?.onClose?.("error");

    const errorPayloads = events
      .map((entry) => entry.payload)
      .filter(
        (payload): payload is Record<string, unknown> =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "error",
      );
    expect(errorPayloads).toHaveLength(1);
    expectRecordFields(errorPayloads[0], {
      type: "error",
      code: "realtime_unavailable",
      provider: "openai",
      model: "gpt-realtime-2",
      transport: "gateway-relay",
      phase: "connect",
    });
  });

  it("does not route assistant echo transcripts back into the realtime model", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridge = makeRelayTransport({
      sendUserMessage: vi.fn(),
    });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return bridge;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;

    createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    bridgeRequest?.onTranscript?.(
      "assistant",
      "I am checking the latest status for you now.",
      true,
    );
    bridgeRequest?.onTranscript?.("user", "checking the latest status for you now", true);

    expect(bridge.sendUserMessage).not.toHaveBeenCalled();
    expect(
      events.some((entry) => {
        const payload = entry.payload;
        return (
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "toolCall"
        );
      }),
    ).toBe(false);
  });

  it("leaves provider-direct audio replies to server VAD unless forced consult routing is configured", async () => {
    vi.useFakeTimers();

    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridge = makeRelayTransport({
      supportsToolResultContinuation: true,
      sendUserMessage: vi.fn(),
      triggerGreeting: vi.fn(),
    });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return bridge;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;

    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
    });
    await Promise.resolve();

    bridgeRequest?.onTranscript?.("user", "Can you answer directly?", true);
    expect(bridge.sendUserMessage).not.toHaveBeenCalled();
    expect(
      events.some((entry) => {
        const payload = entry.payload;
        return (
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "toolCall" &&
          (payload as Record<string, unknown>).forced === true
        );
      }),
    ).toBe(false);

    stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId: "conn-1" });
  });

  it("forces an agent consult when configured and realtime transcript finalizes without a provider tool call", async () => {
    vi.useFakeTimers();

    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const sendUserMessage = vi.fn();
    const submitToolResult = vi.fn();
    const bridge = makeRelayTransport({
      supportsToolResultContinuation: true,
      sendUserMessage,
      triggerGreeting: vi.fn(),
      submitToolResult,
    });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return bridge;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;

    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
      forceAgentConsultOnFinalTranscript: true,
    });
    await Promise.resolve();

    expectRecordFields(bridgeRequest, { autoRespondToAudio: false });

    bridgeRequest?.onTranscript?.("user", "Can you check this?", true);
    expect(bridge.sendUserMessage).not.toHaveBeenCalledWith("Can you check this?");

    await vi.advanceTimersByTimeAsync(250);

    const forcedToolCall = findEventPayload(
      events,
      (payload) => payload.type === "toolCall" && payload.forced === true,
    );
    expectRecordFields(forcedToolCall, {
      relaySessionId: session.relaySessionId,
      type: "toolCall",
      name: "openclaw_agent_consult",
      forced: true,
    });
    expectRecordFields(forcedToolCall.args, {
      question: "Can you check this?",
      responseStyle: "Reply in a concise spoken tone.",
    });
    expectRecordFields(forcedToolCall.talkEvent, { type: "tool.call" });
    expectRecordFields((forcedToolCall.talkEvent as Record<string, unknown>).payload, {
      forced: true,
    });
    expect(bridge.handleBargeIn).toHaveBeenCalledWith({
      audioPlaybackActive: true,
      force: true,
    });

    const callId = String(forcedToolCall.callId);
    void submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId,
      result: { status: "working" },
      options: { willContinue: true },
    });
    expect(bridge.sendUserMessage).toHaveBeenLastCalledWith(
      "Briefly tell the person that you are checking with OpenClaw. Do not answer the request yet. Wait for the OpenClaw result before giving the actual answer.",
    );

    bridgeRequest?.onToolCall?.({
      itemId: "native-item",
      callId: "native-call",
      name: "openclaw_agent_consult",
      args: { question: "Can you check this?" },
    });
    expect(bridge.submitToolResult).toHaveBeenLastCalledWith(
      "native-call",
      {
        status: "working",
        tool: "openclaw_agent_consult",
        message:
          "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
      },
      { willContinue: true },
    );

    const forcedAcceptance = createDeferred();
    submitToolResult.mockImplementationOnce(() => forcedAcceptance.promise);
    const forcedSubmission = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId,
      result: { result: "Here is the checked answer." },
    });
    expect(bridge.sendUserMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("Here is the checked answer."),
    );
    forcedAcceptance.resolve();
    await forcedSubmission;
    expect(bridge.submitToolResult).toHaveBeenLastCalledWith(
      "native-call",
      {
        status: "already_delivered",
        message: "OpenClaw already delivered this consult result internally. Do not repeat it.",
      },
      { suppressResponse: true },
    );
    expect(bridge.sendUserMessage).toHaveBeenLastCalledWith(
      [
        "OpenClaw finished checking. Speak this result naturally and concisely.",
        "Do not mention tool calls, JSON, or internal routing.",
        "",
        "Here is the checked answer.",
      ].join("\n"),
    );
    expect(
      submitToolResult.mock.invocationCallOrder[
        submitToolResult.mock.invocationCallOrder.length - 1
      ],
    ).toBeLessThan(
      sendUserMessage.mock.invocationCallOrder[
        sendUserMessage.mock.invocationCallOrder.length - 1
      ] ?? 0,
    );
    expect(
      events.some((entry) => {
        const payload = entry.payload;
        return (
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "toolCall" &&
          (payload as Record<string, unknown>).callId === "native-call"
        );
      }),
    ).toBe(false);

    bridgeRequest?.onToolCall?.({
      itemId: "native-other-item",
      callId: "native-other-call",
      name: "openclaw_agent_consult",
      args: { question: "Can you check something else?" },
    });
    expect(bridge.submitToolResult).toHaveBeenLastCalledWith(
      "native-other-call",
      {
        status: "working",
        tool: "openclaw_agent_consult",
        message:
          "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
      },
      { willContinue: true },
    );
    const nativeOtherToolCall = findEventPayload(
      events,
      (payload) => payload.type === "toolCall" && payload.callId === "native-other-call",
    );
    expectRecordFields(nativeOtherToolCall, {
      relaySessionId: session.relaySessionId,
      type: "toolCall",
      callId: "native-other-call",
      name: "openclaw_agent_consult",
      args: { question: "Can you check something else?" },
    });
    stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId: "conn-1" });
  });

  it("uses the actual forced result when one native call cannot suppress responses", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture(["native-call"]);
    const accepted = createDeferred();
    fixture.submitToolResult.mockReturnValueOnce(accepted.promise);

    const submission = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { result: "checked" },
    });
    const duplicate = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { answer: "duplicate" },
    });
    expect(duplicate).toBe(submission);
    expect(fixture.submitToolResult).toHaveBeenCalledTimes(1);
    expect(fixture.submitToolResult).toHaveBeenCalledWith(
      "native-call",
      { result: "checked" },
      undefined,
    );
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();

    accepted.resolve();
    await submission;
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();
    expect(
      fixture.events.filter(
        (entry) =>
          (entry.payload as { type?: string; callId?: string }).type === "toolResult" &&
          (entry.payload as { callId?: string }).callId === fixture.callId,
      ),
    ).toHaveLength(1);
  });

  it("classifies forced interim and terminal results only from willContinue", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture(["native-call"]);

    await submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { phase: "checking" },
      options: { willContinue: true },
    });
    expect(fixture.submitToolResult).not.toHaveBeenCalled();

    await submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { status: "working" },
    });
    expect(fixture.submitToolResult).toHaveBeenCalledWith(
      "native-call",
      { status: "working" },
      undefined,
    );
    const finalStates = fixture.events
      .filter(
        (entry) =>
          (entry.payload as { type?: string; callId?: string }).type === "toolResult" &&
          (entry.payload as { callId?: string }).callId === fixture.callId,
      )
      .map((entry) => (entry.payload as { talkEvent?: { final?: boolean } }).talkEvent?.final);
    expect(finalStates).toEqual([false, true]);
  });

  it("waits for every native forced result when response suppression is unsupported", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture([
      "native-1",
      "native-2",
    ]);
    const first = createDeferred();
    const second = createDeferred();
    fixture.submitToolResult.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const submission = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { result: "checked" },
    });

    first.resolve();
    await Promise.resolve();
    expect(
      fixture.events.some(
        (entry) =>
          (entry.payload as { type?: string; callId?: string }).type === "toolResult" &&
          (entry.payload as { callId?: string }).callId === fixture.callId,
      ),
    ).toBe(false);
    second.resolve();
    await submission;
    expect(fixture.submitToolResult).toHaveBeenCalledTimes(2);
  });

  it("drains native calls that join while a forced terminal result is pending", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture(["native-1"]);
    const first = createDeferred();
    fixture.submitToolResult.mockReturnValueOnce(first.promise).mockReturnValueOnce(undefined);
    const submission = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { result: "checked" },
    });

    fixture.bridgeRequest?.onToolCall?.({
      itemId: "late-item",
      callId: "native-2",
      name: "openclaw_agent_consult",
      args: { question: "Can you check this?" },
    });
    expect(fixture.submitToolResult.mock.calls.map((call) => call[0])).toEqual(["native-1"]);

    first.resolve();
    await submission;
    expect(fixture.submitToolResult.mock.calls.map((call) => call[0])).toEqual([
      "native-1",
      "native-2",
    ]);
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();
    expect(
      fixture.events.filter(
        (entry) =>
          (entry.payload as { type?: string }).type === "toolResult" &&
          (entry.payload as { callId?: string }).callId === "native-2",
      ),
    ).toHaveLength(0);
  });

  it("keeps a suppression-unsupported forced result retryable after rejection", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture(["native-call"]);
    fixture.submitToolResult.mockRejectedValueOnce(new Error("native result rejected"));
    const rejected = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { answer: "checked" },
    });
    await expect(rejected).rejects.toThrow("native result rejected");
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();

    await submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { answer: "checked" },
    });
    expect(fixture.submitToolResult).toHaveBeenCalledTimes(2);
  });

  it("retries only rejected native forced results after partial acceptance", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture([
      "native-1",
      "native-2",
    ]);
    fixture.submitToolResult
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second native rejected"));
    const firstAttempt = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { answer: "checked" },
    });
    await expect(firstAttempt).rejects.toThrow("second native rejected");

    await submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { answer: "checked" },
    });
    expect(fixture.submitToolResult.mock.calls.map((call) => call[0])).toEqual([
      "native-1",
      "native-2",
      "native-2",
    ]);
  });

  it("uses the speech path without native calls even when suppression is unsupported", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture([]);
    await submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { result: "checked" },
    });

    expect(fixture.submitToolResult).not.toHaveBeenCalled();
    expect(fixture.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("checked"));
  });

  it("satisfies late native forced calls without suppression or duplicate speech", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture([]);
    await submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { result: "checked" },
    });
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);

    fixture.bridgeRequest?.onToolCall?.({
      itemId: "late-item",
      callId: "late-call",
      name: "openclaw_agent_consult",
      args: { question: "Can you check this?" },
    });
    expect(fixture.submitToolResult).toHaveBeenCalledWith(
      "late-call",
      {
        status: "already_delivered",
        message: "OpenClaw already delivered this consult result internally. Do not repeat it.",
      },
      undefined,
    );
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects direct suppressed results when the provider does not support them", () => {
    const submitToolResult = vi.fn();
    const provider = createIdleRelayProvider();
    provider.createBridge = () => ({
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      submitToolResult,
      supportsToolResultSuppression: false,
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    });
    const session = createTalkRealtimeRelaySession({
      context: { broadcastToConnIds: vi.fn() } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    expect(() =>
      submitTalkRealtimeRelayToolResult({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        callId: "call-1",
        result: { ok: true },
        options: { suppressResponse: true },
      }),
    ).toThrow("Realtime provider does not support suppressed tool results");
    expect(submitToolResult).not.toHaveBeenCalled();
  });

  it("does not force a duplicate consult after native consult or cancellation", async () => {
    vi.useFakeTimers();

    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridge = makeRelayTransport({
      supportsToolResultContinuation: true,
      sendUserMessage: vi.fn(),
      triggerGreeting: vi.fn(),
    });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return bridge;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;

    const nativeSession = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
      forceAgentConsultOnFinalTranscript: true,
    });
    await Promise.resolve();
    bridgeRequest?.onTranscript?.("user", "Can you check this?", true);
    bridgeRequest?.onToolCall?.({
      itemId: "native-item",
      callId: "native-call",
      name: "openclaw_agent_consult",
      args: { question: "Can you check this for me?" },
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(
      events.some((entry) => {
        const payload = entry.payload;
        return (
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "toolCall" &&
          (payload as Record<string, unknown>).forced === true
        );
      }),
    ).toBe(false);
    stopTalkRealtimeRelaySession({
      relaySessionId: nativeSession.relaySessionId,
      connId: "conn-1",
    });

    const unicodeSession = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
      forceAgentConsultOnFinalTranscript: true,
    });
    await Promise.resolve();
    bridgeRequest?.onTranscript?.("user", "проверь статус", true);
    bridgeRequest?.onToolCall?.({
      itemId: "unicode-native-item",
      callId: "unicode-native-call",
      name: "openclaw_agent_consult",
      args: { question: "проверь статус" },
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(
      events.some((entry) => {
        const payload = entry.payload;
        return (
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "toolCall" &&
          (payload as Record<string, unknown>).forced === true
        );
      }),
    ).toBe(false);
    stopTalkRealtimeRelaySession({
      relaySessionId: unicodeSession.relaySessionId,
      connId: "conn-1",
    });

    const cancelledSession = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
      forceAgentConsultOnFinalTranscript: true,
    });
    await Promise.resolve();
    bridgeRequest?.onTranscript?.("user", "Cancel this consult", true);
    void cancelTalkRealtimeRelayTurn({
      relaySessionId: cancelledSession.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
      turnId: ensureActiveRelayTurnId(cancelledSession.relaySessionId),
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(
      events.some((entry) => {
        const payload = entry.payload;
        return (
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "toolCall" &&
          (payload as Record<string, unknown>).forced === true
        );
      }),
    ).toBe(false);
    expect(relaySessions.has(cancelledSession.relaySessionId)).toBe(false);
  });

  it("rejects relay control from a different connection", () => {
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => makeRelayTransport(),
    };
    const session = createTalkRealtimeRelaySession({
      context: { broadcastToConnIds: vi.fn() } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    expect(
      () =>
        void sendTalkRealtimeRelayAudio({
          relaySessionId: session.relaySessionId,
          connId: "conn-2",
          audioBase64: Buffer.from("audio").toString("base64"),
        }),
    ).toThrow("Unknown realtime relay session");
  });

  it("correlates provider audio with the active relay owner", () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return makeRelayTransport();
      },
    };
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: Record<string, unknown>) => {
        events.push({ event, payload });
      },
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    void sendTalkRealtimeRelayAudio({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      audioBase64: Buffer.from("audio").toString("base64"),
    });
    const audio = Buffer.from("reply");
    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "response.created",
      responseId: "response-1",
    });
    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "response.output_audio.delta",
      itemId: "item-1",
      responseId: "response-1",
    });
    bridgeRequest?.onAudio(audio);

    const audioEvents = events
      .map((entry) => entry.payload)
      .filter((payload) => payload.type === "audio");
    expect(audioEvents).toHaveLength(1);
    const payload = audioEvents[0]!;
    expect(Buffer.from(String(payload.audioBase64), "base64")).toEqual(audio);
    expectRecordFields(payload, {
      itemId: "item-1",
      responseId: "response-1",
    });
    expectRecordFields(payload.talkEvent, {
      type: "output.audio.delta",
      turnId: "turn-1",
    });
    expectRecordFields((payload.talkEvent as { payload?: unknown }).payload, {
      byteLength: audio.byteLength,
    });
  });

  it.each([
    ["keyed exact-response", "response-1"],
    ["ID-less turn-bound", undefined],
  ])("claims a Talk turn for a %s response before browser audio", (_label, responseId) => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider = createIdleRelayProvider();
    provider.createBridge = (request) => {
      bridgeRequest = request;
      return makeRelayTransport();
    };
    const broadcastToConnIds = vi.fn();
    const session = createTalkRealtimeRelaySession({
      context: { broadcastToConnIds } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    expect(relaySessions.get(session.relaySessionId)?.harness.talk.activeTurnId).toBeUndefined();

    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "response.created",
      ...(responseId ? { responseId } : {}),
    });
    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "response.output_audio.delta",
      itemId: "item-1",
      ...(responseId ? { responseId } : {}),
    });
    bridgeRequest?.onAudio(Buffer.from("reply"));
    bridgeRequest?.onResponseDone?.({
      status: "completed",
      ...(responseId ? { responseId } : {}),
    });

    const payloads = broadcastToConnIds.mock.calls.map(
      (call) => call[1] as Record<string, unknown>,
    );
    const audioPayload = payloads.find((payload) => payload.type === "audio");
    expect(audioPayload).toMatchObject({
      type: "audio",
      ...(responseId ? { responseId } : {}),
    });
    if (!responseId) {
      expect(audioPayload).not.toHaveProperty("responseId");
    }
    expect(payloads.filter((payload) => payload.type === "audioDone")).toHaveLength(1);
    expect(payloads.some((payload) => payload.type === "error")).toBe(false);
    expect(payloads.some((payload) => payload.type === "close")).toBe(false);
    expect(relaySessions.has(session.relaySessionId)).toBe(true);
  });

  it("splits large provider audio into ordered 20 ms relay frames", () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (request) => {
        bridgeRequest = request;
        return makeRelayTransport();
      },
    };
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const session = createTalkRealtimeRelaySession({
      context: {
        broadcastToConnIds: (event: string, payload: Record<string, unknown>) => {
          events.push({ event, payload });
        },
      } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    void sendTalkRealtimeRelayAudio({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      audioBase64: Buffer.from("audio").toString("base64"),
    });
    const audio = Buffer.alloc(960 * 33 + 137);
    for (let index = 0; index < audio.length; index += 1) {
      audio[index] = index % 251;
    }
    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "response.created",
      responseId: "response-1",
    });
    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "response.output_audio.delta",
      itemId: "item-1",
      responseId: "response-1",
    });
    bridgeRequest?.onAudio(audio);

    const audioPayloads = events
      .map((entry) => entry.payload)
      .filter((payload) => payload.type === "audio");
    const frames = audioPayloads.map((payload) =>
      Buffer.from(String(payload.audioBase64), "base64"),
    );
    expect(frames).toHaveLength(34);
    expect(frames.every((frame) => frame.byteLength <= 960)).toBe(true);
    expect(frames.at(-1)?.byteLength).toBe(137);
    expect(Buffer.concat(frames)).toEqual(audio);
    for (const [index, payload] of audioPayloads.entries()) {
      expectRecordFields(payload, {
        itemId: "item-1",
        responseId: "response-1",
      });
      expectRecordFields(payload.talkEvent, {
        type: "output.audio.delta",
        turnId: "turn-1",
        seq: index + 3,
        payload: { byteLength: frames[index]?.byteLength },
      });
    }
    expect(events.some((entry) => entry.payload.type === "error")).toBe(false);
    expect(events.some((entry) => entry.payload.type === "close")).toBe(false);
  });

  it("ignores provider clear with no live response owner", () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider = createIdleRelayProvider();
    provider.createBridge = (request) => {
      bridgeRequest = request;
      return makeRelayTransport();
    };
    const broadcastToConnIds = vi.fn();
    createTalkRealtimeRelaySession({
      context: { broadcastToConnIds } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    bridgeRequest?.onClearAudio("barge-in");

    expect(broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("aborts linked agent consult runs when the relay turn is cancelled", () => {
    const { abortController, broadcast, nodeSendToSession, removeChatRun, chatRunState, session } =
      createAbortableRelayRunFixture();
    relaySessions.get(session.relaySessionId)?.harness.talk.startTurn({ turnId: "turn-1" });
    void cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
      turnId: "turn-1",
    });

    expect(abortController.signal.aborted).toBe(true);
    expect(removeChatRun).toHaveBeenCalledWith("run-1", "run-1", "main");
    expect(chatRunState.runs.get("run-1")?.agentText).toBeUndefined();
    expectChatAbortPayload(broadcast, "barge-in");
    expectNodeAbortPayload(nodeSendToSession);
  });

  it("ignores a stale turn cancellation after a replacement turn becomes active", async () => {
    const { abortController, broadcast, session } = createAbortableRelayRunFixture();
    const relay = relaySessions.get(session.relaySessionId);
    expect(relay).toBeDefined();
    relay?.harness.talk.startTurn({ turnId: "turn-a" });
    relay?.harness.talk.startTurn({ turnId: "turn-b" });
    const epoch = relay?.toolResultEpoch;
    const forcedResult = {
      result: { status: "cancelled" },
      turnId: "turn-b",
      epoch: epoch ?? 0,
    };
    relay?.forcedTerminalProviderResults.set("call-1", forcedResult);

    await expect(
      cancelTalkRealtimeRelayTurn({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        reason: "barge-in",
        turnId: "turn-a",
      }),
    ).resolves.toEqual({ status: "stale" });

    expect(relay?.harness.talk.activeTurnId).toBe("turn-b");
    expect(relay?.toolResultEpoch).toBe(epoch);
    expect(relay?.forcedTerminalProviderResults.get("call-1")).toBe(forcedResult);
    expect(abortController.signal.aborted).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("reports idle without mutating a relay that has no active turn", async () => {
    const { abortController, broadcast, session } = createAbortableRelayRunFixture();
    const relay = relaySessions.get(session.relaySessionId);
    expect(relay).toBeDefined();
    relay?.harness.talk.clearActiveTurn();
    const epoch = relay?.toolResultEpoch;

    await expect(
      cancelTalkRealtimeRelayTurn({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        reason: "barge-in",
        turnId: "turn-a",
      }),
    ).resolves.toEqual({ status: "idle" });

    expect(relay?.harness.talk.activeTurnId).toBeUndefined();
    expect(relay?.toolResultEpoch).toBe(epoch);
    expect(abortController.signal.aborted).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])(
    "preserves legacy current-turn cancellation for turn id %j",
    async (turnId) => {
      const { abortController, broadcast, session } = createAbortableRelayRunFixture();
      const relay = relaySessions.get(session.relaySessionId);
      expect(relay).toBeDefined();
      relay?.harness.talk.startTurn({ turnId: "turn-b" });
      expect(
        await cancelTalkRealtimeRelayTurn({
          relaySessionId: session.relaySessionId,
          connId: "conn-1",
          reason: "barge-in",
          turnId,
        }),
      ).toEqual({ status: "applied", turnId: "turn-b" });

      expect(relay?.harness.talk.activeTurnId).toBeUndefined();
      expect(abortController.signal.aborted).toBe(true);
      expect(broadcast).toHaveBeenCalled();
    },
  );

  it("recovers an exact-response relay only after matching provider cancellation", async () => {
    vi.useFakeTimers();
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const handleBargeIn = vi.fn();
    const close = vi.fn();
    const sendAudio = vi.fn();
    const provider = createIdleRelayProvider();
    provider.createBridge = (request) => {
      bridgeRequest = request;
      return makeRelayTransport({
        handleBargeIn,
        close,
        sendAudio,
        submitToolResult: vi.fn(() => {
          throw new Error("provider rejected cancellation");
        }),
      });
    };
    const { session } = createAbortableRelayRunFixture(provider);
    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "response.created",
      responseId: "response-1",
    });

    let cancellationSettled = false;
    const cancellation = cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      turnId: ensureActiveRelayTurnId(session.relaySessionId),
    });
    void cancellation.then(() => (cancellationSettled = true));
    await Promise.resolve();
    expect(handleBargeIn).toHaveBeenCalledWith({ audioPlaybackActive: true });
    expect(relaySessions.has(session.relaySessionId)).toBe(true);
    expect(cancellationSettled).toBe(false);

    const resumedAudio = sendTalkRealtimeRelayAudio({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      audioBase64: "AQI=",
    });
    bridgeRequest?.onResponseDone?.({ status: "completed", responseId: "response-other" });
    await Promise.resolve();
    expect(cancellationSettled).toBe(false);
    expect(sendAudio).not.toHaveBeenCalled();

    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "response.cancelled",
      responseId: "response-1",
    });
    await expect(Promise.all([cancellation, resumedAudio])).resolves.toEqual([
      { status: "applied", turnId: expect.any(String) },
      undefined,
    ]);
    expect(sendAudio).toHaveBeenCalledWith(Buffer.from([1, 2]));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(relaySessions.has(session.relaySessionId)).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  it.each(["completed", "error"] as const)(
    "passes through provider %s close and settles exact-response cancellation once",
    async (reason) => {
      vi.useFakeTimers();
      let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
      const close = vi.fn();
      const provider = createIdleRelayProvider();
      provider.createBridge = (request) => {
        bridgeRequest = request;
        return makeRelayTransport({ close });
      };
      const { broadcastToConnIds, session } = createAbortableRelayRunFixture(provider);
      bridgeRequest?.onEvent?.({
        direction: "server",
        type: "response.created",
        responseId: "response-1",
      });
      const cancellation = cancelTalkRealtimeRelayTurn({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        turnId: ensureActiveRelayTurnId(session.relaySessionId),
      });
      const settled = vi.fn();
      void cancellation.then(settled);

      bridgeRequest?.onClose?.(reason);
      bridgeRequest?.onClose?.(reason);

      await expect(cancellation).resolves.toEqual({
        status: "applied",
        turnId: expect.any(String),
      });
      expect(settled).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(relaySessions.has(session.relaySessionId)).toBe(false);
      const closeEvents = broadcastToConnIds.mock.calls.filter(
        (call) => (call[1] as { type?: string }).type === "close",
      );
      expect(closeEvents).toHaveLength(1);
      expect(closeEvents[0]?.[1]).toMatchObject({ reason });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(relaySessions.has(session.relaySessionId)).toBe(false);
      expect(
        broadcastToConnIds.mock.calls.filter(
          (call) => (call[1] as { type?: string }).type === "close",
        ),
      ).toHaveLength(1);
    },
  );

  it("closes an exact-response relay when cancellation is never confirmed", async () => {
    vi.useFakeTimers();
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const close = vi.fn();
    const provider = createIdleRelayProvider();
    provider.createBridge = (request) => {
      bridgeRequest = request;
      return makeRelayTransport({ close });
    };
    const { session } = createAbortableRelayRunFixture(provider);
    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "response.created",
      responseId: "response-1",
    });

    let cancellationSettled = false;
    const cancellation = cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      turnId: ensureActiveRelayTurnId(session.relaySessionId),
    });
    void cancellation.then(() => (cancellationSettled = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(relaySessions.has(session.relaySessionId)).toBe(true);
    expect(cancellationSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(cancellation).resolves.toEqual({ status: "applied", turnId: expect.any(String) });
    expect(relaySessions.has(session.relaySessionId)).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails visibly when a replacement response starts before cancellation confirms", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const close = vi.fn();
    const provider = createIdleRelayProvider();
    provider.createBridge = (request) => {
      bridgeRequest = request;
      return makeRelayTransport({ close });
    };
    const { broadcastToConnIds, session } = createAbortableRelayRunFixture(provider);
    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "response.created",
      responseId: "response-1",
    });
    const cancellation = cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      turnId: ensureActiveRelayTurnId(session.relaySessionId),
    });

    bridgeRequest?.onEvent?.({
      direction: "server",
      type: "response.created",
      responseId: "response-2",
    });

    expect(relaySessions.get(session.relaySessionId)?.harness.talk.activeTurnId).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(relaySessions.has(session.relaySessionId)).toBe(false);
    await expect(cancellation).resolves.toEqual({ status: "applied", turnId: expect.any(String) });
    expect(
      broadcastToConnIds.mock.calls.some((call) => (call[1] as { type?: string }).type === "error"),
    ).toBe(true);
  });

  it("closes a stalled turn-bound cancellation after its drain deadline", async () => {
    vi.useFakeTimers();
    const pending = createDeferred();
    const close = vi.fn();
    const provider = createIdleRelayProvider();
    provider.createBridge = () =>
      makeRelayTransport({ close, submitToolResult: vi.fn(() => pending.promise) });
    const { session } = createAbortableRelayRunFixture(provider);

    let cancellationSettled = false;
    const cancellation = cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      turnId: ensureActiveRelayTurnId(session.relaySessionId),
    });
    void cancellation.then(() => (cancellationSettled = true));
    const pendingAudio = Promise.resolve(
      sendTalkRealtimeRelayAudio({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        audioBase64: "AQI=",
      }),
    );
    let audioSettled = false;
    void pendingAudio.then(
      () => (audioSettled = true),
      () => (audioSettled = true),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(relaySessions.has(session.relaySessionId)).toBe(true);
    expect(cancellationSettled).toBe(false);
    expect(audioSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(cancellation).resolves.toEqual({ status: "applied", turnId: expect.any(String) });
    await expect(pendingAudio).rejects.toThrow("Unknown realtime relay session");
    expect(relaySessions.has(session.relaySessionId)).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    pending.resolve();
  });

  it("provider close owns turn-bound drain teardown and late drain cannot touch a successor", async () => {
    vi.useFakeTimers();
    const pending = createDeferred();
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const close = vi.fn();
    const provider = createIdleRelayProvider();
    provider.createBridge = (request) => {
      bridgeRequest = request;
      return makeRelayTransport({ close, submitToolResult: vi.fn(() => pending.promise) });
    };
    const { session } = createAbortableRelayRunFixture(provider);
    const cancellation = cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      turnId: ensureActiveRelayTurnId(session.relaySessionId),
    });

    bridgeRequest?.onClose?.("completed");
    await expect(cancellation).resolves.toEqual({
      status: "applied",
      turnId: expect.any(String),
    });
    expect(close).toHaveBeenCalledOnce();

    const successor = createTalkRealtimeRelaySession({
      context: { broadcastToConnIds: vi.fn() } as never,
      connId: "conn-1",
      provider: createIdleRelayProvider(),
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    pending.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(relaySessions.has(successor.relaySessionId)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("terminally satisfies a late normal result after turn cancellation without a new turn", async () => {
    const submitToolResult = vi.fn<RealtimeVoiceBridge["submitToolResult"]>();
    const provider = createIdleRelayProvider();
    provider.createBridge = () =>
      makeRelayTransport({
        submitToolResult,
      });
    const { broadcastToConnIds, session } = createAbortableRelayRunFixture(provider);
    void cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
      turnId: ensureActiveRelayTurnId(session.relaySessionId),
    });
    const startedTurns = () =>
      broadcastToConnIds.mock.calls.filter(
        (call) => (call[1] as { talkEvent?: { type?: string } }).talkEvent?.type === "turn.started",
      ).length;
    const beforeLateResult = startedTurns();

    await submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { error: "aborted" },
    });

    expect(startedTurns()).toBe(beforeLateResult);
    expect(submitToolResult).toHaveBeenCalledWith(
      "call-1",
      {
        status: "cancelled",
        message: "OpenClaw cancelled this consult before completion. Do not restart it.",
      },
      { suppressResponse: true },
    );
    expect(
      broadcastToConnIds.mock.calls.filter(
        (call) =>
          (call[1] as { type?: string; callId?: string }).type === "toolResult" &&
          (call[1] as { callId?: string }).callId === "call-1",
      ),
    ).toHaveLength(0);
  });

  it("clears linked agent consult runs after the final tool result", () => {
    const { abortController, broadcast, session } = createAbortableRelayRunFixture();

    void submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { ok: true },
    });
    void cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
      turnId: ensureActiveRelayTurnId(session.relaySessionId),
    });

    expect(abortController.signal.aborted).toBe(false);
    expect(broadcast).not.toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId: "run-1", state: "aborted" }),
      expect.anything(),
    );
  });

  it("serializes a final consult result behind async working acceptance", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const working = createDeferred();
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockReturnValueOnce(working.promise)
      .mockReturnValueOnce(undefined);
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (request) => {
        bridgeRequest = request;
        return makeRelayTransport({
          supportsToolResultContinuation: true,
          submitToolResult,
        });
      },
    };
    const events: Array<{ payload: Record<string, unknown> }> = [];
    const session = createTalkRealtimeRelaySession({
      context: {
        broadcastToConnIds: (_event: string, payload: unknown) => {
          events.push({ payload: payload as Record<string, unknown> });
        },
      } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    ensureActiveRelayTurnId(session.relaySessionId);
    bridgeRequest?.onToolCall?.({
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "check" },
    });
    const finalSubmission = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { answer: "done" },
    });

    expect(submitToolResult).toHaveBeenCalledTimes(1);
    expect(
      events.map((entry) => (entry.payload.talkEvent as { type?: string } | undefined)?.type),
    ).toContain("tool.call");
    expect(
      events.map((entry) => (entry.payload.talkEvent as { type?: string } | undefined)?.type),
    ).not.toContain("tool.progress");

    working.resolve();
    await finalSubmission;
    expect(submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ status: "working" }),
      { answer: "done" },
    ]);
    const talkTypes = events
      .map((entry) => (entry.payload.talkEvent as { type?: string } | undefined)?.type)
      .filter(Boolean);
    expect(talkTypes.indexOf("tool.call")).toBeLessThan(talkTypes.indexOf("tool.progress"));
    expect(talkTypes.indexOf("tool.progress")).toBeLessThan(talkTypes.indexOf("tool.result"));
  });

  it("serializes concurrent client interims and a final result in submission order", async () => {
    const firstAccepted = createDeferred();
    const secondAccepted = createDeferred();
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockReturnValueOnce(firstAccepted.promise)
      .mockReturnValueOnce(secondAccepted.promise)
      .mockReturnValueOnce(undefined);
    const provider = createIdleRelayProvider();
    provider.createBridge = () =>
      makeRelayTransport({
        submitToolResult,
      });
    const session = createTalkRealtimeRelaySession({
      context: { broadcastToConnIds: vi.fn() } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    const firstInterim = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { phase: "first" },
      options: { willContinue: true },
    });
    const secondInterim = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { phase: "second" },
      options: { willContinue: true },
    });
    const final = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { answer: "done" },
    });
    expect(submitToolResult).toHaveBeenCalledTimes(1);

    firstAccepted.resolve();
    await vi.waitFor(() => expect(submitToolResult).toHaveBeenCalledTimes(2));
    expect(submitToolResult).not.toHaveBeenCalledWith("call-1", { answer: "done" }, undefined);

    secondAccepted.resolve();
    await Promise.all([firstInterim, secondInterim, final]);
    expect(submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      { phase: "first" },
      { phase: "second" },
      { answer: "done" },
    ]);
  });

  it("submits an ordinary final after an interim rejection", async () => {
    let rejectInterim: ((error: Error) => void) | undefined;
    const rejectedInterim = new Promise<void>((_resolve, reject) => {
      rejectInterim = reject;
    });
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockReturnValueOnce(rejectedInterim)
      .mockReturnValueOnce(undefined);
    const provider = createIdleRelayProvider();
    provider.createBridge = () =>
      makeRelayTransport({
        submitToolResult,
      });
    const session = createTalkRealtimeRelaySession({
      context: { broadcastToConnIds: vi.fn() } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    const interim = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { phase: "checking" },
      options: { willContinue: true },
    });
    const final = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { answer: "done" },
    });

    rejectInterim?.(new Error("interim rejected"));
    await expect(interim).rejects.toThrow("interim rejected");
    await final;
    expect(submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      { phase: "checking" },
      { answer: "done" },
    ]);
  });

  it("supersedes queued interims and a stale final with canonical cancellation", async () => {
    const interimAccepted = createDeferred();
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockReturnValueOnce(interimAccepted.promise)
      .mockReturnValueOnce(undefined);
    const provider = createIdleRelayProvider();
    provider.createBridge = () =>
      makeRelayTransport({
        submitToolResult,
      });
    const { broadcastToConnIds, session } = createAbortableRelayRunFixture(provider);
    const firstInterim = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { phase: "first" },
      options: { willContinue: true },
    });
    const secondInterim = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { phase: "second" },
      options: { willContinue: true },
    });
    const final = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { answer: "stale" },
    });
    void cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
      turnId: ensureActiveRelayTurnId(session.relaySessionId),
    });
    const cancellation = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { error: "aborted" },
    });

    interimAccepted.resolve();
    await Promise.all([firstInterim, secondInterim, final, cancellation]);
    expect(submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      { phase: "first" },
      {
        status: "cancelled",
        message: "OpenClaw cancelled this consult before completion. Do not restart it.",
      },
    ]);
    expect(submitToolResult.mock.calls[1]?.[2]).toEqual({ suppressResponse: true });
    expect(
      broadcastToConnIds.mock.calls.some(
        (call) =>
          (call[1] as { type?: string; callId?: string }).type === "toolResult" &&
          (call[1] as { callId?: string }).callId === "call-1",
      ),
    ).toBe(false);
  });

  it("terminally cancels a final queued behind working acceptance without a second client result", async () => {
    const workingAccepted = createDeferred();
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockReturnValueOnce(workingAccepted.promise)
      .mockReturnValueOnce(undefined);
    const provider = createIdleRelayProvider();
    provider.createBridge = () =>
      makeRelayTransport({
        submitToolResult,
        supportsToolResultSuppression: false,
      });
    const { broadcastToConnIds, session } = createAbortableRelayRunFixture(provider);
    const working = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { status: "working" },
      options: { willContinue: true },
    });
    const final = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { answer: "stale" },
    });

    void cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
      turnId: ensureActiveRelayTurnId(session.relaySessionId),
    });
    expect(relaySessions.has(session.relaySessionId)).toBe(true);
    workingAccepted.resolve();
    await Promise.all([working, final]);
    await vi.waitFor(() => expect(relaySessions.has(session.relaySessionId)).toBe(false));

    expect(submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      { status: "working" },
      {
        status: "cancelled",
        message: "OpenClaw cancelled this consult before completion. Do not restart it.",
      },
    ]);
    expect(submitToolResult.mock.calls[1]?.[2]).toBeUndefined();
    expect(
      broadcastToConnIds.mock.calls.some(
        (call) =>
          (call[1] as { type?: string; callId?: string }).type === "toolResult" &&
          (call[1] as { callId?: string }).callId === "call-1",
      ),
    ).toBe(false);

    expect(submitToolResult).toHaveBeenCalledTimes(2);
  });

  it("supersedes a rejected in-flight final with canonical cancellation", async () => {
    let rejectFinal: ((error: Error) => void) | undefined;
    const rejectedFinal = new Promise<void>((_resolve, reject) => {
      rejectFinal = reject;
    });
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockReturnValueOnce(rejectedFinal)
      .mockReturnValueOnce(undefined);
    const provider = createIdleRelayProvider();
    provider.createBridge = () =>
      makeRelayTransport({
        submitToolResult,
      });
    const { session } = createAbortableRelayRunFixture(provider);
    const staleFinal = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { answer: "stale" },
    });
    void cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
      turnId: ensureActiveRelayTurnId(session.relaySessionId),
    });
    const cancellation = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { error: "aborted" },
    });

    rejectFinal?.(new Error("stale final rejected"));
    await expect(staleFinal).rejects.toThrow("stale final rejected");
    await cancellation;
    expect(submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      { answer: "stale" },
      {
        status: "cancelled",
        message: "OpenClaw cancelled this consult before completion. Do not restart it.",
      },
    ]);
  });

  it("waits for provider acceptance before broadcasting and clearing a final tool result", async () => {
    const deferred = createDeferred();
    const bridge = makeRelayTransport({
      submitToolResult: vi.fn(() => deferred.promise),
    });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => bridge,
    };
    const { abortController, broadcast, broadcastToConnIds, session } =
      createAbortableRelayRunFixture(provider);

    const submission = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { ok: true },
    });
    if (!submission) {
      throw new Error("Expected asynchronous provider submission");
    }
    const duplicate = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { ok: "duplicate" },
    });
    const followUp = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { status: "working" },
      options: { willContinue: true },
    });

    expect(duplicate).toBe(submission);
    expect(followUp).toBe(submission);
    expect(bridge.submitToolResult).toHaveBeenCalledTimes(1);
    expect(
      broadcastToConnIds.mock.calls.some(
        (call) => (call[1] as { type?: string }).type === "toolResult",
      ),
    ).toBe(false);

    deferred.resolve();
    await submission;

    const toolResultEvents = () =>
      broadcastToConnIds.mock.calls.filter(
        (call) => (call[1] as { type?: string }).type === "toolResult",
      );
    expect(toolResultEvents()).toHaveLength(1);
    expect(
      submitTalkRealtimeRelayToolResult({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        callId: "call-1",
        result: { ok: "already completed" },
      }),
    ).toBeUndefined();
    expect(bridge.submitToolResult).toHaveBeenCalledTimes(1);
    expect(toolResultEvents()).toHaveLength(1);
    void cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
      turnId: ensureActiveRelayTurnId(session.relaySessionId),
    });
    expect(abortController.signal.aborted).toBe(false);
    expect(broadcast).not.toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId: "run-1", state: "aborted" }),
      expect.anything(),
    );
  });

  it("keeps linked run state and omits success events when provider submission rejects", async () => {
    const bridge = makeRelayTransport({
      submitToolResult: vi.fn(() => Promise.reject(new Error("provider rejected tool result"))),
    });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => bridge,
    };
    const { abortController, broadcastToConnIds, session } =
      createAbortableRelayRunFixture(provider);

    const submission = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { ok: true },
    });
    if (!submission) {
      throw new Error("Expected asynchronous provider submission");
    }
    await expect(submission).rejects.toThrow("provider rejected tool result");
    expect(
      broadcastToConnIds.mock.calls.some(
        (call) => (call[1] as { type?: string }).type === "toolResult",
      ),
    ).toBe(false);

    void cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
      turnId: ensureActiveRelayTurnId(session.relaySessionId),
    });
    expect(abortController.signal.aborted).toBe(true);
  });

  it("allows a final tool result to retry after provider rejection", async () => {
    let attempt = 0;
    const bridge = makeRelayTransport({
      submitToolResult: vi.fn(() => {
        attempt += 1;
        return attempt === 1 ? Promise.reject(new Error("temporary rejection")) : undefined;
      }),
    });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => bridge,
    };
    const { broadcastToConnIds, session } = createAbortableRelayRunFixture(provider);

    const rejected = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { ok: false },
    });
    await expect(rejected).rejects.toThrow("temporary rejection");

    expect(
      submitTalkRealtimeRelayToolResult({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        callId: "call-1",
        result: { ok: true },
      }),
    ).toBeUndefined();
    expect(bridge.submitToolResult).toHaveBeenCalledTimes(2);
    expect(
      broadcastToConnIds.mock.calls.filter(
        (call) => (call[1] as { type?: string }).type === "toolResult",
      ),
    ).toHaveLength(1);
  });

  it("returns structured relay steering status and emits Talk progress", async () => {
    const provider = createIdleRelayProvider();
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
      sessionKey: "agent:main:main",
    });

    await expect(
      steerTalkRealtimeRelayAgentRun({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        sessionKey: "agent:other:main",
        text: "status",
        mode: "status",
      }),
    ).rejects.toThrow("Realtime relay steering session key does not match the relay session");

    const result = await steerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      sessionKey: "agent:main:main",
      text: "status",
      mode: "status",
    });

    expect(result).toMatchObject({
      ok: true,
      mode: "status",
      sessionKey: "agent:main:main",
      active: false,
    });
    const progressPayload = findEventPayload(events, (payload) => payload.type === "toolProgress");
    expectRecordFields(progressPayload, {
      relaySessionId: session.relaySessionId,
      type: "toolProgress",
    });
    expectRecordFields(progressPayload.talkEvent, {
      type: "tool.progress",
      final: true,
    });
  });

  it.each([
    {
      supportsSuppression: undefined,
      expectedOptions: { suppressResponse: true },
      expectedSuppress: false,
    },
    { supportsSuppression: false, expectedOptions: undefined, expectedSuppress: true },
  ])(
    "submits a final provider result when voice cancel aborts an active relay run ($supportsSuppression)",
    async ({ supportsSuppression, expectedOptions, expectedSuppress }) => {
      const abortEmbeddedRun = vi.fn();
      setActiveEmbeddedRun(
        "embedded-session-1",
        {
          queueMessage: vi.fn(async () => undefined),
          isStreaming: () => true,
          isCompacting: () => false,
          abort: abortEmbeddedRun,
        },
        "main",
      );
      const bridge = makeRelayTransport({
        supportsToolResultSuppression: supportsSuppression,
      });
      const provider: RealtimeVoiceProviderPlugin = {
        id: "relay-test",
        label: "Relay Test",
        isConfigured: () => true,
        createBridge: () => bridge,
      };
      const { abortController, broadcast, session } = createAbortableRelayRunFixture(provider);

      const result = await steerTalkRealtimeRelayAgentRun({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        text: "cancel that",
        mode: "cancel",
      });
      void cancelTalkRealtimeRelayTurn({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        reason: "barge-in",
        turnId: ensureActiveRelayTurnId(session.relaySessionId),
      });

      expect(result).toMatchObject({
        ok: true,
        mode: "cancel",
        suppress: expectedSuppress,
        providerResult: {
          status: "cancelled",
          message: "Cancelled the active OpenClaw run.",
        },
      });
      expect(abortEmbeddedRun).toHaveBeenCalledTimes(1);
      expect(bridge.submitToolResult).toHaveBeenCalledWith(
        "call-1",
        {
          status: "cancelled",
          message: "Cancelled the active OpenClaw run.",
        },
        expectedOptions,
      );
      expect(abortController.signal.aborted).toBe(false);
      expect(broadcast).not.toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ runId: "run-1", state: "aborted" }),
        expect.anything(),
      );

      void submitTalkRealtimeRelayToolResult({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        callId: "call-1",
        result: { error: "aborted" },
      });
      expect(bridge.submitToolResult).toHaveBeenCalledTimes(1);
    },
  );

  it("finalizes accepted cancel calls independently when another provider result rejects", async () => {
    setActiveEmbeddedRun(
      "embedded-session-1",
      {
        queueMessage: vi.fn(async () => undefined),
        isStreaming: () => true,
        isCompacting: () => false,
        abort: vi.fn(),
      },
      "main",
    );
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second cancel rejected"));
    const provider = createIdleRelayProvider();
    provider.createBridge = () =>
      makeRelayTransport({
        submitToolResult,
      });
    const { broadcastToConnIds, session } = createAbortableRelayRunFixture(provider);
    registerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      sessionKey: "main",
      runId: "run-1",
      callId: "call-2",
    });

    await expect(
      steerTalkRealtimeRelayAgentRun({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        text: "cancel that",
        mode: "cancel",
      }),
    ).rejects.toThrow("second cancel rejected");

    expect(
      broadcastToConnIds.mock.calls.filter(
        (call) =>
          (call[1] as { type?: string; callId?: string }).type === "toolResult" &&
          (call[1] as { callId?: string }).callId === "call-1",
      ),
    ).toHaveLength(1);
    expect(
      submitTalkRealtimeRelayToolResult({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        callId: "call-1",
        result: { late: true },
      }),
    ).toBeUndefined();
    expect(submitToolResult).toHaveBeenCalledTimes(2);

    await submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-2",
      result: { retry: true },
    });
    expect(submitToolResult.mock.calls.map((call) => call[0])).toEqual([
      "call-1",
      "call-2",
      "call-2",
    ]);
  });

  it("does not broadcast steering progress after the relay closes during provider acceptance", async () => {
    setActiveEmbeddedRun(
      "embedded-session-1",
      {
        queueMessage: vi.fn(async () => undefined),
        isStreaming: () => true,
        isCompacting: () => false,
        abort: vi.fn(),
      },
      "main",
    );
    const accepted = createDeferred();
    const submitToolResult = vi.fn(() => accepted.promise);
    const provider = createIdleRelayProvider();
    provider.createBridge = () =>
      makeRelayTransport({
        submitToolResult,
      });
    const { broadcastToConnIds, session } = createAbortableRelayRunFixture(provider);

    const steering = steerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      text: "cancel that",
      mode: "cancel",
    });
    await vi.waitFor(() => expect(submitToolResult).toHaveBeenCalledTimes(1));
    stopTalkRealtimeRelaySession({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
    });
    accepted.resolve();
    await steering;

    expect(
      broadcastToConnIds.mock.calls.filter(
        (call) => (call[1] as { type?: string }).type === "toolProgress",
      ),
    ).toHaveLength(0);
  });

  it("does not submit cancel results for synthetic forced-consult calls", async () => {
    vi.useFakeTimers();

    const abortEmbeddedRun = vi.fn();
    setActiveEmbeddedRun(
      "embedded-session-1",
      {
        queueMessage: vi.fn(async () => undefined),
        isStreaming: () => true,
        isCompacting: () => false,
        abort: abortEmbeddedRun,
      },
      "main",
    );

    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridge = makeRelayTransport({
      supportsToolResultContinuation: true,
      sendUserMessage: vi.fn(),
      triggerGreeting: vi.fn(),
    });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return bridge;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;

    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
      forceAgentConsultOnFinalTranscript: true,
    });
    await Promise.resolve();

    bridgeRequest?.onTranscript?.("user", "Can you check this?", true);
    await vi.advanceTimersByTimeAsync(250);
    const forcedToolCall = findEventPayload(
      events,
      (payload) => payload.type === "toolCall" && payload.forced === true,
    );
    const callId = String(forcedToolCall.callId);
    registerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      sessionKey: "main",
      runId: "run-1",
      callId,
    });

    const result = await steerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      text: "cancel that",
      mode: "cancel",
    });

    expect(result).toMatchObject({
      ok: true,
      mode: "cancel",
      providerResult: {
        status: "cancelled",
        message: "Cancelled the active OpenClaw run.",
      },
    });
    expect(abortEmbeddedRun).toHaveBeenCalledTimes(1);
    expect(bridge.submitToolResult).not.toHaveBeenCalled();
    const toolResult = findEventPayload(
      events,
      (payload) => payload.type === "toolResult" && payload.callId === callId,
    );
    expectRecordFields(toolResult, {
      relaySessionId: session.relaySessionId,
      type: "toolResult",
      callId,
    });
  });

  it("terminally cancels late forced working even when willContinue is set", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture(["native-1"]);
    void cancelTalkRealtimeRelayTurn({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
      turnId: ensureActiveRelayTurnId(fixture.session.relaySessionId),
    });
    const startedTurns = () =>
      fixture.events.filter(
        (entry) =>
          (entry.payload as { talkEvent?: { type?: string } }).talkEvent?.type === "turn.started",
      ).length;
    const beforeLateCalls = startedTurns();

    fixture.bridgeRequest?.onToolCall?.({
      itemId: "late-native-item",
      callId: "native-2",
      name: "openclaw_agent_consult",
      args: { question: "Can you check this?" },
    });
    await submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { status: "working" },
      options: { willContinue: true },
    });

    expect(startedTurns()).toBe(beforeLateCalls);
    expect(fixture.submitToolResult.mock.calls.map((call) => call[0])).toEqual(["native-1"]);
    for (const call of fixture.submitToolResult.mock.calls) {
      expect(call[1]).toEqual({
        status: "cancelled",
        message: "OpenClaw cancelled this consult before completion. Do not restart it.",
      });
      expect(call[2]).toBeUndefined();
    }
    expect(
      fixture.events.filter(
        (entry) =>
          (entry.payload as { type?: string; callId?: string }).type === "toolCall" &&
          (entry.payload as { callId?: string }).callId === "native-2",
      ),
    ).toHaveLength(0);
    const terminal = findEventPayload(
      fixture.events,
      (payload) =>
        payload.type === "toolResult" &&
        payload.callId === fixture.callId &&
        (payload.talkEvent as { final?: boolean } | undefined)?.final === true,
    );
    expectRecordFields((terminal.talkEvent as Record<string, unknown>).payload, {
      result: {
        status: "cancelled",
        message: "OpenClaw cancelled this consult before completion. Do not restart it.",
      },
      forced: true,
    });
  });

  it("terminally cancels a forced final queued behind native working acceptance", async () => {
    const workingAccepted = createDeferred();
    const fixture = await createSuppressionUnsupportedForcedConsultFixture(["native-call"], {
      firstSubmission: workingAccepted.promise,
      supportsToolResultContinuation: true,
    });
    const final = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { answer: "stale" },
    });

    void cancelTalkRealtimeRelayTurn({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
      turnId: ensureActiveRelayTurnId(fixture.session.relaySessionId),
    });
    workingAccepted.resolve();
    await final;

    expect(fixture.submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ status: "working" }),
      {
        status: "cancelled",
        message: "OpenClaw cancelled this consult before completion. Do not restart it.",
      },
    ]);
    expect(fixture.submitToolResult.mock.calls[1]?.[2]).toBeUndefined();
    expect(
      fixture.events.some(
        (entry) =>
          (entry.payload as { type?: string; callId?: string }).type === "toolResult" &&
          (entry.payload as { callId?: string }).callId === fixture.callId,
      ),
    ).toBe(true);
  });

  it("supersedes a rejected forced final with canonical cancellation", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture(["native-call"]);
    let rejectFinal: ((error: Error) => void) | undefined;
    const rejectedFinal = new Promise<void>((_resolve, reject) => {
      rejectFinal = reject;
    });
    fixture.submitToolResult.mockReturnValueOnce(rejectedFinal).mockReturnValueOnce(undefined);
    const staleFinal = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { answer: "stale" },
    });
    void cancelTalkRealtimeRelayTurn({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
      turnId: ensureActiveRelayTurnId(fixture.session.relaySessionId),
    });
    const cancellation = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { status: "working" },
      options: { willContinue: true },
    });

    rejectFinal?.(new Error("forced final rejected"));
    await expect(staleFinal).rejects.toThrow("forced final rejected");
    await cancellation;
    expect(fixture.submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      { answer: "stale" },
      {
        status: "cancelled",
        message: "OpenClaw cancelled this consult before completion. Do not restart it.",
      },
    ]);
  });

  it("keeps a forced consult deliverable when async provider cancellation rejects", async () => {
    vi.useFakeTimers();
    setActiveEmbeddedRun(
      "embedded-session-1",
      {
        queueMessage: vi.fn(async () => undefined),
        isStreaming: () => true,
        isCompacting: () => false,
        abort: vi.fn(),
      },
      "main",
    );

    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    let rejectNextSubmission = false;
    const bridge = makeRelayTransport({
      supportsToolResultContinuation: true,
      sendUserMessage: vi.fn(),
      triggerGreeting: vi.fn(),
      submitToolResult: vi.fn(() => {
        if (!rejectNextSubmission) {
          return undefined;
        }
        rejectNextSubmission = false;
        return Promise.reject(new Error("provider cancellation rejected"));
      }),
    });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (request) => {
        bridgeRequest = request;
        return bridge;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const session = createTalkRealtimeRelaySession({
      context: {
        broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
          events.push({ event, payload, connIds: [...connIds] });
        },
      } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
      forceAgentConsultOnFinalTranscript: true,
    });
    await Promise.resolve();

    bridgeRequest?.onTranscript?.("user", "Can you check this?", true);
    await vi.advanceTimersByTimeAsync(250);
    const forcedToolCall = findEventPayload(
      events,
      (payload) => payload.type === "toolCall" && payload.forced === true,
    );
    const callId = String(forcedToolCall.callId);
    bridgeRequest?.onToolCall?.({
      itemId: "native-item",
      callId: "native-call",
      name: "openclaw_agent_consult",
      args: { question: "Can you check this?" },
    });
    registerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      sessionKey: "main",
      runId: "run-1",
      callId,
    });

    rejectNextSubmission = true;
    await expect(
      steerTalkRealtimeRelayAgentRun({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        text: "cancel that",
        mode: "cancel",
      }),
    ).rejects.toThrow("provider cancellation rejected");

    await submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId,
      result: { result: "Here is the checked answer." },
    });
    expect(bridge.submitToolResult).toHaveBeenLastCalledWith(
      "native-call",
      {
        status: "already_delivered",
        message: "OpenClaw already delivered this consult result internally. Do not repeat it.",
      },
      { suppressResponse: true },
    );
    expect(bridge.sendUserMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("Here is the checked answer."),
    );
  });

  it("does not duplicate control-like transcripts when the linked relay run is already gone", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridge = makeRelayTransport({
      sendUserMessage: vi.fn(),
    });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return bridge;
      },
    };
    const context = {
      broadcastToConnIds: vi.fn(),
      chatAbortControllers: new Map(),
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    registerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      sessionKey: "main",
      runId: "stale-run",
      callId: "call-1",
    });

    bridgeRequest?.onTranscript?.("user", "status", true);

    expect(bridge.sendUserMessage).not.toHaveBeenCalled();
    expect(bridge.submitToolResult).not.toHaveBeenCalled();
  });

  it("aborts linked agent consult runs when the relay session closes", () => {
    const { abortController, broadcast, nodeSendToSession, chatRunState, session } =
      createAbortableRelayRunFixture();
    stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId: "conn-1" });

    expect(abortController.signal.aborted).toBe(true);
    expect(chatRunState.runs.get("run-1")?.agentText).toBeUndefined();
    expectChatAbortPayload(broadcast, "relay-closed");
    expectNodeAbortPayload(nodeSendToSession);
  });

  it("detaches linked agent consult runs when the gateway connection closes", () => {
    const close = vi.fn();
    const provider = createIdleRelayProvider();
    provider.createBridge = () => makeRelayTransport({ close });
    const { abortController, session } = createAbortableRelayRunFixture(provider);

    cleanupTalkConnection("conn-1", { warn: vi.fn() });

    expect(close).toHaveBeenCalledOnce();
    expect(abortController.signal.aborted).toBe(false);
    expect(relaySessions.has(session.relaySessionId)).toBe(false);
  });

  it.each([
    {
      name: "expires",
      close: (session: { relaySessionId: string }) => {
        const relay = relaySessions.get(session.relaySessionId);
        if (!relay) {
          throw new Error("expected active relay");
        }
        relay.expiresAtMs = Date.now() - 1;
        void sendTalkRealtimeRelayAudio({
          relaySessionId: session.relaySessionId,
          connId: "conn-1",
          audioBase64: "AQI=",
        });
      },
    },
    {
      name: "fails connection ownership",
      close: (session: { relaySessionId: string }) => {
        void sendTalkRealtimeRelayAudio({
          relaySessionId: session.relaySessionId,
          connId: "conn-other",
          audioBase64: "AQI=",
        });
      },
    },
  ])("aborts linked agent consult runs when the relay $name", ({ close }) => {
    const fixture = createAbortableRelayRunFixture();

    expect(() => close(fixture.session)).toThrow("Unknown realtime relay session");

    expect(fixture.abortController.signal.aborted).toBe(true);
    expectChatAbortPayload(fixture.broadcast, "relay-closed");
    expectNodeAbortPayload(fixture.nodeSendToSession);
  });

  it("aborts linked agent consult runs when the provider closes the relay", () => {
    const abortController = new AbortController();
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const removeChatRun = vi.fn(() => ({ sessionKey: "main", clientRunId: "run-1" }));
    const chatRunState = createChatRunState();
    Object.assign(chatRunState.getOrCreate("run-1"), {
      buffer: "partial answer",
      agentText: {
        assistant: {
          lastSentAt: Date.now(),
          bufferedEvent: {
            payload: {
              runId: "run-1",
              seq: 1,
              stream: "assistant",
              ts: Date.now(),
              data: { text: "pending", delta: "pending" },
            },
          },
        },
      },
    });
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return makeRelayTransport();
      },
    };
    const context = {
      broadcastToConnIds: vi.fn(),
      broadcast,
      nodeSendToSession,
      chatAbortControllers: new Map([
        [
          "run-1",
          {
            controller: abortController,
            sessionId: "run-1",
            sessionKey: "main",
            startedAtMs: 1,
            expiresAtMs: Date.now() + 60_000,
          },
        ],
      ]),
      chatRunState,
      removeChatRun,
      agentRunSeq: new Map(),
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    registerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      sessionKey: "main",
      runId: "run-1",
    });
    bridgeRequest?.onClose?.("error");

    expect(abortController.signal.aborted).toBe(true);
    expect(chatRunState.runs.get("run-1")?.agentText).toBeUndefined();
    expectChatAbortPayload(broadcast, "relay-error");
    expectNodeAbortPayload(nodeSendToSession);
  });

  it("fails closed when retained relay tool-call identities reach their hard cap", () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const close = vi.fn();
    const submitToolResult = vi.fn();
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (request) => {
        bridgeRequest = request;
        return makeRelayTransport({
          submitToolResult,
          close,
        });
      },
    };
    const broadcastToConnIds = vi.fn();
    const session = createTalkRealtimeRelaySession({
      context: { broadcastToConnIds } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    const retainedSession = relaySessions.get(session.relaySessionId);
    expect(retainedSession).toBeDefined();
    ensureActiveRelayTurnId(session.relaySessionId);
    const toolCallEventCount = () =>
      broadcastToConnIds.mock.calls.filter(
        ([, payload]) =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as { type?: string }).type === "toolCall",
      ).length;

    for (let index = 0; index < MAX_RELAY_TOOL_CALL_IDENTITIES; index += 1) {
      bridgeRequest?.onToolCall?.({
        itemId: `item-${index}`,
        callId: `call-${index}`,
        name: "lookup",
        args: {},
      });
    }

    expect(retainedSession?.toolCalls.size).toBe(MAX_RELAY_TOOL_CALL_IDENTITIES);
    expect(relaySessions.has(session.relaySessionId)).toBe(true);
    expect(toolCallEventCount()).toBe(MAX_RELAY_TOOL_CALL_IDENTITIES);

    bridgeRequest?.onToolCall?.({
      itemId: "item-overflow",
      callId: "call-overflow",
      name: "lookup",
      args: {},
    });

    expect(close).toHaveBeenCalledOnce();
    expect(relaySessions.has(session.relaySessionId)).toBe(false);
    expect(retainedSession?.toolCalls.has("call-overflow")).toBe(false);
    expect(toolCallEventCount()).toBe(MAX_RELAY_TOOL_CALL_IDENTITIES);
    expect(submitToolResult).not.toHaveBeenCalled();
    expect(
      broadcastToConnIds.mock.calls.filter(
        ([, payload]) =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as { type?: string }).type === "error",
      ),
    ).toHaveLength(1);
    expect(
      broadcastToConnIds.mock.calls.filter(
        ([, payload]) =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as { type?: string }).type === "close",
      ),
    ).toHaveLength(1);

    bridgeRequest?.onToolCall?.({
      itemId: "item-late",
      callId: "call-late",
      name: "lookup",
      args: {},
    });
    expect(close).toHaveBeenCalledOnce();
    expect(retainedSession?.toolCalls.size).toBe(MAX_RELAY_TOOL_CALL_IDENTITIES);
    expect(retainedSession?.toolCalls.has("call-late")).toBe(false);
    expect(toolCallEventCount()).toBe(MAX_RELAY_TOOL_CALL_IDENTITIES);
    expect(submitToolResult).not.toHaveBeenCalled();
  });

  it("does not emit continuity events after tool-call overflow closes the relay", () => {
    vi.useFakeTimers();
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const close = vi.fn();
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (request) => {
        bridgeRequest = request;
        return makeRelayTransport({
          close,
        });
      },
    };
    const broadcastToConnIds = vi.fn();
    const session = createTalkRealtimeRelaySession({
      context: { broadcastToConnIds } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
      forceAgentConsultOnFinalTranscript: true,
    });
    const retainedSession = relaySessions.get(session.relaySessionId);
    expect(
      retainedSession?.toolCalls.tryAdmit(
        Array.from({ length: MAX_RELAY_TOOL_CALL_IDENTITIES }, (_, index) => `call-${index}`),
      ),
    ).toBe(true);
    bridgeRequest?.onTranscript?.("user", "check this", true);

    bridgeRequest?.onEvent?.({
      direction: "client",
      type: "session.continuity.reset",
    });

    const terminalTypes = broadcastToConnIds.mock.calls
      .map(([, payload]) =>
        typeof payload === "object" && payload !== null
          ? (payload as { type?: string }).type
          : undefined,
      )
      .filter((type) => type === "error" || type === "close" || type === "clear");
    expect(terminalTypes).toEqual(["error", "close"]);
    expect(close).toHaveBeenCalledOnce();
    expect(relaySessions.has(session.relaySessionId)).toBe(false);
  });

  it("caps active relay sessions per browser connection", () => {
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => makeRelayTransport(),
    };
    const createSession = (connId: string) =>
      createTalkRealtimeRelaySession({
        context: { broadcastToConnIds: vi.fn() } as never,
        connId,
        provider,
        providerConfig: {},
        instructions: "brief",
        tools: [],
      });

    createSession("conn-1");
    createSession("conn-1");

    expect(() => createSession("conn-1")).toThrow(
      "Too many active realtime relay sessions for this connection",
    );
    const session = expectRecordFields(createSession("conn-2"), {
      provider: "relay-test",
      transport: "gateway-relay",
    });
    expectRecordFields(session.audio, {
      inputEncoding: "pcm16",
      outputEncoding: "pcm16",
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
