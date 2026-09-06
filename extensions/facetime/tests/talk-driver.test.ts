import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildCancelResult: vi.fn((message: string) => ({ status: "cancelled", message })),
  bridge: {
    bridge: { supportsToolResultContinuation: false },
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    connect: vi.fn<() => Promise<void>>(),
    sendAudio: vi.fn(),
    sendUserMessage: vi.fn(),
    handleBargeIn: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult: vi.fn(),
    triggerGreeting: vi.fn(),
  },
  createSession: vi.fn(),
  consult: vi.fn(),
  resolveBootstrapContext: vi.fn(),
  resolveProvider: vi.fn(() => ({ provider: { id: "openai" }, providerConfig: {} })),
  hangupRequested: vi.fn(async () => {}),
  senderAuthVersion: 1 as number | undefined,
  pump: {
    suppressionReady: vi.fn(async () => {}),
    routeReady: vi.fn(async () => {}),
    processOutputSuppressed: vi.fn(() => true),
    writeOutputAudio: vi.fn(),
    finishOutputAudio: vi.fn(),
    clearOutputAudio: vi.fn(),
    playedAudioFrames: vi.fn(() => 0),
    queuedAudioFrames: vi.fn(() => 0),
    suspendMedia: vi.fn(async () => {}),
    failClosed: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  },
  pumpParams: undefined as
    | undefined
    | {
        onError(error: Error): void | Promise<void>;
        onInputAudio(audio: Buffer): void;
        onPlaybackDrained(event: { generation: number; playedFrames: number }): void;
      },
  sessionParams: undefined as
    | undefined
    | {
        audioSink: {
          isOpen(): boolean;
          sendAudio(audio: Buffer): void;
          clearAudio(): void;
        };
        instructions?: string;
        tools?: Array<{ name: string; description: string }>;
        onEvent(event: {
          direction: "client" | "server";
          type: string;
          detail?: string;
          responseId?: string;
        }): void;
        onResponseDone?(outcome: {
          status: "completed" | "cancelled" | "failed" | "incomplete";
          responseId?: string;
          message?: string;
        }): void;
        onReady(): void;
        onError(error: Error): void;
        onClose(reason: "completed" | "error"): void;
        onToolCall(event: {
          itemId: string;
          callId: string;
          name: string;
          args: unknown;
        }): void | Promise<void>;
      },
}));

vi.mock("openclaw/plugin-sdk/realtime-voice", () => ({
  REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES: ["safe-read-only", "owner", "none"],
  isRealtimeVoiceAgentConsultToolPolicy: (value: unknown) =>
    value === "safe-read-only" || value === "owner" || value === "none",
  get REALTIME_VOICE_AGENT_CONSULT_SENDER_AUTH_VERSION() {
    return mocks.senderAuthVersion;
  },
  buildRealtimeVoiceAgentConsultPolicyInstructions: vi.fn(() => "Consult behavior: always."),
  buildRealtimeVoiceAgentCancelProviderResult: mocks.buildCancelResult,
  buildRealtimeVoiceAgentConsultWorkingResponse: vi.fn(),
  consultRealtimeVoiceAgent: mocks.consult,
  createRealtimeVoiceBridgeSession: mocks.createSession,
  getRealtimeVoiceProvider: vi.fn((providerId: string) => ({ id: providerId })),
  createTalkSessionController: vi.fn(() => {
    const recentEvents: unknown[] = [];
    const remember = (event: unknown) => {
      recentEvents.push(event);
      return event;
    };
    return {
      outputAudioActive: false,
      recentEvents,
      emit: vi.fn(remember),
      ensureTurn: vi.fn(() => ({ turnId: "turn-1" })),
      startOutputAudio: vi.fn(() => ({ event: undefined })),
      finishOutputAudio: vi.fn(),
      endTurn: vi.fn(() => ({ ok: false })),
    };
  }),
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME: "openclaw_agent_consult",
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ: "pcm16-24khz",
  recordTalkObservabilityEvent: vi.fn(),
  recordRealtimeVoiceTranscript: vi.fn((transcript, role, text, maxEntries = 40) => {
    const entry = { at: new Date().toISOString(), role, text };
    transcript.push(entry);
    transcript.splice(0, Math.max(0, transcript.length - maxEntries));
    return entry;
  }),
  resolveConfiguredRealtimeVoiceProvider: mocks.resolveProvider,
  resolveRealtimeVoiceAgentConsultTools: vi.fn(
    (policy: string, customTools: Array<{ name: string }> = []) => [
      ...(policy === "none" ? [] : [{ name: "openclaw_agent_consult" }]),
      ...customTools,
    ],
  ),
  resolveRealtimeVoiceAgentConsultToolsAllow: vi.fn(() => []),
}));

