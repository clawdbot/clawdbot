import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  createPluginRegistryResourceOwner,
  drainPluginRegistryResourceDisposals,
  registerPluginRegistryResourceDisposer,
} from "../plugins/registry-resources.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
} from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "../talk/provider-types.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { createMeetingRealtimeEngineBindings } from "./agent-consult.js";
import { startMeetingAgentRealtimeEngine } from "./realtime-agent-engine.js";
import * as audioFormat from "./realtime-audio-format.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";
import {
  MEETING_AGENT_TRANSCRIPT_DEBOUNCE_MS,
  startMeetingRealtimeEngine,
  type MeetingRealtimeAudioEngineHandle,
  type MeetingRealtimeToolCallParams,
} from "./realtime-engine.js";

const environment = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
let stateDir: string;
const spokenResult = {
  success: true,
  audioBuffer: Buffer.from([1, 0, 2, 0]),
  sampleRate: 24_000,
  outputFormat: "pcm16",
};

async function createFixture(engine: "transcription" | "voice" = "transcription") {
  const sessionKey = "agent:main:subagent:test-meeting:meeting-1";
  let entry: SessionEntry = { sessionId: "synthetic-consult", updatedAt: 1 };
  const runEmbeddedAgent = vi.fn(async (_params: RunEmbeddedAgentParams) => ({
    payloads: [{ text: "The synthetic answer." }],
    meta: {},
  }));
  const textToSpeechTelephony = vi.fn(async () => spokenResult);
  const runtime = {
    agent: {
      resolveAgentDir: () => path.join(stateDir, "agent"),
      resolveAgentWorkspaceDir: () => path.join(stateDir, "workspace"),
      ensureAgentWorkspace: async () => {},
      resolveAgentTimeoutMs: () => 30_000,
      session: {
        resolveStorePath: () => path.join(stateDir, "sessions.json"),
        getSessionEntry: ({ sessionKey: key }: { sessionKey: string }) =>
          key === sessionKey ? entry : undefined,
        patchSessionEntry: async ({
          update,
        }: {
          update: (current: SessionEntry) => Promise<Partial<SessionEntry>>;
        }) => {
          entry = { ...entry, ...(await update(entry)) };
          return entry;
        },
      },
      runEmbeddedAgent,
    },
    tts: { textToSpeechTelephony },
  } as unknown as PluginRuntime;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const config = {
    chrome: { audioFormat: "pcm16-24khz" as const },
    realtime: { strategy: "agent", provider: "test", providers: { test: {} } },
  };
  const bindings = createMeetingRealtimeEngineBindings({
    platform: {
      id: "test-meeting",
      displayName: "Test Meeting",
      logScope: "[test-meeting]",
      agentConsult: {
        surface: "a synthetic meeting",
        userLabel: "Participant",
        assistantLabel: "Agent",
        questionSourceLabel: "participant",
        workingResponseLabel: "participant",
        extraSystemPrompt: "Answer briefly.",
      },
      session: { idPrefix: "test_meeting", participantIdentity: () => "Test participant" },
    },
    config: { realtime: { toolPolicy: "safe-read-only" } },
    fullConfig: {},
    runtime,
    logger,
  });
  let fatal = () => {};
  let transcript = (_text: string) => {};
  const disposed = createDeferredCore();
  const writeOutput = vi.fn(async (_audio: Buffer) => {});
  const sendUserMessage = vi.fn();
  const transport: MeetingRealtimeAudioTransport = {
    onFatal: (handler) => {
      fatal = handler;
    },
    startInput: vi.fn(),
    beginOutput: vi.fn(),
    stop: vi.fn(async () => {}),
    dispose: vi.fn(async () => {
      disposed.resolve();
    }),
    clearOutput: vi.fn(async () => {}),
    writeOutput,
  };
  const common = {
    config,
    fullConfig: {},
    runtime,
    ...bindings,
    meetingSessionId: "meeting-1",
    // A different requester agent naturally uses the existing isolated consult branch.
    requesterSessionKey: "agent:requester:main",
    logger,
    transport,
  };
  let handle;
  if (engine === "transcription") {
    const provider: RealtimeTranscriptionProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createSession: (request) => {
        transcript = (text) => request.onTranscript?.(text);
        return { connect: async () => {}, sendAudio() {}, close() {}, isConnected: () => true };
      },
    };
    handle = await startMeetingAgentRealtimeEngine({ ...common, providers: [provider] });
  } else {
    const provider: RealtimeVoiceProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: (request) => {
        transcript = (text) => request.onTranscript?.("user", text, true);
        return {
          connect: async () => {
            request.onReady?.();
          },
          sendAudio() {},
          setMediaTimestamp() {},
          submitToolResult() {},
          acknowledgeMark() {},
          close() {},
          isConnected: () => true,
          sendUserMessage,
        };
      },
    };
    handle = await startMeetingRealtimeEngine({ ...common, providers: [provider] });
  }
  return {
    handle,
    runtime,
    runEmbeddedAgent,
    textToSpeechTelephony,
    writeOutput,
    sendUserMessage,
    logger,
    transcript: (text: string) => transcript(text),
    stop: async (kind: "stop" | "fatal") => {
      if (kind === "fatal") {
        fatal();
        await disposed.promise;
        await setImmediate();
      } else {
        await handle.stop();
      }
    },
    eventTypes: () => handle.getHealth().recentTalkEvents.map((event) => event.type),
  };
}

