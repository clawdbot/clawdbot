import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createRealtimeVoiceBridgeSession,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resolveConfiguredRealtimeVoiceProvider,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  consultOpenClawAgentForGoogleMeet,
  GOOGLE_MEET_AGENT_CONSULT_TOOL_NAME,
  resolveGoogleMeetRealtimeTools,
  submitGoogleMeetConsultWorkingResponse,
} from "./agent-consult.js";
import type { GoogleMeetConfig } from "./config.js";
import type { GoogleMeetChromeHealth } from "./transports/types.js";

type BridgeProcess = {
  pid?: number;
  killed?: boolean;
  stdin?: Writable | null;
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: ["pipe" | "ignore", "pipe" | "ignore", "pipe" | "ignore"] },
) => BridgeProcess;

export type ChromeRealtimeAudioBridgeHandle = {
  providerId: string;
  inputCommand: string[];
  outputCommand: string[];
  speak: (instructions?: string) => void;
  getHealth: () => GoogleMeetChromeHealth;
  stop: () => Promise<void>;
};

type ResolvedRealtimeProvider = {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
};

function splitCommand(argv: string[]): { command: string; args: string[] } {
  const [command, ...args] = argv;
  if (!command) {
    throw new Error("audio bridge command must not be empty");
  }
  return { command, args };
}

function readPcm16Stats(audio: Buffer): { rms: number; peak: number } {
  let sumSquares = 0;
  let peak = 0;
  let samples = 0;
  for (let offset = 0; offset + 1 < audio.byteLength; offset += 2) {
    const sample = audio.readInt16LE(offset);
    const abs = Math.abs(sample);
    peak = Math.max(peak, abs);
    sumSquares += sample * sample;
    samples += 1;
  }
  return {
    rms: samples > 0 ? Math.sqrt(sumSquares / samples) : 0,
    peak,
  };
}

export function resolveGoogleMeetRealtimeAudioFormat(config: GoogleMeetConfig) {
  return config.chrome.audioFormat === "g711-ulaw-8khz"
    ? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ
    : REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ;
}

export function resolveGoogleMeetRealtimeProvider(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  providers?: RealtimeVoiceProviderPlugin[];
}): ResolvedRealtimeProvider {
  return resolveConfiguredRealtimeVoiceProvider({
    configuredProviderId: params.config.realtime.provider,
    providerConfigs: params.config.realtime.providers,
    cfg: params.fullConfig,
    providers: params.providers,
    defaultModel: params.config.realtime.model,
    noRegisteredProviderMessage: "No configured realtime voice provider registered",
  });
}

