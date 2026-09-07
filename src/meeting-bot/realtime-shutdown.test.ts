import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
} from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { createMeetingRealtimeEngineBindings } from "./agent-consult.js";
import { startMeetingAgentRealtimeEngine } from "./realtime-agent-engine.js";
import * as audioFormat from "./realtime-audio-format.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";
import {
  MEETING_AGENT_TRANSCRIPT_DEBOUNCE_MS,
  startMeetingRealtimeEngine,
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
