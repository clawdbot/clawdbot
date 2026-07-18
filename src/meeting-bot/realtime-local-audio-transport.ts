import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeLogger } from "../plugins/runtime/types.js";
import { createSpeechThresholdGate, readPcm16AudioStats } from "../talk/audio-energy.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";

type BridgeProcess = {
  pid?: number;
  killed?: boolean;
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

function terminateBridgeProcess(proc: BridgeProcess, signal: NodeJS.Signals = "SIGTERM"): void {
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
        // The process may exit between the grace check and signal.
      }
    }
  }, 1_000);
  timer.unref?.();
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
          onAudio(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      });
    },
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      terminateBridgeProcess(inputProcess);
      terminateBridgeProcess(outputProcess);
      if (bargeInInputProcess) {
        terminateBridgeProcess(bargeInInputProcess);
      }
    },
    writeOutput: async (audio) => {
      if (stopped) {
        return;
      }
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
      const previousOutput = outputProcess;
      outputProcess = spawnOutputProcess();
      attachOutputProcessHandlers(outputProcess);
      params.logger.debug?.(
        `${params.logScope} cleared realtime audio output buffer by restarting playback command`,
      );
      terminateBridgeProcess(previousOutput, "SIGKILL");
    },
    dispose: async () => {
      await transport.stop();
    },
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
