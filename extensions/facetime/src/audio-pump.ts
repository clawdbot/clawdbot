import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Writable } from "node:stream";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type PumpProcess = {
  pid?: number;
  killed?: boolean;
  stdin?: (Writable & { writableLength?: number }) | null;
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
  options: {
    env: NodeJS.ProcessEnv;
    stdio: ["pipe" | "ignore", "pipe" | "ignore", "pipe" | "ignore"];
  },
) => PumpProcess;

const CAFFEINATE_COMMAND = "/usr/bin/caffeinate";
const FRAME_AUDIO = 1;
const FRAME_DRAIN = 2;
const FRAME_CLEAR = 3;
const FRAME_CLOSE_SAFE = 4;
export const FACETIME_FEED_DEVICE_NAME = "OpenClaw-Feed";
export const FACETIME_MIC_DEVICE_NAME = "OpenClaw-Mic";
const MAX_PLAYBACK_BUFFERED_BYTES = 2 * 1024 * 1024;

type PlaybackControlEvent =
  | { event: "played"; generation: number; frames: number }
  | { event: "drained"; generation: number; frames: number }
  | { event: "overflow"; message: string };

function parsePlaybackControlEvent(value: unknown): PlaybackControlEvent | undefined {
  const record = asRecord(value);
  if (record.event === "overflow" && typeof record.message === "string") {
    return { event: "overflow", message: record.message };
  }
  if (
    (record.event === "played" || record.event === "drained") &&
    typeof record.generation === "number" &&
    typeof record.frames === "number"
  ) {
    return { event: record.event, generation: record.generation, frames: record.frames };
  }
  return undefined;
}

type FaceTimeAudioPump = {
  suppressionReady(): Promise<void>;
  routeReady(): Promise<void>;
  processOutputSuppressed(): boolean;
  writeOutputAudio(audio: Buffer): void;
  finishOutputAudio(): void;
  clearOutputAudio(): void;
  playedAudioFrames(): number;
  queuedAudioFrames(): number;
  suspendMedia(): Promise<void>;
  failClosed(): Promise<void>;
  stop(): Promise<void>;
};

function sanitizedAudioChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !/(?:API_?KEY|AUTH|CREDENTIAL|PASSWORD|SECRET|TOKEN)/iu.test(key),
    ),
  );
}

function encodeFrame(type: number, payload: Uint8Array = new Uint8Array()): Buffer {
  const frame = Buffer.allocUnsafe(5 + payload.byteLength);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(payload.byteLength, 1);
  frame.set(payload, 5);
  return frame;
}

function encodeGenerationFrame(type: number, generation: number): Buffer {
  const payload = Buffer.allocUnsafe(4);
  payload.writeUInt32BE(generation, 0);
  return encodeFrame(type, payload);
}

async function terminateProcess(proc: PumpProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (proc.killed && signal !== "SIGKILL") {
    return;
  }
  let exited = false;
  const exitedPromise = new Promise<void>((resolve) => {
    proc.on("exit", () => {
      exited = true;
      resolve();
    });
  });
  try {
    proc.kill(signal);
  } catch {
    return;
  }
  await Promise.race([
    exitedPromise,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      timer.unref?.();
    }),
  ]);
  if (!exited && signal !== "SIGKILL") {
    try {
      proc.kill("SIGKILL");
    } catch {
      return;
    }
    await Promise.race([
      exitedPromise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        timer.unref?.();
      }),
    ]);
  }
}

