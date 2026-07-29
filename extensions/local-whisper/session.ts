import type {
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCallbacks,
} from "openclaw/plugin-sdk/realtime-transcription";
import { mulaw8KhzToPcm16Khz } from "./audio.js";
import {
  spawnLocalWhisperWorker,
  type LocalWhisperWorker,
  type LocalWhisperWorkerFactory,
  type LocalWhisperWorkerOptions,
} from "./worker.js";

const CONNECT_TIMEOUT_MS = 120_000;
const CLOSE_TIMEOUT_MS = 5_000;

export type LocalWhisperSessionOptions = LocalWhisperWorkerOptions &
  RealtimeTranscriptionSessionCallbacks & {
    workerFactory?: LocalWhisperWorkerFactory;
    connectTimeoutMs?: number;
    closeTimeoutMs?: number;
  };

export function createLocalWhisperRealtimeTranscriptionSession(
  options: LocalWhisperSessionOptions,
): RealtimeTranscriptionSession {
  let worker: LocalWhisperWorker | undefined;
  let connected = false;
  let closed = false;
  let connectPromise: Promise<void> | undefined;

  const connect = (): Promise<void> => {
    if (connected) {
      return Promise.resolve();
    }
    if (connectPromise) {
      return connectPromise;
    }
    if (closed) {
      return Promise.reject(new Error("Local Whisper session is closed"));
    }

    connectPromise = new Promise<void>((resolve, reject) => {
      const factory = options.workerFactory ?? spawnLocalWhisperWorker;
      const currentWorker = factory(options);
      worker = currentWorker;
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        currentWorker.kill();
        reject(new Error("Local Whisper worker ready timeout"));
      }, options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);

      currentWorker.onEvent((event) => {
        if (event.event === "ready") {
          if (!settled) {
            settled = true;
            connected = true;
            clearTimeout(timeout);
            resolve();
          }
          return;
        }
        if (event.event === "speech_start") {
          options.onSpeechStart?.();
          return;
        }
        if (event.event === "transcript" && event.text.trim()) {
          options.onTranscript?.(event.text.trim());
          return;
        }
        if (event.event === "error") {
          const error = new Error(event.message);
          options.onError?.(error);
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(error);
          }
        }
      });
      currentWorker.onExit((code, signal) => {
        connected = false;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(
            new Error(
              `Local Whisper worker exited before ready (code=${String(code)}, signal=${String(signal)})`,
            ),
          );
        } else if (!closed && code !== 0) {
          options.onError?.(
            new Error(
              `Local Whisper worker exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
            ),
          );
        }
      });
    });
    return connectPromise;
  };

  return {
    connect,
    sendAudio(audio) {
      if (!connected || !worker) {
        options.onError?.(new Error("Local Whisper session is not connected"));
        return;
      }
      worker.writeAudio(mulaw8KhzToPcm16Khz(audio));
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      connected = false;
      const currentWorker = worker;
      if (!currentWorker) {
        return;
      }
      currentWorker.endAudio();
      const timeout = setTimeout(
        () => currentWorker.kill(),
        options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS,
      );
      currentWorker.onExit(() => clearTimeout(timeout));
    },
    isConnected: () => connected,
  };
}
