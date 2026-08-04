// Google Meet realtime tests cover real local command-pair substitute processes.
import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createLocalMeetingRealtimeAudioTransport,
  startMeetingAgentRealtimeEngine,
  startMeetingRealtimeEngine,
  type MeetingRealtimeAudioTransport,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "./config.js";

const tempDirs: string[] = [];
const spawnedChildren: ChildProcess[] = [];

type MeetRealtimeAudioSpawn = NonNullable<
  Parameters<typeof createLocalMeetingRealtimeAudioTransport>[0]["spawn"]
>;

const GOOGLE_MEET_ENGINE_BINDINGS = {
  platform: {
    displayName: "Google Meet",
    logScope: "[google-meet]",
    sessionIdPrefix: "google-meet",
  },
  consultAgent: async () => ({ text: "" }),
  tools: [],
  handleToolCall: async () => {},
};

function writeBridgeCommand(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-bridge-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, "bridge-command.mjs");
  writeFileSync(
    scriptPath,
    [
      "process.on('SIGTERM', () => {",
      "  process.exit(0);",
      "});",
      "process.stdin.resume();",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return scriptPath;
}

function writeSigtermResistantBridgeCommand(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-resistant-bridge-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, "bridge-command.mjs");
  writeFileSync(
    scriptPath,
    [
      "process.on('SIGTERM', () => {",
      "  process.stderr.write('sigterm\\n');",
      "});",
      "process.stdin.resume();",
      "setTimeout(() => process.stderr.write(`ready:${process.argv[2]}\\n`), 50);",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return scriptPath;
}

function makeRecordingSpawn(): MeetRealtimeAudioSpawn {
  return (command, args, options) => {
    const child = spawnChildProcess(command, args, options);
    spawnedChildren.push(child);
    return child as ReturnType<MeetRealtimeAudioSpawn>;
  };
}

afterEach(() => {
  for (const child of spawnedChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
  vi.restoreAllMocks();
});

describe("local Meet realtime transport process stream errors", () => {
  it("disposes transport when transcription session creation throws", async () => {
    const initError = new Error("transcription session creation failed");
    const provider: RealtimeTranscriptionProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      defaultModel: "gpt-4o-transcribe",
      autoSelectOrder: 1,
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => true,
      createSession: () => {
        throw initError;
      },
    };
    const startInput = vi.fn();
    const stop = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const transport: MeetingRealtimeAudioTransport = {
      onFatal: vi.fn(),
      startInput,
      stop,
      writeOutput: vi.fn(async () => {}),
      clearOutput: vi.fn(async () => {}),
      dispose,
    };

    await expect(
      startMeetingAgentRealtimeEngine({
        config: resolveGoogleMeetConfig({
          chrome: { audioFormat: "pcm16-24khz" },
          realtime: { provider: "openai", agentId: "jay", introMessage: "" },
        }),
        fullConfig: {} as never,
        runtime: {} as never,
        ...GOOGLE_MEET_ENGINE_BINDINGS,
        meetingSessionId: "meet-create-session-failure",
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        providers: [provider],
        transport,
      }),
    ).rejects.toBe(initError);

    expect(startInput).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("closes the STT session and disposes transport when input startup throws", async () => {
    const initError = new Error("input startup failed");
    const sttSession = {
      connect: vi.fn(async () => {}),
      sendAudio: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => false),
    };
    const provider: RealtimeTranscriptionProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      defaultModel: "gpt-4o-transcribe",
      autoSelectOrder: 1,
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => true,
      createSession: () => sttSession,
    };
    const startInput = vi.fn(() => {
      throw initError;
    });
    const stop = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const transport: MeetingRealtimeAudioTransport = {
      onFatal: vi.fn(),
      startInput,
      stop,
      writeOutput: vi.fn(async () => {}),
      clearOutput: vi.fn(async () => {}),
      dispose,
    };

    await expect(
      startMeetingAgentRealtimeEngine({
        config: resolveGoogleMeetConfig({
          chrome: { audioFormat: "pcm16-24khz" },
          realtime: { provider: "openai", agentId: "jay", introMessage: "" },
        }),
        fullConfig: {} as never,
        runtime: {} as never,
        ...GOOGLE_MEET_ENGINE_BINDINGS,
        meetingSessionId: "meet-input-start-failure",
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        providers: [provider],
        transport,
      }),
    ).rejects.toBe(initError);

    expect(sttSession.connect).not.toHaveBeenCalled();
    expect(sttSession.close).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("closes the STT session and disposes transport when connect rejects", async () => {
    const connectError = new Error("transcription connect failed");
    const sttSession = {
      connect: vi.fn(async () => {
        throw connectError;
      }),
      sendAudio: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => false),
    };
    const provider: RealtimeTranscriptionProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      defaultModel: "gpt-4o-transcribe",
      autoSelectOrder: 1,
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => true,
      createSession: () => sttSession,
    };
    const stop = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const transport: MeetingRealtimeAudioTransport = {
      onFatal: vi.fn(),
      startInput: vi.fn(),
      stop,
      writeOutput: vi.fn(async () => {}),
      clearOutput: vi.fn(async () => {}),
      dispose,
    };

    await expect(
      startMeetingAgentRealtimeEngine({
        config: resolveGoogleMeetConfig({
          chrome: { audioFormat: "pcm16-24khz" },
          realtime: { provider: "openai", agentId: "jay", introMessage: "" },
        }),
        fullConfig: {} as never,
        runtime: {} as never,
        ...GOOGLE_MEET_ENGINE_BINDINGS,
        meetingSessionId: "meet-connect-failure",
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        providers: [provider],
        transport,
      }),
    ).rejects.toBe(connectError);

    expect(sttSession.close).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("stops the engine when input fails during provider setup", async () => {
    const bridgeScript = writeBridgeCommand();
    let finishConnect = () => {};
    const connectGate = new Promise<void>((resolve) => {
      finishConnect = resolve;
    });
    const sttSession = {
      connect: vi.fn(() => connectGate),
      sendAudio: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => false),
    };
    const provider: RealtimeTranscriptionProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      defaultModel: "gpt-4o-transcribe",
      autoSelectOrder: 1,
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => true,
      createSession: () => sttSession,
    };
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const transport = createLocalMeetingRealtimeAudioTransport({
      inputCommand: [path.join(path.dirname(bridgeScript), "missing-capture")],
      outputCommand: [process.execPath, bridgeScript, "play"],
      bargeInRmsThreshold: 10,
      bargeInPeakThreshold: 10,
      bargeInCooldownMs: 1,
      logger,
      logScope: "[google-meet]",
      spawn: makeRecordingSpawn(),
    });
    const config = resolveGoogleMeetConfig({
      chrome: { audioFormat: "pcm16-24khz" },
      realtime: { provider: "openai", agentId: "jay", introMessage: "" },
    });
    const engineResult = startMeetingAgentRealtimeEngine({
      config,
      fullConfig: {} as never,
      runtime: {} as never,
      ...GOOGLE_MEET_ENGINE_BINDINGS,
      meetingSessionId: "meet-startup-failure",
      logger,
      providers: [provider],
      transport,
    }).then(
      () => new Error("Expected Google Meet engine startup to fail"),
      (error: unknown) => error,
    );
    const inputProcess = spawnedChildren[1];
    if (!inputProcess) {
      throw new Error("Expected Google Meet transport to spawn an input child process");
    }

    await once(inputProcess, "error");
    await vi.waitFor(() => {
      expect(sttSession.close).toHaveBeenCalledTimes(1);
    });
    finishConnect();

    await expect(engineResult).resolves.toEqual(
      new Error("Google Meet audio transport stopped during transcription provider setup"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("[google-meet] audio input command failed:"),
    );
    await transport.dispose();
  });

  it("contains a forced local command-pair stdout stream error through bridge stop", async () => {
    const bridgeScript = writeBridgeCommand();
    const sttSession = {
      connect: vi.fn(async () => {}),
      sendAudio: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeTranscriptionProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      defaultModel: "gpt-4o-transcribe",
      autoSelectOrder: 1,
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => true,
      createSession: () => sttSession,
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    const config = resolveGoogleMeetConfig({
      chrome: { audioFormat: "pcm16-24khz" },
      realtime: { provider: "openai", agentId: "jay", introMessage: "" },
    });
    const transport = createLocalMeetingRealtimeAudioTransport({
      inputCommand: [process.execPath, bridgeScript, "capture"],
      outputCommand: [process.execPath, bridgeScript, "play"],
      bargeInRmsThreshold: config.chrome.bargeInRmsThreshold,
      bargeInPeakThreshold: config.chrome.bargeInPeakThreshold,
      bargeInCooldownMs: config.chrome.bargeInCooldownMs,
      logger: logger as never,
      logScope: "[google-meet]",
      spawn: makeRecordingSpawn(),
    });
    const handle = await startMeetingAgentRealtimeEngine({
      config,
      fullConfig: {} as never,
      runtime: {} as never,
      ...GOOGLE_MEET_ENGINE_BINDINGS,
      meetingSessionId: "meet-1",
      logger: logger as never,
      providers: [provider],
      transport,
    });
    const [outputProcess, inputProcess] = spawnedChildren;
    if (!inputProcess || !outputProcess) {
      throw new Error("Expected Google Meet bridge to spawn input and output child processes");
    }
    const inputClosed = once(inputProcess, "close");
    const outputClosed = once(outputProcess, "close");
    const originalInputKill = inputProcess.kill.bind(inputProcess);
    const originalOutputKill = outputProcess.kill.bind(outputProcess);
    const inputKillSpy = vi
      .spyOn(inputProcess, "kill")
      .mockImplementation((signal) => originalInputKill(signal));
    const outputKillSpy = vi
      .spyOn(outputProcess, "kill")
      .mockImplementation((signal) => originalOutputKill(signal));

    inputProcess.stdout?.destroy(new Error("EPIPE from real bridge input stdout"));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    inputProcess.stderr?.destroy(new Error("duplicate stderr EPIPE"));

    await Promise.all([inputClosed, outputClosed]);
    expect(logger.warn).toHaveBeenCalledWith(
      "[google-meet] audio input command stdout failed: EPIPE from real bridge input stdout",
    );
    expect(handle.getHealth().bridgeClosed).toBe(true);
    expect(sttSession.close).toHaveBeenCalledTimes(1);
    expect(inputKillSpy.mock.calls.filter(([signal]) => signal === "SIGTERM")).toHaveLength(1);
    expect(outputKillSpy.mock.calls.filter(([signal]) => signal === "SIGTERM")).toHaveLength(1);
    console.info(
      `[proof] local command-pair substitute stopped after forced input stdout stream error; inputPid=${
        inputProcess.pid ?? "unknown"
      } outputPid=${outputProcess.pid ?? "unknown"}`,
    );
  });

  it.skipIf(process.platform === "win32")(
    "waits for SIGTERM-resistant bridge processes and shares the stop promise",
    async () => {
      const bridgeScript = writeSigtermResistantBridgeCommand();
      const transport = createLocalMeetingRealtimeAudioTransport({
        inputCommand: [process.execPath, bridgeScript, "capture"],
        outputCommand: [process.execPath, bridgeScript, "play"],
        bargeInRmsThreshold: 10,
        bargeInPeakThreshold: 10,
        bargeInCooldownMs: 1,
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        logScope: "[google-meet]",
        spawn: makeRecordingSpawn(),
      });
      const [outputProcess, inputProcess] = spawnedChildren;
      if (!inputProcess || !outputProcess || !inputProcess.stderr || !outputProcess.stderr) {
        throw new Error("Expected Google Meet bridge to spawn stderr-backed child processes");
      }
      await Promise.all([once(inputProcess.stderr, "data"), once(outputProcess.stderr, "data")]);
      const originalInputKill = inputProcess.kill.bind(inputProcess);
      const originalOutputKill = outputProcess.kill.bind(outputProcess);
      const inputKillSpy = vi
        .spyOn(inputProcess, "kill")
        .mockImplementation((signal) => originalInputKill(signal));
      const outputKillSpy = vi
        .spyOn(outputProcess, "kill")
        .mockImplementation((signal) => originalOutputKill(signal));

      const startedAt = Date.now();
      const firstStop = transport.stop();
      const secondStop = transport.stop();

      expect(secondStop).toBe(firstStop);
      await firstStop;
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(900);
      expect(elapsedMs).toBeLessThan(5_000);
      expect(inputKillSpy.mock.calls.filter(([signal]) => signal === "SIGTERM")).toHaveLength(1);
      expect(inputKillSpy.mock.calls.filter(([signal]) => signal === "SIGKILL")).toHaveLength(1);
      expect(outputKillSpy.mock.calls.filter(([signal]) => signal === "SIGTERM")).toHaveLength(1);
      expect(outputKillSpy.mock.calls.filter(([signal]) => signal === "SIGKILL")).toHaveLength(1);
    },
  );
});

describe("Google Meet bidi realtime engine cleanup", () => {
  it("disposes the audio transport when provider connection fails", async () => {
    const connectError = new Error("voice bridge connect failed");
    const stopError = new Error("transport stop failed");
    const bridge = {
      connect: vi.fn(async () => {
        throw connectError;
      }),
      sendAudio: vi.fn(),
      sendUserMessage: vi.fn(),
      setMediaTimestamp: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      triggerGreeting: vi.fn(),
      isConnected: vi.fn(() => false),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      isConfigured: () => true,
      createBridge: () => bridge,
    };
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(stopError)
      .mockResolvedValueOnce();
    const dispose = vi.fn(async () => {});
    const transport: MeetingRealtimeAudioTransport = {
      onFatal: vi.fn(),
      startInput: vi.fn(),
      stop,
      writeOutput: vi.fn(async () => {}),
      clearOutput: vi.fn(async () => {}),
      dispose,
    };

    await expect(
      startMeetingRealtimeEngine({
        config: resolveGoogleMeetConfig({ realtime: { strategy: "bidi", provider: "openai" } }),
        fullConfig: {} as never,
        runtime: {} as never,
        ...GOOGLE_MEET_ENGINE_BINDINGS,
        meetingSessionId: "meet-connect-failure",
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        providers: [provider],
        transport,
      }),
    ).rejects.toBe(connectError);

    expect(bridge.close).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("stops the audio transport when the provider bridge closes unexpectedly", async () => {
    let closeBridge: ((reason: "completed" | "error") => void) | undefined;
    const bridge = {
      connect: vi.fn(async () => {}),
      sendAudio: vi.fn(),
      sendUserMessage: vi.fn(),
      setMediaTimestamp: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      triggerGreeting: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      isConfigured: () => true,
      createBridge: (params) => {
        closeBridge = params.onClose;
        return bridge;
      },
    };
    const stop = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const transport: MeetingRealtimeAudioTransport = {
      onFatal: vi.fn(),
      startInput: vi.fn(),
      stop,
      writeOutput: vi.fn(async () => {}),
      clearOutput: vi.fn(async () => {}),
      dispose,
    };
    const handle = await startMeetingRealtimeEngine({
      config: resolveGoogleMeetConfig({ realtime: { strategy: "bidi", provider: "openai" } }),
      fullConfig: {} as never,
      runtime: {} as never,
      ...GOOGLE_MEET_ENGINE_BINDINGS,
      meetingSessionId: "meet-unexpected-close",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      providers: [provider],
      transport,
    });

    closeBridge?.("completed");
    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
    });
    expect(handle.getHealth().bridgeClosed).toBe(true);
  });

  it("retries only the unsettled transport teardown phase", async () => {
    const stopError = new Error("transport stop failed");
    let closeBridge: ((reason: "completed" | "error") => void) | undefined;
    const bridge = {
      connect: vi.fn(async () => {}),
      sendAudio: vi.fn(),
      sendUserMessage: vi.fn(),
      setMediaTimestamp: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(() => closeBridge?.("completed")),
      triggerGreeting: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      isConfigured: () => true,
      createBridge: (params) => {
        closeBridge = params.onClose;
        return bridge;
      },
    };
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(stopError)
      .mockResolvedValueOnce();
    const dispose = vi.fn(async () => {});
    const transport: MeetingRealtimeAudioTransport = {
      onFatal: vi.fn(),
      startInput: vi.fn(),
      stop,
      writeOutput: vi.fn(async () => {}),
      clearOutput: vi.fn(async () => {}),
      dispose,
    };
    const handle = await startMeetingRealtimeEngine({
      config: resolveGoogleMeetConfig({ realtime: { strategy: "bidi", provider: "openai" } }),
      fullConfig: {} as never,
      runtime: {} as never,
      ...GOOGLE_MEET_ENGINE_BINDINGS,
      meetingSessionId: "meet-stop-retry",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      providers: [provider],
      transport,
    });

    await expect(handle.stop()).rejects.toBe(stopError);
    await expect(handle.stop()).resolves.toBeUndefined();

    expect(stop).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();
    expect(bridge.close).toHaveBeenCalledOnce();
  });
});

describe("Google Meet realtime model logs", () => {
  it("keeps a whole code point when a provider id crosses the log boundary", async () => {
    const prefix = "a".repeat(179);
    const providerId = `${prefix}😀tail`;
    const bridge = {
      connect: vi.fn(async () => {}),
      sendAudio: vi.fn(),
      sendUserMessage: vi.fn(),
      setMediaTimestamp: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      triggerGreeting: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: providerId,
      label: "Long identifier provider",
      isConfigured: () => true,
      createBridge: () => bridge,
    };
    const transport: MeetingRealtimeAudioTransport = {
      onFatal: vi.fn(),
      startInput: vi.fn(),
      stop: vi.fn(async () => {}),
      writeOutput: vi.fn(async () => {}),
      clearOutput: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const handle = await startMeetingRealtimeEngine({
      config: resolveGoogleMeetConfig({
        realtime: { strategy: "native", provider: providerId },
      }),
      fullConfig: {} as never,
      runtime: {} as never,
      ...GOOGLE_MEET_ENGINE_BINDINGS,
      meetingSessionId: "long-provider-log",
      logger,
      providers: [provider],
      transport,
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(`provider=${prefix} model=provider-default`),
    );
    await handle.stop();
  });
});