vi.mock("openclaw/plugin-sdk/realtime-bootstrap-context", () => ({
  resolveRealtimeBootstrapContextInstructions: mocks.resolveBootstrapContext,
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveDefaultAgentId: vi.fn(
    (config: { agents?: { list?: Array<{ id: string; default?: boolean }> } }) => {
      const agents = config.agents?.list ?? [];
      return agents.find((agent) => agent.default)?.id ?? agents[0]?.id ?? "main";
    },
  ),
}));

vi.mock("../src/audio-pump.js", () => ({
  startFaceTimeAudioPump: vi.fn((params) => {
    mocks.pumpParams = params;
    return mocks.pump;
  }),
}));

import { resolveFaceTimeConfig } from "../src/config.js";
import { resolveFaceTimeRealtimeProvider } from "../src/talk-driver-config.js";
import { startFaceTimeTalkDriver } from "../src/talk-driver.js";

function startParams(overrides: Record<string, unknown> = {}) {
  return {
    config: resolveFaceTimeConfig({ ownerHandles: ["caller@example.com"] }),
    fullConfig: {} as any,
    runtime: {
      agent: {
        session: {
          resolveStorePath: vi.fn(() => "/store"),
          getSessionEntry: vi.fn(() => ({ sessionId: "facetime-consult-session" })),
        },
      },
    } as any,
    logger: console,
    callUUID: "call-1",
    senderId: "caller@example.com",
    senderIsOwner: true as const,
    captureBinary: "/capture",
    onHangupRequested: mocks.hangupRequested,
    ...overrides,
  };
}

async function startReadyFaceTimeTalkDriver(params = startParams()) {
  const driver = await startFaceTimeTalkDriver(params);
  const ready = driver.readyForAudio();
  await vi.waitFor(() => expect(mocks.createSession).toHaveBeenCalledOnce());
  mocks.sessionParams?.onReady();
  await ready;
  return driver;
}