describe("meeting shutdown", () => {
  beforeEach(async () => {
    stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "meeting-shutdown-")));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, "{}\n");
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    environment.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it.each(["transcription", "voice"] as const)(
    "delivers a completed %s consult once",
    async (engine) => {
      const fixture = await createFixture(engine);
      const delivered = createDeferredCore();
      fixture.textToSpeechTelephony.mockImplementation(async () => {
        delivered.resolve();
        return spokenResult;
      });
      fixture.sendUserMessage.mockImplementation(() => {
        delivered.resolve();
      });
      try {
        fixture.transcript("Please answer this meeting question.");
        await vi.advanceTimersByTimeAsync(MEETING_AGENT_TRANSCRIPT_DEBOUNCE_MS);
        await delivered.promise;
        await setImmediate();
        expect(fixture.runEmbeddedAgent).toHaveBeenCalledOnce();
        const run = fixture.runEmbeddedAgent.mock.calls[0]?.[0];
        expect(run?.abortSignal?.aborted).toBe(false);
        expect(
          engine === "transcription" ? fixture.textToSpeechTelephony : fixture.sendUserMessage,
        ).toHaveBeenCalledOnce();
        await fixture.handle.stop();
        expect(run?.abortSignal?.aborted).toBe(false);
      } finally {
        await fixture.handle.stop();
      }
    },
  );

  it("closes an idle engine once without opening a turn", async () => {
    const fixture = await createFixture();
    await fixture.handle.stop();
    await fixture.handle.stop();
    expect(fixture.eventTypes()).toEqual(["session.started", "session.ready", "session.closed"]);
  });

  it.each([
    ["transcription", "stop"],
    ["transcription", "fatal"],
    ["voice", "stop"],
    ["voice", "fatal"],
  ] as const)("cancels the generic agent run from %s %s", async (engine, shutdown) => {
    const fixture = await createFixture(engine);
    const started = createDeferredCore<RunEmbeddedAgentParams>();
    const settled = createDeferredCore();
    const result = createDeferredCore<Awaited<ReturnType<typeof fixture.runEmbeddedAgent>>>();
    fixture.runEmbeddedAgent.mockImplementationOnce((params) => {
      const abort = () => {
        result.reject(params.abortSignal?.reason);
      };
      params.abortSignal?.addEventListener("abort", abort, { once: true });
      started.resolve(params);
      return result.promise.finally(() => {
        params.abortSignal?.removeEventListener("abort", abort);
        settled.resolve();
      });
    });
    try {
      fixture.transcript("Please check this for the meeting.");
      await vi.advanceTimersByTimeAsync(MEETING_AGENT_TRANSCRIPT_DEBOUNCE_MS);
      const run = await started.promise;
      const aborted = vi.fn();
      run.abortSignal?.addEventListener("abort", aborted, { once: true });
      expect(run.abortSignal?.aborted).toBe(false);
      await fixture.stop(shutdown);
      expect(run.abortSignal?.aborted).toBe(true);
      expect(aborted).toHaveBeenCalledOnce();
      await settled.promise;
      await setImmediate();
      expect(fixture.textToSpeechTelephony).not.toHaveBeenCalled();
      expect(fixture.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      result.resolve({ payloads: [], meta: {} });
      await fixture.handle.stop();
      await setImmediate();
    }
  });

  it.each([
    ["tts", "resolve", "stop"],
    ["tts", "reject", "stop"],
    ["tts", "resolve", "fatal"],
    ["tts", "reject", "fatal"],
    ["tts", "failed result", "stop"],
    ["tts", "failed result", "fatal"],
    ["sink", "resolve", "stop"],
    ["sink", "reject", "stop"],
    ["sink", "resolve", "fatal"],
    ["sink", "reject", "fatal"],
  ] as const)("seals %s spans before %s settles after %s", async (stage, settlement, shutdown) => {
    const fixture = await createFixture();
    const synthesis = createDeferredCore<typeof spokenResult>();
    const sink = createDeferredCore();
    const conversion = vi.spyOn(audioFormat, "convertMeetingTtsAudioForBridge");
    fixture.textToSpeechTelephony.mockReturnValueOnce(synthesis.promise);
    fixture.writeOutput.mockReturnValueOnce(sink.promise);
    try {
      fixture.handle.speak("A synthetic spoken answer.");
      await setImmediate();
      if (stage === "sink") {
        synthesis.resolve(spokenResult);
        await setImmediate();
        expect(fixture.writeOutput).toHaveBeenCalledOnce();
      }
      await fixture.stop(shutdown);
      const ended = fixture.eventTypes();
      expect
        .soft(ended.slice(stage === "sink" ? -3 : -2))
        .toEqual([
          ...(stage === "sink" ? ["output.audio.done"] : []),
          "turn.ended",
          "session.closed",
        ]);
      const conversions = conversion.mock.calls.length;
      const writes = fixture.writeOutput.mock.calls.length;
      const warnings = fixture.logger.warn.mock.calls.length;
      const pending = stage === "tts" ? synthesis : sink;
      if (settlement === "reject") {
        pending.reject(new Error("late failure"));
      } else if (settlement === "failed result") {
        synthesis.resolve({ ...spokenResult, success: false });
      } else if (stage === "tts") {
        synthesis.resolve(spokenResult);
      } else {
        sink.resolve();
      }
      await setImmediate();
      expect.soft(fixture.eventTypes()).toEqual(ended);
      expect.soft(conversion).toHaveBeenCalledTimes(conversions);
      expect.soft(fixture.writeOutput).toHaveBeenCalledTimes(writes);
      expect.soft(fixture.logger.warn).toHaveBeenCalledTimes(warnings);
    } finally {
      synthesis.resolve(spokenResult);
      sink.resolve();
      await fixture.handle.stop();
      await setImmediate();
    }
  });

  it.each(["success", "tts failure", "sink failure"] as const)(
    "preserves active speech completion for %s",
    async (outcome) => {
      const fixture = await createFixture();
      let eventsAtWarning: string[] | undefined;
      fixture.logger.warn.mockImplementation(() => {
        eventsAtWarning = fixture.eventTypes();
      });
      if (outcome === "tts failure") {
        fixture.textToSpeechTelephony.mockRejectedValueOnce(new Error("active synthesis failed"));
      } else if (outcome === "sink failure") {
        fixture.writeOutput.mockRejectedValueOnce(new Error("active sink failed"));
      }
      try {
        fixture.handle.speak("A synthetic answer.");
        await setImmediate();
        expect(fixture.eventTypes()).toEqual([
          "session.started",
          "session.ready",
          "turn.started",
          "output.text.done",
          ...(outcome === "tts failure"
            ? []
            : ["output.audio.started", "output.audio.delta", "output.audio.done"]),
          "turn.ended",
        ]);
        expect(fixture.logger.warn).toHaveBeenCalledTimes(outcome === "success" ? 0 : 1);
        if (outcome !== "success") {
          expect(eventsAtWarning).toEqual(fixture.eventTypes());
        }
        await fixture.handle.stop();
        expect(fixture.eventTypes().slice(-2)).toEqual(["turn.ended", "session.closed"]);
      } finally {
        await fixture.handle.stop();
      }
    },
  );
});

