import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeLogger } from "../plugins/runtime/types.js";
import { createSpeechThresholdGate, readPcm16AudioStats } from "../talk/audio-energy.js";
import { terminateMeetingBridgeProcess } from "./bridge-process.js";
import { createMeetingOutputLoopbackVerifier } from "./output-loopback-verifier.js";
import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";

const LOCAL_BRIDGE_TERMINATION_GRACE_MS = 1_000;

type BridgeProcess = {
  pid?: number;
  killed?: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdin?: Writable | null;
  stdout?: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
  } | null;
  stderr?: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
  } | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  off(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
};

type MeetingRealtimeAudioSpawn = (
  command: string,
  args: string[],
  options: { stdio: ["pipe" | "ignore", "pipe" | "ignore", "pipe" | "ignore"] },
) => BridgeProcess;

function splitCommand(argv: string[]): { command: string; args: string[] } {
  const [command, ...args] = argv;
  if (!command) {
    throw new Error("audio bridge command must not be empty");
  }
  return { command, args };
}

export function createLocalMeetingRealtimeAudioTransport(params: {
  inputCommand: string[];
  outputCommand: string[];
  bargeInInputCommand?: string[];
  bargeInRmsThreshold: number;
  bargeInPeakThreshold: number;
  bargeInCooldownMs: number;
  logger: RuntimeLogger;
  logScope: string;
  audioFormat?: MeetingRealtimeAudioFormat;
  spawn?: MeetingRealtimeAudioSpawn;
}): MeetingRealtimeAudioTransport {
  const input = splitCommand(params.inputCommand);
  const output = splitCommand(params.outputCommand);
  const spawnFn: MeetingRealtimeAudioSpawn =
    params.spawn ??
    ((command, args, options) => spawn(command, args, options) as unknown as BridgeProcess);
  const spawnOutputProcess = () =>
    spawnFn(output.command, output.args, { stdio: ["pipe", "ignore", "pipe"] });
  let outputProcess = spawnOutputProcess();
  const inputProcess = spawnFn(input.command, input.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bargeInInputProcess: BridgeProcess | undefined;
  let stopped = false;
  let inputStarted = false;
  let fatalSignaled = false;
  let fatalHandler: (() => void) | undefined;
  let stopPromise: Promise<void> | undefined;
  const retiredOutputStops = new Set<Promise<void>>();
  const outputLoopbackVerifier = createMeetingOutputLoopbackVerifier({
    audioFormat: params.audioFormat ?? "pcm16-24khz",
  });

  const signalFatal = () => {
    if (!fatalSignaled) {
      fatalSignaled = true;
      fatalHandler?.();
    }
  };
  const fail = (label: string) => (error: Error) => {
    params.logger.warn(`${params.logScope} ${label} failed: ${formatErrorMessage(error)}`);
    signalFatal();
  };
  const attachOutputProcessHandlers = (proc: BridgeProcess) => {
    proc.on("error", (error) => {
      if (proc === outputProcess) {
        fail("audio output command")(error);
      }
    });
    proc.stdin?.on?.("error", (error: Error) => {
      if (proc === outputProcess) {
        fail("audio output command")(error);
      }
    });
    proc.on("exit", (code, signal) => {
      if (proc === outputProcess && !stopped) {
        params.logger.warn(
          `${params.logScope} audio output command exited (${code ?? signal ?? "done"})`,
        );
        signalFatal();
      }
    });
    proc.stderr?.on("data", (chunk) => {
      params.logger.debug?.(`${params.logScope} audio output: ${String(chunk).trim()}`);
    });
    proc.stderr?.on("error", (error: Error) => {
      if (proc === outputProcess) {
        fail("audio output command stderr")(error);
      }
    });
  };
  attachOutputProcessHandlers(outputProcess);
  inputProcess.on("error", fail("audio input command"));
  inputProcess.on("exit", (code, signal) => {
    if (!stopped) {
      params.logger.warn(
        `${params.logScope} audio input command exited (${code ?? signal ?? "done"})`,
      );
      signalFatal();
    }
  });
  inputProcess.stderr?.on("data", (chunk) => {
    params.logger.debug?.(`${params.logScope} audio input: ${String(chunk).trim()}`);
  });
  inputProcess.stdout?.on("error", fail("audio input command stdout"));
  inputProcess.stderr?.on("error", fail("audio input command stderr"));

  const transport: MeetingRealtimeAudioTransport = {
    onFatal: (handler) => {
      fatalHandler = handler;
      if (fatalSignaled) {
        handler();
      }
    },
    startInput: (onAudio) => {
      if (inputStarted) {
        throw new Error("audio input transport already started");
      }
      inputStarted = true;
      inputProcess.stdout?.on("data", (chunk) => {
        if (!stopped) {
          const audio = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          outputLoopbackVerifier.recordInput(audio);
          onAudio(audio);
        }
      });
    },
    beginOutput: () => outputLoopbackVerifier.beginOutput(),
    stop: () => {
      stopPromise ??= (async () => {
        stopped = true;
        await Promise.all([
          terminateMeetingBridgeProcess(inputProcess, {
            graceMs: LOCAL_BRIDGE_TERMINATION_GRACE_MS,
          }),
          terminateMeetingBridgeProcess(outputProcess, {
            graceMs: LOCAL_BRIDGE_TERMINATION_GRACE_MS,
          }),
          terminateMeetingBridgeProcess(bargeInInputProcess, {
            graceMs: LOCAL_BRIDGE_TERMINATION_GRACE_MS,
          }),
          ...retiredOutputStops,
        ]);
      })();
      return stopPromise;
    },
    writeOutput: async (audio) => {
      if (stopped) {
        return;
      }
      outputLoopbackVerifier.recordOutput(audio);
      try {
        outputProcess.stdin?.write(audio);
      } catch (error) {
        fail("audio output command")(error as Error);
      }
    },
    clearOutput: async () => {
      if (stopped) {
        return;
      }
      outputLoopbackVerifier.cancelOutput();
      const previousOutput = outputProcess;
      outputProcess = spawnOutputProcess();
      attachOutputProcessHandlers(outputProcess);
      params.logger.debug?.(
        `${params.logScope} cleared realtime audio output buffer by restarting playback command`,
      );
      const retiredOutputStop = terminateMeetingBridgeProcess(previousOutput, {
        graceMs: LOCAL_BRIDGE_TERMINATION_GRACE_MS,
        initialSignal: "SIGKILL",
      });
      retiredOutputStops.add(retiredOutputStop);
      void retiredOutputStop.finally(() => {
        retiredOutputStops.delete(retiredOutputStop);
      });
    },
    dispose: async () => {
      await transport.stop();
    },
    getHealth: () => outputLoopbackVerifier.getHealth(),
  };

  if (!params.bargeInInputCommand) {
    return transport;
  }

  return {
    ...transport,
    startBargeInMonitor: (onBargeIn) => {
      if (bargeInInputProcess || stopped) {
        return;
      }
      const command = splitCommand(params.bargeInInputCommand ?? []);
      const bargeInGate = createSpeechThresholdGate({
        rmsThreshold: params.bargeInRmsThreshold,
        peakThreshold: params.bargeInPeakThreshold,
        cooldownMs: params.bargeInCooldownMs,
      });
      bargeInInputProcess = spawnFn(command.command, command.args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      bargeInInputProcess.stdout?.on("data", (chunk) => {
        const audio = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (stopped) {
          return;
        }
        const stats = readPcm16AudioStats(audio);
        if (!bargeInGate.accept(stats, { nowMs: Date.now(), onTrigger: () => onBargeIn(audio) })) {
          return;
        }
        params.logger.debug?.(
          `${params.logScope} human barge-in detected by local input (rms=${Math.round(
            stats.rms,
          )}, peak=${stats.peak})`,
        );
      });
      bargeInInputProcess.stdout?.on("error", (error: Error) => {
        params.logger.warn(
          `${params.logScope} human barge-in input stdout failed: ${formatErrorMessage(error)}`,
        );
      });
      bargeInInputProcess.stderr?.on("data", (chunk) => {
        params.logger.debug?.(`${params.logScope} barge-in input: ${String(chunk).trim()}`);
      });
      bargeInInputProcess.stderr?.on("error", (error: Error) => {
        params.logger.warn(
          `${params.logScope} human barge-in input stderr failed: ${formatErrorMessage(error)}`,
        );
      });
      bargeInInputProcess.on("error", (error) => {
        params.logger.warn(
          `${params.logScope} human barge-in input failed: ${formatErrorMessage(error)}`,
        );
      });
      bargeInInputProcess.on("exit", (code, signal) => {
        if (!stopped) {
          params.logger.debug?.(
            `${params.logScope} human barge-in input exited (${code ?? signal ?? "done"})`,
          );
        }
      });
    },
  };
}