export function startFaceTimeAudioPump(params: {
  captureBinary: string;
  logger: RuntimeLogger;
  onInputAudio: (audio: Buffer) => void;
  onError?: (error: Error) => boolean | void | Promise<boolean | void>;
  onSuppressionLost?: (error: Error) => void | Promise<void>;
  onPlaybackDrained?: (event: { generation: number; playedFrames: number }) => void;
  spawn?: SpawnFn;
}): FaceTimeAudioPump {
  const spawnFn: SpawnFn =
    params.spawn ?? ((command, args, options) => spawn(command, args, options));
  const childEnv = sanitizedAudioChildEnv();
  const captureProcess = spawnFn(params.captureBinary, [], {
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stopped = false;
  let mediaSuspended = false;
  let captureSuppressionActive = false;
  let captureFailureReported = false;
  let playbackGeneration = 1;
  let generatedFrames = 0;
  let playedFrames = 0;
  let captureReadySettled = false;
  let routeReadySettled = false;
  let routeReadyTimer: NodeJS.Timeout | undefined;
  let captureStderr = "";
  let resolveCaptureReady = () => {};
  let rejectCaptureReady = (_error: Error) => {};
  const captureReadyPromise = new Promise<void>((resolve, reject) => {
    resolveCaptureReady = resolve;
    rejectCaptureReady = reject;
  });
  let resolveRouteReady = () => {};
  let rejectRouteReady = (_error: Error) => {};
  const routeReadyPromise = new Promise<void>((resolve, reject) => {
    resolveRouteReady = resolve;
    rejectRouteReady = reject;
  });
  void captureReadyPromise.catch(() => {});
  void routeReadyPromise.catch(() => {});

  const settleCaptureReady = (error?: Error) => {
    if (captureReadySettled) {
      return;
    }
    captureReadySettled = true;
    clearTimeout(captureReadyTimer);
    if (error) {
      rejectCaptureReady(error);
    } else {
      resolveCaptureReady();
    }
  };
  const settleRouteReady = (error?: Error) => {
    if (routeReadySettled) {
      return;
    }
    routeReadySettled = true;
    if (routeReadyTimer) {
      clearTimeout(routeReadyTimer);
      routeReadyTimer = undefined;
    }
    if (error) {
      rejectRouteReady(error);
    } else {
      resolveRouteReady();
    }
  };
  const reportFailure = (error: Error, suppressionLost: boolean) => {
    if (stopped) {
      return;
    }
    if (suppressionLost) {
      captureSuppressionActive = false;
      void params.onSuppressionLost?.(error);
    }
    settleCaptureReady(error);
    settleRouteReady(error);
    params.logger.warn(`[facetime] native audio bridge failed: ${formatErrorMessage(error)}`);
    void Promise.resolve(params.onError?.(error)).then((safeToStop) => {
      if (safeToStop !== false) {
        void stop();
      }
    });
  };
  const captureReadyTimer = setTimeout(() => {
    reportFailure(new Error("FaceTime process tap was not ready within 10 seconds"), true);
  }, 10_000);
  captureReadyTimer.unref?.();
  const startRouteReadyTimer = () => {
    if (routeReadySettled || routeReadyTimer) {
      return;
    }
    routeReadyTimer = setTimeout(() => {
      reportFailure(new Error("FaceTime input route was not verified within 15 seconds"), true);
    }, 15_000);
    routeReadyTimer.unref?.();
  };

  const sendFrame = (frame: Buffer) => {
    if (stopped || !captureProcess.stdin) {
      return;
    }
    captureProcess.stdin.write(frame);
  };
  const clearPlayback = () => {
    playbackGeneration += 1;
    generatedFrames = 0;
    playedFrames = 0;
    sendFrame(encodeGenerationFrame(FRAME_CLEAR, playbackGeneration));
  };
  const stop = async () => {
    if (stopped) {
      return;
    }
    mediaSuspended = true;
    captureSuppressionActive = false;
    settleCaptureReady(new Error("FaceTime native audio bridge stopped before readiness"));
    settleRouteReady(new Error("FaceTime input route stopped before verification"));
    try {
      sendFrame(encodeGenerationFrame(FRAME_CLOSE_SAFE, playbackGeneration));
      captureProcess.stdin?.end();
    } catch {
      // Process exit below remains joined.
    }
    stopped = true;
    await Promise.all([
      terminateProcess(captureProcess),
      wakeProcess ? terminateProcess(wakeProcess) : Promise.resolve(),
    ]);
  };
  const failClosed = async () => {
    if (stopped) {
      return;
    }
    mediaSuspended = true;
    stopped = true;
    try {
      // No close-safe frame: EOF is the native watchdog's fail-closed signal.
      captureProcess.stdin?.end();
    } catch {
      // The process may already be handling EOF.
    }
    let exited = false;
    const exitedPromise = new Promise<void>((resolve) => {
      captureProcess.on("exit", () => {
        exited = true;
        resolve();
      });
    });
    await Promise.race([
      exitedPromise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_500);
        timer.unref?.();
      }),
    ]);
    if (!exited) {
      await terminateProcess(captureProcess);
    }
    if (wakeProcess) {
      await terminateProcess(wakeProcess);
    }
    captureSuppressionActive = false;
  };

  const wakeProcess = existsSync(CAFFEINATE_COMMAND)
    ? spawnFn(
        CAFFEINATE_COMMAND,
        ["-d", "-i", ...(captureProcess.pid ? ["-w", String(captureProcess.pid)] : [])],
        { env: childEnv, stdio: ["ignore", "ignore", "pipe"] },
      )
    : undefined;
  wakeProcess?.on("error", () => undefined);
  captureProcess.on("error", (error) => reportFailure(error, true));
  captureProcess.stdin?.on("error", (error) => reportFailure(error, false));
  captureProcess.on("exit", (code, signal) => {
    if (!stopped) {
      reportFailure(new Error(`native audio bridge exited (${code ?? signal ?? "done"})`), true);
    }
  });
  captureProcess.stderr?.on("data", (chunk) => {
    const message = String(chunk);
    captureStderr = `${captureStderr}${message}`.slice(-8192);
    for (const line of captureStderr.split(/\r?\n/u).slice(0, -1)) {
      if (line.startsWith("facetime-control:")) {
        try {
          const parsed: unknown = JSON.parse(line.slice("facetime-control:".length));
          const event = parsePlaybackControlEvent(parsed);
          if (!event) {
            throw new Error("invalid control event shape");
          }
          if (event.event === "overflow") {
            reportFailure(new Error(event.message), false);
          } else if (event.generation !== playbackGeneration) {
            continue;
          } else if (event.event === "played") {
            playedFrames = Math.max(playedFrames, event.frames);
          } else if (event.event === "drained") {
            playedFrames = Math.max(playedFrames, event.frames);
            params.onPlaybackDrained?.({ generation: event.generation, playedFrames });
          }
        } catch (error) {
          reportFailure(
            new Error(`invalid native audio control event: ${formatErrorMessage(error)}`),
            false,
          );
        }
      }
      if (line.includes("started FaceTime process tap")) {
        captureSuppressionActive = true;
        settleCaptureReady();
      }
      if (line.includes("verified OpenClaw-Mic input route")) {
        settleRouteReady();
      }
      if (
        !captureFailureReported &&
        /facetime-audio-capture: fatal(?:-safety-retained)?:/u.test(line)
      ) {
        captureFailureReported = true;
        reportFailure(new Error("native FaceTime safety monitor reported a fatal error"), false);
      }
    }
    captureStderr = captureStderr.split(/\r?\n/u).at(-1) ?? "";
  });
  captureProcess.stdout?.on("data", (chunk) => {
    if (!stopped && !mediaSuspended) {
      const audio = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (audio.byteLength > 0) {
        params.onInputAudio(audio);
      }
    }
  });

  return {
    suppressionReady: async () => await captureReadyPromise,
    routeReady: async () => {
      startRouteReadyTimer();
      await routeReadyPromise;
    },
    processOutputSuppressed: () => captureSuppressionActive,
    writeOutputAudio(audio) {
      if (stopped || mediaSuspended || audio.byteLength === 0) {
        return;
      }
      const bufferedBytes = captureProcess.stdin?.writableLength ?? 0;
      if (bufferedBytes + audio.byteLength > MAX_PLAYBACK_BUFFERED_BYTES) {
        reportFailure(new Error("native playback queue exceeded 2 MiB"), false);
        return;
      }
      generatedFrames += audio.byteLength / 2;
      sendFrame(encodeFrame(FRAME_AUDIO, audio));
    },
    finishOutputAudio() {
      if (!stopped && !mediaSuspended) {
        sendFrame(encodeGenerationFrame(FRAME_DRAIN, playbackGeneration));
      }
    },
    clearOutputAudio: clearPlayback,
    playedAudioFrames: () => playedFrames,
    queuedAudioFrames: () => Math.max(0, generatedFrames - playedFrames),
    async suspendMedia() {
      if (!stopped && !mediaSuspended) {
        mediaSuspended = true;
        clearPlayback();
      }
    },
    failClosed,
    stop,
  };
}