describe("Meeting native resource lifetime", () => {
  function createResourceFixture(
    kind: "voice" | "agent",
    connect: () => Promise<void> = async () => {},
    options: {
      createVoiceBridge?: (request: RealtimeVoiceBridgeCreateRequest) => RealtimeVoiceBridge;
      handleToolCall?: (params: MeetingRealtimeToolCallParams) => Promise<void>;
      onCleanupReady?: (stop: () => Promise<void>) => void | Promise<void>;
    } = {},
  ) {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE native_state (value TEXT); INSERT INTO native_state VALUES ('retained')");
    const registry = createEmptyPluginRegistry();
    const close = vi.fn(() => {});
    const createProvider = vi.fn();
    const disposeNative = vi.fn(() => db.close());
    const owner = createPluginRegistryResourceOwner(registry, "scoped");
    registerPluginRegistryResourceDisposer(registry, "meeting-native", {
      id: "meeting-native-db",
      dispose: disposeNative,
    });
    registry.realtimeVoiceProviders.push({
      pluginId: "meeting-native",
      source: "synthetic-native-fixture",
      provider: {
        id: "meeting-native",
        label: "Meeting native",
        isConfigured: () => true,
        createBridge: (request) => {
          createProvider();
          return options.createVoiceBridge
            ? options.createVoiceBridge(request)
            : {
                connect,
                close,
                sendAudio() {},
                setMediaTimestamp() {},
                acknowledgeMark() {},
                submitToolResult() {},
                isConnected: () => true,
              };
        },
      },
    });
    registry.realtimeTranscriptionProviders.push({
      pluginId: "meeting-native",
      source: "synthetic-native-fixture",
      provider: {
        id: "meeting-native",
        label: "Meeting native",
        isConfigured: () => true,
        createSession: () => {
          createProvider();
          return { connect, close, sendAudio() {}, isConnected: () => true };
        },
      },
    });
    let onFatal: (() => void) | undefined;
    const stop = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const transport: MeetingRealtimeAudioTransport = {
      stop,
      dispose,
      onFatal(handler) {
        onFatal = handler;
      },
      startInput() {},
      async writeOutput() {},
      async clearOutput() {},
    };
    const params = {
      config: {
        chrome: { audioFormat: "pcm16-24khz" as const },
        realtime: {
          strategy: "bidi",
          provider: "meeting-native",
          providers: { "meeting-native": {} },
        },
      },
      fullConfig: {},
      runtime: createPluginRuntime(),
      platform: {
        displayName: "Meeting fixture",
        logScope: "meeting-fixture",
        sessionIdPrefix: "meeting-fixture",
      },
      meetingSessionId: "meeting-native",
      transport,
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      consultAgent: async () => ({ text: "unused" }),
      onCleanupReady: options.onCleanupReady,
    };
    return {
      db,
      owner,
      close,
      createProvider,
      disposeNative,
      stop,
      dispose,
      fatal() {
        onFatal?.();
      },
      start: () =>
        withPluginRuntimeRegistryScope(registry, () =>
          kind === "agent"
            ? startMeetingAgentRealtimeEngine(params)
            : startMeetingRealtimeEngine({
                ...params,
                tools: [],
                handleToolCall: options.handleToolCall ?? (async () => {}),
              }),
        ),
    };
  }

  it.each(["voice", "agent"] as const)(
    "awaits %s cleanup ownership before constructing the provider",
    async (kind) => {
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      let cleanup: (() => Promise<void>) | undefined;
      const fixture = createResourceFixture(kind, undefined, {
        onCleanupReady: async (stop) => {
          cleanup = stop;
          entered.resolve();
          await finish.promise;
        },
      });
      const starting = fixture.start();
      try {
        await entered.promise;
        fixture.owner.release();
        expect(fixture.createProvider).not.toHaveBeenCalled();
        expect(fixture.db.isOpen).toBe(true);
        finish.resolve();
        const handle = await starting;
        expect(handle.stop).toBe(cleanup);
        expect(fixture.createProvider).toHaveBeenCalledOnce();
        await handle.stop();
        await drainPluginRegistryResourceDisposals();
        expect(fixture.db.isOpen).toBe(false);
      } finally {
        finish.resolve();
        await starting.catch(() => {});
        await cleanup?.().catch(() => {});
        fixture.owner.release();
        await drainPluginRegistryResourceDisposals();
        if (fixture.db.isOpen) {
          fixture.db.close();
        }
      }
    },
  );

  it.each(["voice", "agent"] as const)(
    "does not construct a %s provider when cleanup registration stops the engine",
    async (kind) => {
      const fixture = createResourceFixture(kind, undefined, { onCleanupReady: (stop) => stop() });
      try {
        const starting = fixture.start();
        fixture.owner.release();
        await expect(starting).rejects.toThrow("stopped before");
        expect(fixture.createProvider).not.toHaveBeenCalled();
        await drainPluginRegistryResourceDisposals();
        expect(fixture.db.isOpen).toBe(false);
      } finally {
        fixture.owner.release();
        await drainPluginRegistryResourceDisposals();
        if (fixture.db.isOpen) {
          fixture.db.close();
        }
      }
    },
  );

  it.each(["voice", "agent"] as const)(
    "retains %s failed-start native resources until the error cleanup owner succeeds",
    async (kind) => {
      const startupError = new Error("provider connect failed");
      const cleanupError = new Error("provider close failed");
      const fixture = createResourceFixture(kind, async () => {
        throw startupError;
      });
      let allowClose = false;
      let cleanup: Pick<MeetingRealtimeAudioEngineHandle, "stop"> | undefined;
      fixture.close.mockImplementation(() => {
        expect(fixture.db.prepare("SELECT value FROM native_state").get()?.value).toBe("retained");
        if (!allowClose) {
          throw cleanupError;
        }
      });

      try {
        const starting = fixture.start();
        fixture.owner.release();
        const failure: Error & {
          cleanup?: Pick<MeetingRealtimeAudioEngineHandle, "stop">;
          cleanupError?: unknown;
        } = await starting.then(
          () => {
            throw new Error("Provider startup unexpectedly succeeded");
          },
          (error: unknown) => {
            if (!(error instanceof Error)) {
              throw error;
            }
            return error;
          },
        );
        cleanup = failure.cleanup;
        await drainPluginRegistryResourceDisposals();
        expect(fixture.db.isOpen).toBe(true);
        expect(fixture.disposeNative).not.toHaveBeenCalled();
        expect(fixture.close).toHaveBeenCalledTimes(kind === "voice" ? 2 : 1);
        expect(failure.name).toBe("MeetingRealtimeStartupCleanupError");
        expect(failure.cause).toBe(startupError);
        expect(failure.cleanupError).toBe(cleanupError);
        expect(cleanup).toEqual({ stop: expect.any(Function) });
        if (!cleanup) {
          throw new Error("Failed startup did not expose its cleanup owner");
        }

        allowClose = true;
        await cleanup.stop();
        await drainPluginRegistryResourceDisposals();
        expect(fixture.db.isOpen).toBe(false);
        expect(fixture.disposeNative).toHaveBeenCalledOnce();
        await cleanup.stop();
        expect(fixture.disposeNative).toHaveBeenCalledOnce();
      } finally {
        allowClose = true;
        await cleanup?.stop().catch(() => {});
        fixture.owner.release();
        await drainPluginRegistryResourceDisposals();
        if (fixture.db.isOpen) {
          fixture.db.close();
        }
      }
    },
  );

  it.each(["voice", "agent"] as const)(
    "preserves the original %s startup error when rollback succeeds",
    async (kind) => {
      const startupError = new Error("provider connect failed");
      const fixture = createResourceFixture(kind, async () => {
        throw startupError;
      });
      try {
        const starting = fixture.start();
        fixture.owner.release();
        await expect(starting).rejects.toBe(startupError);
        await drainPluginRegistryResourceDisposals();
        expect(fixture.db.isOpen).toBe(false);
        expect(fixture.close).toHaveBeenCalledOnce();
        expect(fixture.disposeNative).toHaveBeenCalledOnce();
      } finally {
        fixture.owner.release();
        await drainPluginRegistryResourceDisposals();
        if (fixture.db.isOpen) {
          fixture.db.close();
        }
      }
    },
  );

  it.each([
    { kind: "voice", failure: "close" },
    { kind: "voice", failure: "stop" },
    { kind: "voice", failure: "dispose" },
    { kind: "agent", failure: "stop" },
    { kind: "agent", failure: "dispose" },
    { kind: "agent", failure: "close" },
  ] as const)(
    "retains $kind native resources after rejected $failure until cleanup retry succeeds",
    async ({ kind, failure }) => {
      const fixture = createResourceFixture(kind);
      let handle: MeetingRealtimeAudioEngineHandle | undefined;
      try {
        handle = await fixture.start();
        fixture.owner.release();
        if (failure === "close") {
          fixture.close.mockImplementationOnce(() => {
            throw new Error("cleanup failed");
          });
        } else {
          fixture[failure].mockRejectedValueOnce(new Error("cleanup failed"));
        }
        await expect(handle.stop()).rejects.toThrow("cleanup failed");
        expect(fixture.db.prepare("SELECT value FROM native_state").get()?.value).toBe("retained");
        await expect(handle.stop()).resolves.toBeUndefined();
        if (failure === "close") {
          expect(fixture.close).toHaveBeenCalledTimes(2);
        }
        await drainPluginRegistryResourceDisposals();
        expect(fixture.db.isOpen).toBe(false);
      } finally {
        await handle?.stop().catch(() => {});
        fixture.owner.release();
        await drainPluginRegistryResourceDisposals();
        if (fixture.db.isOpen) {
          fixture.db.close();
        }
      }
    },
  );

  it.each(["voice", "agent"] as const)(
    "keeps %s native resources through connect finishing after fatal cleanup",
    async (kind) => {
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      const fixture = createResourceFixture(kind, async () => {
        entered.resolve();
        await finish.promise;
        expect(fixture.db.prepare("SELECT value FROM native_state").get()?.value).toBe("retained");
      });

      const starting = fixture.start();
      const startResult = starting.catch((error: unknown) => error);
      try {
        await entered.promise;
        fixture.owner.release();
        fixture.fatal();
        await vi.waitFor(() => expect(fixture.dispose).toHaveBeenCalledOnce());
        expect(fixture.db.isOpen).toBe(true);
        finish.resolve();
        await expect(startResult).resolves.toMatchObject({
          message: expect.stringMatching(/stopped during/),
        });
        await drainPluginRegistryResourceDisposals();
        expect(fixture.db.isOpen).toBe(false);
      } finally {
        finish.resolve();
        await startResult;
        fixture.owner.release();
        await drainPluginRegistryResourceDisposals();
        if (fixture.db.isOpen) {
          fixture.db.close();
        }
      }
    },
  );

  it("retains an accepted provider submission after startup and transport cleanup reject", async () => {
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    const submitted = createDeferredCore<unknown>();
    const submissionResult = submitted.promise.catch((error: unknown) => error);
    let cleanup: (() => Promise<void>) | undefined;
    const fixture = createResourceFixture("voice", undefined, {
      onCleanupReady: (stop) => {
        cleanup = stop;
      },
      createVoiceBridge: (request) => ({
        connect: async () => {
          request.onToolCall?.({ itemId: "item", callId: "call", name: "synthetic", args: {} });
          await entered.promise;
          throw new Error("connect failed");
        },
        close() {},
        sendAudio() {},
        setMediaTimestamp() {},
        acknowledgeMark() {},
        isConnected: () => true,
        submitToolResult: async () => {
          entered.resolve();
          await finish.promise;
          try {
            submitted.resolve(fixture.db.prepare("SELECT value FROM native_state").get()?.value);
          } catch (error) {
            submitted.reject(error);
            throw error;
          }
        },
      }),
      handleToolCall: async ({ session, event }) => {
        await session.submitToolResult(event.callId, { text: "accepted before close" });
      },
    });
    fixture.stop.mockRejectedValue(new Error("transport stop failed"));
    fixture.dispose.mockRejectedValue(new Error("transport dispose failed"));
    const starting = fixture.start();
    try {
      await entered.promise;
      fixture.owner.release();
      await expect(starting).rejects.toThrow("connect failed");
      expect(fixture.db.isOpen).toBe(true);
      finish.resolve();
      await expect(submissionResult).resolves.toBe("retained");
      fixture.stop.mockResolvedValue();
      fixture.dispose.mockResolvedValue();
      await cleanup?.();
      await drainPluginRegistryResourceDisposals();
      expect(fixture.db.isOpen).toBe(false);
    } finally {
      finish.resolve();
      await starting.catch(() => {});
      await submissionResult;
      fixture.stop.mockResolvedValue();
      fixture.dispose.mockResolvedValue();
      await cleanup?.().catch(() => {});
      fixture.owner.release();
      await drainPluginRegistryResourceDisposals();
      if (fixture.db.isOpen) {
        fixture.db.close();
      }
    }
  });
});
