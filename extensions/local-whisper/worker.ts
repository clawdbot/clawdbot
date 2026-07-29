import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type LocalWhisperWorkerEvent =
  | { event: "ready"; pid: number; model: string }
  | { event: "speech_start" }
  | { event: "speech_end" }
  | { event: "transcript"; text: string; segments?: unknown[] }
  | { event: "error"; message: string };

export type LocalWhisperWorkerOptions = {
  pythonPath?: string;
  workerScript: string;
  model: string;
  device: string;
  computeType: string;
  language: string;
  vadAggressiveness: number;
  silenceMs: number;
  maxUtteranceMs: number;
};

export interface LocalWhisperWorker {
  readonly pid: number | undefined;
  onEvent(listener: (event: LocalWhisperWorkerEvent) => void): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  writeAudio(audio: Buffer): void;
  endAudio(): void;
  kill(): void;
}

export type LocalWhisperWorkerFactory = (options: LocalWhisperWorkerOptions) => LocalWhisperWorker;

class ChildProcessLocalWhisperWorker implements LocalWhisperWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly eventListeners = new Set<(event: LocalWhisperWorkerEvent) => void>();
  private readonly exitListeners = new Set<
    (code: number | null, signal: NodeJS.Signals | null) => void
  >();

  constructor(options: LocalWhisperWorkerOptions) {
    const pythonPath = process.env.LOCAL_WHISPER_PYTHON ?? options.pythonPath;
    if (!pythonPath) {
      throw new Error("Local Whisper Python path is not configured");
    }
    console.debug(`[local-whisper] using Python executable: ${pythonPath}`);
    this.child = spawn(
      pythonPath,
      [
        options.workerScript,
        "--model",
        options.model,
        "--device",
        options.device,
        "--compute-type",
        options.computeType,
        "--language",
        options.language,
        "--vad-aggressiveness",
        String(options.vadAggressiveness),
        "--silence-ms",
        String(options.silenceMs),
        "--max-utterance-ms",
        String(options.maxUtteranceMs),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const event = JSON.parse(line) as LocalWhisperWorkerEvent;
        if (typeof event?.event === "string") {
          for (const listener of this.eventListeners) {
            listener(event);
          }
        }
      } catch {
        console.debug(`[local-whisper worker stdout] invalid JSON: ${line.slice(0, 160)}`);
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        console.debug(`[local-whisper worker stderr] ${message}`);
      }
    });
    this.child.on("error", (error) => this.emitError(error.message));
    this.child.on("exit", (code, signal) => {
      for (const listener of this.exitListeners) {
        listener(code, signal);
      }
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  onEvent(listener: (event: LocalWhisperWorkerEvent) => void): void {
    this.eventListeners.add(listener);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.add(listener);
  }

  writeAudio(audio: Buffer): void {
    if (!this.child.stdin.destroyed) {
      this.child.stdin.write(audio);
    }
  }

  endAudio(): void {
    if (!this.child.stdin.destroyed) {
      this.child.stdin.end();
    }
  }

  kill(): void {
    this.child.kill("SIGKILL");
  }

  private emitError(message: string): void {
    for (const listener of this.eventListeners) {
      listener({ event: "error", message });
    }
  }
}

export const spawnLocalWhisperWorker: LocalWhisperWorkerFactory = (options) =>
  new ChildProcessLocalWhisperWorker(options);