export async function startCommandRealtimeAudioBridge(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  meetingSessionId: string;
  inputCommand: string[];
  outputCommand: string[];
  logger: RuntimeLogger;
  providers?: RealtimeVoiceProviderPlugin[];
  spawn?: SpawnFn;
}): Promise<ChromeRealtimeAudioBridgeHandle> {
  const input = splitCommand(params.inputCommand);
  const output = splitCommand(params.outputCommand);
  const spawnFn: SpawnFn =
    params.spawn ??
    ((command, args, options) => spawn(command, args, options) as unknown as BridgeProcess);
  const spawnOutputProcess = () =>
    spawnFn(output.command, output.args, {
      stdio: ["pipe", "ignore", "pipe"],
    });
  let outputProcess = spawnOutputProcess();
  const inputProcess = spawnFn(input.command, input.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stopped = false;
  let bridge: RealtimeVoiceBridgeSession | null = null;
  let realtimeReady = false;
  let lastInputAt: string | undefined;
  let lastOutputAt: string | undefined;
  let lastInputBytes = 0;
  let lastOutputBytes = 0;
  let lastClearAt: string | undefined;
  let clearCount = 0;
  let suppressedInputBytes = 0;
  let lastSuppressedInputAt: string | undefined;
  let suppressInputUntil = 0;
  let lastOutputAtMs = 0;
  let lastOutputPlayableUntilMs = 0;
  let bargeInInputProcess: BridgeProcess | undefined;

  const suppressInputForOutput = (audio: Buffer) => {
    const bytesPerMs = params.config.chrome.audioFormat === "g711-ulaw-8khz" ? 8 : 48;
    const durationMs = Math.ceil(audio.byteLength / bytesPerMs);
    const until = Date.now() + durationMs + 900;
    suppressInputUntil = Math.max(suppressInputUntil, until);
    lastOutputPlayableUntilMs = Math.max(lastOutputPlayableUntilMs, until);
  };

  const terminateProcess = (proc: BridgeProcess, signal: NodeJS.Signals = "SIGTERM") => {
    if (proc.killed && signal !== "SIGKILL") {
      return;
    }
    let exited = false;
    proc.on("exit", () => {
      exited = true;
    });
    try {
      proc.kill(signal);
    } catch {
      return;
    }
    if (signal === "SIGKILL") {
      return;
    }
    const timer = setTimeout(() => {
      if (!exited) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Process may have exited after the grace check.
        }
      }
    }, 1000);
    timer.unref?.();
  };

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    try {
      bridge?.close();
    } catch (error) {
      params.logger.debug?.(
        `[google-meet] realtime voice bridge close ignored: ${formatErrorMessage(error)}`,
      );
    }
    terminateProcess(inputProcess);
    terminateProcess(outputProcess);
    if (bargeInInputProcess) {
      terminateProcess(bargeInInputProcess);
    }
  };

  const fail = (label: string) => (error: Error) => {
    params.logger.warn(`[google-meet] ${label} failed: ${formatErrorMessage(error)}`);
    void stop();
  };
  const attachOutputProcessHandlers = (proc: BridgeProcess) => {
    proc.on("error", (error) => {
      if (proc !== outputProcess) {
        return;
      }
      fail("audio output command")(error);
    });
    proc.on("exit", (code, signal) => {
      if (proc !== outputProcess) {
        return;
      }
      if (!stopped) {
        params.logger.warn(
          `[google-meet] audio output command exited (${code ?? signal ?? "done"})`,
        );
        void stop();
      }
    });
    proc.stderr?.on("data", (chunk) => {
      params.logger.debug?.(`[google-meet] audio output: ${String(chunk).trim()}`);
    });
  };
  const clearOutputPlayback = () => {
    if (stopped) {
      return;
    }
    const previousOutput = outputProcess;
    outputProcess = spawnOutputProcess();
    attachOutputProcessHandlers(outputProcess);
    clearCount += 1;
    lastClearAt = new Date().toISOString();
    suppressInputUntil = 0;
    lastOutputPlayableUntilMs = 0;
    params.logger.debug?.(
      `[google-meet] cleared realtime audio output buffer by restarting playback command`,
    );
    terminateProcess(previousOutput, "SIGKILL");
  };
  const startHumanBargeInMonitor = () => {
    const commandArgv = params.config.chrome.bargeInInputCommand;
    if (!commandArgv) {
      return;
    }
    const command = splitCommand(commandArgv);
    let lastBargeInAt = 0;
    bargeInInputProcess = spawnFn(command.command, command.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    bargeInInputProcess.stdout?.on("data", (chunk) => {
      if (stopped || lastOutputAtMs === 0) {
        return;
      }
      const now = Date.now();
      const playbackActive = now <= Math.max(lastOutputPlayableUntilMs, suppressInputUntil);
      if (!playbackActive && now - lastOutputAtMs > 1000) {
        return;
      }
      if (now - lastBargeInAt < params.config.chrome.bargeInCooldownMs) {
        return;
      }
      const audio = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const stats = readPcm16Stats(audio);
      if (
        stats.rms < params.config.chrome.bargeInRmsThreshold &&
        stats.peak < params.config.chrome.bargeInPeakThreshold
      ) {
        return;
      }
      lastBargeInAt = now;
      suppressInputUntil = 0;
      const beforeClearCount = clearCount;
      bridge?.handleBargeIn({ audioPlaybackActive: true });
      if (beforeClearCount === clearCount) {
        clearOutputPlayback();
      }
      params.logger.debug?.(
        `[google-meet] human barge-in detected by local input (rms=${Math.round(
          stats.rms,
        )}, peak=${stats.peak})`,
      );
    });
    bargeInInputProcess.stderr?.on("data", (chunk) => {
      params.logger.debug?.(`[google-meet] barge-in input: ${String(chunk).trim()}`);
    });
    bargeInInputProcess.on("error", (error) => {
      params.logger.warn(`[google-meet] human barge-in input failed: ${formatErrorMessage(error)}`);
    });
    bargeInInputProcess.on("exit", (code, signal) => {
      if (!stopped) {
        params.logger.debug?.(
          `[google-meet] human barge-in input exited (${code ?? signal ?? "done"})`,
        );
      }
    });
  };
  inputProcess.on("error", fail("audio input command"));
  inputProcess.on("exit", (code, signal) => {
    if (!stopped) {
      params.logger.warn(`[google-meet] audio input command exited (${code ?? signal ?? "done"})`);
      void stop();
    }
  });
  attachOutputProcessHandlers(outputProcess);
  inputProcess.stderr?.on("data", (chunk) => {
    params.logger.debug?.(`[google-meet] audio input: ${String(chunk).trim()}`);
  });

  const resolved = resolveGoogleMeetRealtimeProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  const transcript: Array<{ role: "user" | "assistant"; text: string }> = [];
  bridge = createRealtimeVoiceBridgeSession({
    provider: resolved.provider,
    providerConfig: resolved.providerConfig,
    audioFormat: resolveGoogleMeetRealtimeAudioFormat(params.config),
    instructions: params.config.realtime.instructions,
    initialGreetingInstructions: params.config.realtime.introMessage,
    triggerGreetingOnReady: false,
    markStrategy: "ack-immediately",
    tools: resolveGoogleMeetRealtimeTools(params.config.realtime.toolPolicy),
    audioSink: {
      isOpen: () => !stopped,
      sendAudio: (audio) => {
        lastOutputAtMs = Date.now();
        lastOutputAt = new Date().toISOString();
        lastOutputBytes += audio.byteLength;
        suppressInputForOutput(audio);
        outputProcess.stdin?.write(audio);
      },
      clearAudio: clearOutputPlayback,
    },
    onTranscript: (role, text, isFinal) => {
      if (isFinal) {
        transcript.push({ role, text });
        if (transcript.length > 40) {
          transcript.splice(0, transcript.length - 40);
        }
        params.logger.debug?.(`[google-meet] ${role}: ${text}`);
      }
    },
    onToolCall: (event, session) => {
      if (event.name !== GOOGLE_MEET_AGENT_CONSULT_TOOL_NAME) {
        session.submitToolResult(event.callId || event.itemId, {
          error: `Tool "${event.name}" not available`,
        });
        return;
      }
      submitGoogleMeetConsultWorkingResponse(session, event.callId || event.itemId);
      void consultOpenClawAgentForGoogleMeet({
        config: params.config,
        fullConfig: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        meetingSessionId: params.meetingSessionId,
        args: event.args,
        transcript,
      })
        .then((result) => {
          session.submitToolResult(event.callId || event.itemId, result);
        })
        .catch((error: Error) => {
          session.submitToolResult(event.callId || event.itemId, {
            error: formatErrorMessage(error),
          });
        });
    },
    onError: fail("realtime voice bridge"),
    onClose: (reason) => {
      realtimeReady = false;
      if (reason === "error") {
        void stop();
      }
    },
    onReady: () => {
      realtimeReady = true;
    },
  });
  startHumanBargeInMonitor();

  inputProcess.stdout?.on("data", (chunk) => {
    const audio = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!stopped && audio.byteLength > 0) {
      if (Date.now() < suppressInputUntil) {
        lastSuppressedInputAt = new Date().toISOString();
        suppressedInputBytes += audio.byteLength;
        return;
      }
      lastInputAt = new Date().toISOString();
      lastInputBytes += audio.byteLength;
      bridge?.sendAudio(Buffer.from(audio));
    }
  });

  await bridge.connect();
  return {
    providerId: resolved.provider.id,
    inputCommand: params.inputCommand,
    outputCommand: params.outputCommand,
    speak: (instructions) => {
      bridge?.triggerGreeting(instructions);
    },
    getHealth: () => ({
      providerConnected: bridge?.bridge.isConnected() ?? false,
      realtimeReady,
      audioInputActive: lastInputBytes > 0,
      audioOutputActive: lastOutputBytes > 0,
      lastInputAt,
      lastOutputAt,
      lastSuppressedInputAt,
      lastInputBytes,
      lastOutputBytes,
      suppressedInputBytes,
      lastClearAt,
      clearCount,
      bridgeClosed: stopped,
    }),
    stop,
  };
}