describe("FaceTime talk driver lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.senderAuthVersion = 1;
    mocks.resolveBootstrapContext.mockResolvedValue(undefined);
    mocks.bridge.connect.mockResolvedValue();
    mocks.pump.suppressionReady.mockResolvedValue();
    mocks.pump.routeReady.mockResolvedValue();
    mocks.pump.suspendMedia.mockResolvedValue();
    mocks.pump.stop.mockResolvedValue();
    mocks.pumpParams = undefined;
    mocks.sessionParams = undefined;
    mocks.bridge.bridge.supportsToolResultContinuation = false;
    (
      mocks.bridge.bridge as { supportsToolResultSuppression?: boolean }
    ).supportsToolResultSuppression = true;
    mocks.createSession.mockImplementation((params) => {
      mocks.sessionParams = params;
      return mocks.bridge;
    });
  });

  it("resolves only the explicitly selected plugin-local provider secret", async () => {
    await withEnvAsync({ SELECTED_REALTIME_KEY: "selected-key" }, async () => {
      await resolveFaceTimeRealtimeProvider({
        config: resolveFaceTimeConfig({
          ownerHandles: ["caller@example.com"],
          realtime: {
            provider: "selected",
            providers: {
              ignored: {
                apiKey: { source: "env", provider: "default", id: "MISSING_IGNORED_KEY" },
              },
              selected: {
                apiKey: { source: "env", provider: "default", id: "SELECTED_REALTIME_KEY" },
              },
            },
          },
        }),
        fullConfig: {} as never,
        agentId: "main",
      });

      expect(mocks.resolveProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          configuredProviderId: "selected",
          providerConfigs: { selected: { apiKey: "selected-key" } },
          surface: "bridge",
        }),
      );
    });
  });

  it("closes native audio when startup is aborted during provider connect", async () => {
    mocks.bridge.connect.mockImplementation(() => new Promise<void>(() => {}));
    const controller = new AbortController();
    const driver = await startFaceTimeTalkDriver(startParams({ signal: controller.signal }));
    const ready = driver.readyForAudio();

    await vi.waitFor(() => expect(mocks.bridge.connect).toHaveBeenCalledOnce());
    controller.abort();

    await expect(ready).rejects.toThrow("startup aborted");
    expect(mocks.bridge.close).toHaveBeenCalledOnce();
    expect(mocks.pump.stop).toHaveBeenCalledOnce();
  });

  it("fails closed when OpenClaw cannot forward authenticated sender identity", async () => {
    mocks.senderAuthVersion = undefined;

    await expect(startFaceTimeTalkDriver(startParams())).rejects.toThrow(
      "does not support authenticated sender identity",
    );
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.pump.stop).not.toHaveBeenCalled();
  });

  it("returns after native suppression without connecting the provider", async () => {
    let releaseSuppression = () => {};
    mocks.pump.suppressionReady.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSuppression = resolve;
        }),
    );
    const starting = startFaceTimeTalkDriver(startParams());

    await vi.waitFor(() => expect(mocks.pump.suppressionReady).toHaveBeenCalledOnce());
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.bridge.connect).not.toHaveBeenCalled();

    releaseSuppression();
    const driver = await starting;

    expect(driver.processOutputSuppressed()).toBe(true);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.bridge.connect).not.toHaveBeenCalled();
  });

  it("waits for provider connect, provider ready, and microphone routing", async () => {
    let releaseConnect = () => {};
    let releaseRoute = () => {};
    mocks.bridge.connect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseConnect = resolve;
        }),
    );
    mocks.pump.routeReady.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseRoute = resolve;
        }),
    );
    const driver = await startFaceTimeTalkDriver(startParams());
    const first = driver.readyForAudio();
    const second = driver.readyForAudio();
    let fullyReady = false;
    void first.then(() => {
      fullyReady = true;
    });

    await vi.waitFor(() => expect(mocks.bridge.connect).toHaveBeenCalledOnce());
    expect(mocks.pump.routeReady).not.toHaveBeenCalled();
    expect(driver.realtimeActive()).toBe(false);

    releaseConnect();
    await Promise.resolve();
    expect(driver.realtimeActive()).toBe(false);

    mocks.sessionParams?.onReady();
    await vi.waitFor(() => expect(driver.realtimeActive()).toBe(true));
    expect(mocks.pump.routeReady).toHaveBeenCalledOnce();
    expect(fullyReady).toBe(false);

    releaseRoute();
    await Promise.all([first, second]);
    expect(fullyReady).toBe(true);
    expect(driver.realtimeActive()).toBe(true);
  });

  it("keeps the carrier alive for a recoverable provider error after readiness", async () => {
    const onFailure = vi.fn(async () => true);
    const driver = await startReadyFaceTimeTalkDriver(startParams({ onFailure }));

    mocks.sessionParams?.onError(new Error("socket reconnecting"));
    await Promise.resolve();

    expect(driver.realtimeActive()).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();
    expect(mocks.pump.suspendMedia).not.toHaveBeenCalled();
  });

  it("ignores a stale response terminal and drains only the current response", async () => {
    await startReadyFaceTimeTalkDriver();
    mocks.pump.queuedAudioFrames.mockReturnValue(240);
    mocks.sessionParams?.onEvent({
      direction: "server",
      type: "response.created",
      responseId: "response-current",
    });
    mocks.sessionParams?.audioSink.sendAudio(Buffer.alloc(480));
    mocks.sessionParams?.onResponseDone?.({
      status: "completed",
      responseId: "response-stale",
    });
    expect(mocks.pump.finishOutputAudio).not.toHaveBeenCalled();

    mocks.sessionParams?.onResponseDone?.({
      status: "completed",
      responseId: "response-current",
    });
    expect(mocks.pump.finishOutputAudio).toHaveBeenCalledOnce();
    mocks.pump.queuedAudioFrames.mockReturnValue(0);
    mocks.pumpParams?.onPlaybackDrained({ generation: 1, playedFrames: 240 });
    expect(mocks.pump.clearOutputAudio).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "failed", "incomplete"] as const)(
    "flushes native playback for a %s response outcome without killing the carrier",
    async (status) => {
      const onFailure = vi.fn(async () => true);
      const driver = await startReadyFaceTimeTalkDriver(startParams({ onFailure }));
      mocks.sessionParams?.onEvent({
        direction: "server",
        type: "response.created",
        responseId: "response-1",
      });
      mocks.sessionParams?.audioSink.sendAudio(Buffer.alloc(480));
      mocks.sessionParams?.onResponseDone?.({
        status,
        responseId: "response-1",
        ...(status === "failed" || status === "incomplete"
          ? { message: `response ${status}` }
          : {}),
      });

      expect(mocks.pump.clearOutputAudio).toHaveBeenCalled();
      expect(onFailure).not.toHaveBeenCalled();
      expect(driver.realtimeActive()).toBe(true);
    },
  );

  it("rejects pending audio readiness when safety suspension wins the route race", async () => {
    let releaseRoute = () => {};
    mocks.pump.routeReady.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseRoute = resolve;
        }),
    );
    const driver = await startFaceTimeTalkDriver(startParams());
    const ready = driver.readyForAudio();
    const failed = expect(ready).rejects.toThrow(
      "FaceTime model media suspended: carrier-hangup-pending",
    );
    await vi.waitFor(() => expect(mocks.createSession).toHaveBeenCalledOnce());
    mocks.sessionParams?.onReady();
    await vi.waitFor(() => expect(driver.realtimeActive()).toBe(true));

    await driver.suspendMedia("carrier-hangup-pending");
    releaseRoute();

    await failed;
    expect(driver.realtimeActive()).toBe(false);
  });

  it("fails closed when the provider never becomes ready after connect", async () => {
    vi.useFakeTimers();
    try {
      const onFailure = vi.fn(async () => true);
      const driver = await startFaceTimeTalkDriver(startParams({ onFailure }));
      const ready = driver.readyForAudio();
      const failed = expect(ready).rejects.toThrow(
        "Realtime provider was not ready within 15 seconds",
      );

      await vi.advanceTimersByTimeAsync(15_000);

      await failed;
      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Realtime provider was not ready within 15 seconds",
        }),
      );
      expect(mocks.pump.suspendMedia).toHaveBeenCalledOnce();
      expect(mocks.bridge.close).toHaveBeenCalledOnce();
      expect(mocks.pump.stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not forward caller audio before final activation", async () => {
    const driver = await startReadyFaceTimeTalkDriver();

    mocks.pumpParams?.onInputAudio(Buffer.from([1, 2]));
    expect(mocks.bridge.sendAudio).not.toHaveBeenCalled();

    driver.activate();
    mocks.pumpParams?.onInputAudio(Buffer.from([3, 4]));
    expect(mocks.bridge.sendAudio).toHaveBeenCalledOnce();
    expect(mocks.bridge.sendAudio).toHaveBeenCalledWith(Buffer.from([3, 4]));
  });

  it("reports an audio-child failure to the owning runtime", async () => {
    const onFailure = vi.fn();
    await startReadyFaceTimeTalkDriver(startParams({ onFailure }));

    await mocks.pumpParams?.onError(new Error("capture failed"));

    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "capture failed" }));
    expect(mocks.pump.stop).toHaveBeenCalledOnce();
    expect(mocks.pump.suspendMedia).toHaveBeenCalledOnce();
    expect(mocks.bridge.close).toHaveBeenCalledOnce();
  });

  it("reports carrier failure and performs final teardown when media suspension rejects", async () => {
    const onFailure = vi.fn(async () => true);
    const driver = await startReadyFaceTimeTalkDriver(startParams({ onFailure }));
    mocks.pump.suspendMedia.mockRejectedValueOnce(new Error("native playback teardown failed"));

    await mocks.pumpParams?.onError(new Error("capture failed"));

    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "capture failed" }));
    expect(mocks.pump.stop).toHaveBeenCalledOnce();
    expect(driver.realtimeActive()).toBe(false);
  });

  it("retains process-tap suppression when carrier cleanup is not yet safe", async () => {
    const onFailure = vi.fn(async () => false);
    await startReadyFaceTimeTalkDriver(startParams({ onFailure }));

    await expect(mocks.pumpParams?.onError(new Error("carrier hangup pending"))).resolves.toBe(
      false,
    );

    expect(onFailure).toHaveBeenCalledOnce();
    expect(mocks.pump.stop).not.toHaveBeenCalled();
    expect(mocks.pump.suspendMedia).toHaveBeenCalledOnce();
    expect(mocks.bridge.close).toHaveBeenCalledOnce();
  });

  it("stops all model media while retaining native process suppression", async () => {
    const driver = await startReadyFaceTimeTalkDriver();
    driver.activate();
    mocks.pumpParams?.onInputAudio(Buffer.from([1, 2]));
    mocks.sessionParams?.audioSink.sendAudio(Buffer.from([3, 4]));
    expect(mocks.bridge.sendAudio).toHaveBeenCalledOnce();
    expect(mocks.pump.writeOutputAudio).toHaveBeenCalledOnce();

    await driver.suspendMedia("carrier-hangup-pending");
    mocks.pumpParams?.onInputAudio(Buffer.from([5, 6]));
    mocks.sessionParams?.audioSink.sendAudio(Buffer.from([7, 8]));
    mocks.sessionParams?.audioSink.clearAudio();

    expect(driver.processOutputSuppressed()).toBe(true);
    expect(driver.realtimeActive()).toBe(false);
    expect(mocks.bridge.sendAudio).toHaveBeenCalledTimes(1);
    expect(mocks.pump.writeOutputAudio).toHaveBeenCalledTimes(1);
    expect(mocks.pump.clearOutputAudio).not.toHaveBeenCalled();
    expect(mocks.pump.suspendMedia).toHaveBeenCalledOnce();
    expect(mocks.pump.stop).not.toHaveBeenCalled();
  });

  it("rejects startup instead of returning a stopped driver after an audio failure", async () => {
    mocks.bridge.connect.mockImplementation(() => new Promise<void>(() => {}));
    const onFailure = vi.fn(async () => true);
    const driver = await startFaceTimeTalkDriver(startParams({ onFailure }));
    const ready = driver.readyForAudio();

    await vi.waitFor(() => expect(mocks.bridge.connect).toHaveBeenCalledOnce());
    await mocks.pumpParams?.onError(new Error("capture failed during connect"));

    await expect(ready).rejects.toThrow("capture failed during connect");
    expect(onFailure).toHaveBeenCalledOnce();
    expect(mocks.pump.stop).toHaveBeenCalledOnce();
    expect(mocks.bridge.close).toHaveBeenCalledOnce();
  });

  it("retains process suppression until provider-startup carrier cleanup is safe", async () => {
    mocks.bridge.connect.mockRejectedValue(new Error("provider connect failed"));
    let releaseCarrierSafety = (_safeToClose: boolean) => {};
    const onFailure = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseCarrierSafety = resolve;
        }),
    );
    const driver = await startFaceTimeTalkDriver(startParams({ onFailure }));
    const ready = driver.readyForAudio();

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce());
    expect(mocks.pump.stop).not.toHaveBeenCalled();
    expect(mocks.pump.suspendMedia).toHaveBeenCalledOnce();
    expect(mocks.bridge.close).toHaveBeenCalledOnce();

    releaseCarrierSafety(true);

    await expect(ready).rejects.toThrow("provider connect failed");

    expect(mocks.pump.stop).toHaveBeenCalledOnce();
    expect(mocks.bridge.close).toHaveBeenCalledOnce();
  });

  it("stops native audio when Realtime session construction throws", async () => {
    mocks.createSession.mockImplementationOnce(() => {
      throw new Error("session construction failed");
    });

    const driver = await startFaceTimeTalkDriver(startParams());
    await expect(driver.readyForAudio()).rejects.toThrow("session construction failed");
    expect(mocks.pump.stop).toHaveBeenCalledOnce();
  });

  it("activates the greeting only after the call is answered", async () => {
    const driver = await startReadyFaceTimeTalkDriver();

    expect(mocks.bridge.triggerGreeting).not.toHaveBeenCalled();
    driver.activate();
    driver.activate();

    expect(mocks.bridge.triggerGreeting).toHaveBeenCalledOnce();
  });

  it("ends the current call directly without consulting the agent", async () => {
    await startReadyFaceTimeTalkDriver();

    expect(mocks.sessionParams?.tools?.map((tool) => tool.name)).toEqual([
      "openclaw_agent_consult",
      "facetime_end_call",
    ]);
    expect(mocks.sessionParams?.instructions).toContain("call facetime_end_call immediately");

    await mocks.sessionParams?.onToolCall({
      itemId: "item-hangup",
      callId: "provider-hangup",
      name: "facetime_end_call",
      args: {},
    });

    expect(mocks.bridge.submitToolResult).toHaveBeenCalledWith(
      "provider-hangup",
      {
        status: "ending",
        message: "The current FaceTime call is ending. Do not speak another response.",
      },
      { suppressResponse: true },
    );
    expect(mocks.hangupRequested).toHaveBeenCalledOnce();
    expect(mocks.consult).not.toHaveBeenCalled();
  });

  it("keeps direct hangup available when agent consult tools are disabled", async () => {
    await startReadyFaceTimeTalkDriver(
      startParams({
        config: resolveFaceTimeConfig({
          ownerHandles: ["caller@example.com"],
          realtime: { toolPolicy: "none" },
        }),
      }),
    );

    expect(mocks.sessionParams?.tools?.map((tool) => tool.name)).toEqual(["facetime_end_call"]);
  });

  it("deduplicates repeated realtime hangup tool events", async () => {
    await startReadyFaceTimeTalkDriver();
    const event = {
      itemId: "item-hangup",
      callId: "provider-hangup",
      name: "facetime_end_call",
      args: {},
    };

    await mocks.sessionParams?.onToolCall(event);
    await mocks.sessionParams?.onToolCall(event);

    expect(mocks.hangupRequested).toHaveBeenCalledOnce();
    expect(mocks.consult).not.toHaveBeenCalled();
  });

  it("makes concurrent close callers join the same cleanup", async () => {
    let finishStop = () => {};
    mocks.pump.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    const driver = await startReadyFaceTimeTalkDriver();

    const first = driver.close("first");
    const second = driver.close("second");
    await vi.waitFor(() => expect(mocks.pump.stop).toHaveBeenCalledOnce());
    finishStop();
    await Promise.all([first, second]);

    expect(mocks.bridge.close).toHaveBeenCalledOnce();
  });

  it("aborts a pending agent consult when the FaceTime call closes", async () => {
    mocks.bridge.connect.mockResolvedValue();
    let finishConsult = (_result: { text: string }) => {};
    mocks.consult.mockImplementationOnce(
      () =>
        new Promise<{ text: string }>((resolve) => {
          finishConsult = resolve;
        }),
    );
    const driver = await startReadyFaceTimeTalkDriver();

    void mocks.sessionParams?.onToolCall({
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "Change my calendar." },
    });
    await vi.waitFor(() => expect(mocks.consult).toHaveBeenCalledOnce());
    const consultParams = mocks.consult.mock.calls[0]?.[0] as { abortSignal: AbortSignal };

    await driver.close("carrier-ended");

    expect(consultParams.abortSignal.aborted).toBe(true);
    finishConsult({ text: "Too late." });
    await Promise.resolve();
    expect(mocks.bridge.submitToolResult).not.toHaveBeenCalled();
  });

  it("rejects a late exact-run registration after the consult was closed", async () => {
    mocks.bridge.connect.mockResolvedValue();
    mocks.consult.mockImplementationOnce(() => new Promise<{ text: string }>(() => {}));
    const params = startParams();
    params.runtime.agent.session.getSessionEntry.mockReturnValue(undefined);
    const driver = await startReadyFaceTimeTalkDriver(params);

    void mocks.sessionParams?.onToolCall({
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "Change my calendar." },
    });
    await vi.waitFor(() => expect(mocks.consult).toHaveBeenCalledOnce());
    const consultParams = mocks.consult.mock.calls[0]?.[0] as {
      abortSignal: AbortSignal;
      onRunStarted(params: { runId: string; sessionId: string; timeoutMs: number }): {
        abortSignal: AbortSignal;
      };
    };
    await driver.close("carrier-ended");
    const registration = consultParams.onRunStarted({
      runId: "old-run",
      sessionId: "shared-session",
      timeoutMs: 1_000,
    });
    expect(consultParams.abortSignal.aborted).toBe(true);
    expect(registration.abortSignal.aborted).toBe(true);
  });

  it("never lets late cancellation of a superseded consult abort its successor", async () => {
    mocks.consult.mockImplementation(() => new Promise<{ text: string }>(() => {}));
    await startReadyFaceTimeTalkDriver();
    const runTool = (callId: string) =>
      void mocks.sessionParams?.onToolCall({
        itemId: `item-${callId}`,
        callId,
        name: "openclaw_agent_consult",
        args: { question: callId },
      });

    runTool("consult-a");
    await vi.waitFor(() => expect(mocks.consult).toHaveBeenCalledTimes(1));
    mocks.sessionParams?.onEvent({
      direction: "server",
      type: "input_audio_buffer.speech_started",
    });
    runTool("consult-b");
    await vi.waitFor(() => expect(mocks.consult).toHaveBeenCalledTimes(2));
    const first = mocks.consult.mock.calls[0]?.[0] as {
      abortSignal: AbortSignal;
      onRunStarted(params: { runId: string; sessionId: string; timeoutMs: number }): {
        abortSignal: AbortSignal;
      };
    };
    const second = mocks.consult.mock.calls[1]?.[0] as typeof first;
    const secondRun = second.onRunStarted({
      runId: "run-b",
      sessionId: "shared-session",
      timeoutMs: 1_000,
    });
    const lateFirstRun = first.onRunStarted({
      runId: "run-a",
      sessionId: "shared-session",
      timeoutMs: 1_000,
    });

    expect(first.abortSignal.aborted).toBe(true);
    expect(lateFirstRun.abortSignal.aborted).toBe(true);
    expect(second.abortSignal.aborted).toBe(false);
    expect(secondRun.abortSignal.aborted).toBe(false);
  });

  it("retires old consult and playback ownership on provider continuity reset", async () => {
    let finishConsult = (_result: { text: string }) => {};
    mocks.consult.mockImplementationOnce(
      () =>
        new Promise<{ text: string }>((resolve) => {
          finishConsult = resolve;
        }),
    );
    await startReadyFaceTimeTalkDriver();
    void mocks.sessionParams?.onToolCall({
      itemId: "item-reset",
      callId: "consult-reset",
      name: "openclaw_agent_consult",
      args: { question: "old" },
    });
    await vi.waitFor(() => expect(mocks.consult).toHaveBeenCalledOnce());
    const consultParams = mocks.consult.mock.calls[0]?.[0] as { abortSignal: AbortSignal };

    mocks.sessionParams?.onEvent({ direction: "server", type: "session.continuity.reset" });
    expect(consultParams.abortSignal.aborted).toBe(true);
    expect(mocks.pump.clearOutputAudio).toHaveBeenCalled();
    finishConsult({ text: "stale" });
    await Promise.resolve();
    expect(mocks.bridge.submitToolResult).not.toHaveBeenCalledWith(
      "consult-reset",
      expect.objectContaining({ text: "stale" }),
    );
  });

  it("silently closes a consult superseded by new caller speech", async () => {
    mocks.bridge.connect.mockResolvedValue();
    let finishConsult = (_result: { text: string }) => {};
    mocks.consult.mockImplementationOnce(
      () =>
        new Promise<{ text: string }>((resolve) => {
          finishConsult = resolve;
        }),
    );
    await startReadyFaceTimeTalkDriver();

    void mocks.sessionParams?.onToolCall({
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "Who am I?" },
    });
    await vi.waitFor(() => expect(mocks.consult).toHaveBeenCalledOnce());
    const consultParams = mocks.consult.mock.calls[0]?.[0] as { abortSignal: AbortSignal };
    mocks.sessionParams?.onEvent({
      direction: "server",
      type: "input_audio_buffer.speech_started",
    });

    await vi.waitFor(() =>
      expect(mocks.bridge.submitToolResult).toHaveBeenCalledWith(
        "call-1",
        {
          status: "cancelled",
          message: "The caller continued speaking before this consult completed.",
        },
        { suppressResponse: true },
      ),
    );
    expect(consultParams.abortSignal.aborted).toBe(true);
    finishConsult({ text: "You are Omar." });
    await Promise.resolve();
    expect(mocks.bridge.submitToolResult).toHaveBeenCalledTimes(1);
  });

  it("silently closes a failed consult superseded by new caller speech", async () => {
    mocks.bridge.connect.mockResolvedValue();
    let failConsult = (_error: Error) => {};
    mocks.consult.mockImplementationOnce(
      () =>
        new Promise<{ text: string }>((_resolve, reject) => {
          failConsult = reject;
        }),
    );
    await startReadyFaceTimeTalkDriver();

    void mocks.sessionParams?.onToolCall({
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "Who am I?" },
    });
    mocks.sessionParams?.onEvent({
      direction: "server",
      type: "input_audio_buffer.speech_started",
    });

    await vi.waitFor(() =>
      expect(mocks.bridge.submitToolResult).toHaveBeenCalledWith(
        "call-1",
        {
          status: "cancelled",
          message: "The caller continued speaking before this consult completed.",
        },
        { suppressResponse: true },
      ),
    );
    failConsult(new Error("agent unavailable"));
    await Promise.resolve();
    expect(mocks.bridge.submitToolResult).toHaveBeenCalledTimes(1);
  });

  it("uses an unsuppressed terminal cancellation when the provider requires it", async () => {
    mocks.bridge.connect.mockResolvedValue();
    (
      mocks.bridge.bridge as { supportsToolResultSuppression?: boolean }
    ).supportsToolResultSuppression = false;
    mocks.consult.mockImplementationOnce(() => new Promise<{ text: string }>(() => {}));
    await startReadyFaceTimeTalkDriver();

    void mocks.sessionParams?.onToolCall({
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "Who am I?" },
    });
    mocks.sessionParams?.onEvent({
      direction: "server",
      type: "input_audio_buffer.speech_started",
    });

    await vi.waitFor(() =>
      expect(mocks.bridge.submitToolResult).toHaveBeenCalledWith(
        "call-1",
        {
          status: "cancelled",
          message: "The caller continued speaking before this consult completed.",
        },
        undefined,
      ),
    );
  });

  it("closes safely when a terminal consult cancellation cannot be submitted", async () => {
    mocks.bridge.connect.mockResolvedValue();
    mocks.bridge.submitToolResult.mockRejectedValueOnce(new Error("submission failed"));
    mocks.consult.mockImplementationOnce(() => new Promise<{ text: string }>(() => {}));
    const onFailure = vi.fn(async () => true);
    await startReadyFaceTimeTalkDriver(startParams({ onFailure }));

    void mocks.sessionParams?.onToolCall({
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "Who am I?" },
    });
    mocks.sessionParams?.onEvent({
      direction: "server",
      type: "input_audio_buffer.speech_started",
    });

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith(new Error("submission failed")));
    expect(mocks.bridge.close).toHaveBeenCalledOnce();
  });

  it("routes the main session key to the configured default agent", async () => {
    mocks.bridge.connect.mockResolvedValue();
    mocks.consult.mockResolvedValueOnce({ text: "I know my SOUL.md." });
    await startReadyFaceTimeTalkDriver(
      startParams({
        fullConfig: {
          agents: { list: [{ id: "lobster", default: true }] },
        },
      }),
    );

    void mocks.sessionParams?.onToolCall({
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "Can you read SOUL.md?" },
    });

    await vi.waitFor(() =>
      expect(mocks.consult).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "lobster",
          sessionKey: "agent:lobster:facetime:call-1",
          spawnedBy: "agent:lobster:main",
          contextMode: "fork",
          senderId: "caller@example.com",
          senderIsOwner: true,
          messageProvider: "voice",
          lane: "facetime:call-1",
          extraSystemPrompt: expect.stringContaining(
            "configured owner/user described by this agent's workspace context",
          ),
        }),
      ),
    );
  });

  it("normalizes FaceTime UUID casing for one consult session and lane", async () => {
    mocks.bridge.connect.mockResolvedValue();
    mocks.consult.mockResolvedValueOnce({ text: "Done." });
    await startReadyFaceTimeTalkDriver(
      startParams({
        callUUID: "17BC43FD-5800-4B54-86DB-698C49253C42",
        fullConfig: {
          agents: { list: [{ id: "lobster", default: true }] },
        },
      }),
    );

    void mocks.sessionParams?.onToolCall({
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "Check my calendar." },
    });

    await vi.waitFor(() =>
      expect(mocks.consult).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:lobster:facetime:17bc43fd-5800-4b54-86db-698c49253c42",
          lane: "facetime:17bc43fd-5800-4b54-86db-698c49253c42",
          runIdPrefix: "facetime:17bc43fd-5800-4b54-86db-698c49253c42",
        }),
      ),
    );
  });

  it("combines custom instructions with workspace identity and agent proxy policy", async () => {
    mocks.bridge.connect.mockResolvedValue();
    mocks.resolveBootstrapContext.mockResolvedValue(
      "OpenClaw realtime voice profile context:\n\n### IDENTITY.md\nName: Tide",
    );
    await startReadyFaceTimeTalkDriver(
      startParams({
        config: resolveFaceTimeConfig({
          ownerHandles: ["caller@example.com"],
          realtime: { instructions: "Speak warmly and keep answers short." },
        }),
      }),
    );

    expect(mocks.sessionParams?.instructions).toContain("Speak warmly and keep answers short.");
    expect(mocks.sessionParams?.instructions).toContain("Name: Tide");
    expect(mocks.sessionParams?.instructions).toContain("same configured OpenClaw agent");
    expect(mocks.sessionParams?.instructions).toContain(
      "authenticated owner/user described by the loaded workspace profile context",
    );
    expect(mocks.sessionParams?.instructions).toContain("Consult behavior: always.");
    expect(mocks.sessionParams?.instructions).toContain("Never claim you retried");
    expect(mocks.sessionParams?.instructions).not.toContain("Lobster");
    expect(mocks.sessionParams?.instructions).not.toContain("Omar");
  });
});
