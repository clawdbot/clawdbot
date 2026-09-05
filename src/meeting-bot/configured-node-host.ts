import { spawnSync } from "node:child_process";
import {
  ensureMeetingAudioBackend,
  resolveMeetingAudioRuntimeForFormat,
  type MeetingAudioCommandResult,
} from "./audio-backend.js";
import {
  createMeetingNodeHost,
  type MeetingNodeAudioConfig,
  type MeetingNodeHostOptions,
} from "./node-host.js";

type MeetingConfiguredNodeHostOptions = Omit<
  MeetingNodeHostOptions,
  "assertAudioAvailable" | "prepareAudio"
> & {
  meetingLabel: string;
  sharePrerequisiteDeadline: boolean;
};

function isSpawnSyncTimeout(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ETIMEDOUT";
}

export function createMeetingConfiguredNodeHost(options: MeetingConfiguredNodeHostOptions) {
  const runCommand = (argv: string[], timeoutMs: number): MeetingAudioCommandResult => {
    const [command, ...args] = argv;
    if (!command) {
      return { code: 1, stderr: "command must not be empty" };
    }
    const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs });
    if (isSpawnSyncTimeout(result.error)) {
      throw new Error(`${options.meetingLabel} audio prerequisite check timed out on the node.`);
    }
    const error = result.error
      ? result.error instanceof Error
        ? result.error.message
        : String(result.error)
      : "";
    const stderr = [error, result.stderr, result.signal ? `terminated by ${result.signal}` : ""]
      .filter(Boolean)
      .join(": ");
    return {
      code: typeof result.status === "number" ? result.status : 1,
      stdout: result.stdout ?? "",
      stderr,
    };
  };

  const probeCommand = (command: string, timeoutMs: number): "found" | "missing" | "timed-out" => {
    const result = spawnSync("/bin/sh", ["-lc", 'command -v "$1" >/dev/null 2>&1', "sh", command], {
      encoding: "utf8",
      timeout: timeoutMs,
    });
    if (isSpawnSyncTimeout(result.error)) {
      return "timed-out";
    }
    return result.status === 0 ? "found" : "missing";
  };

  const prepareAudio = async (config: MeetingNodeAudioConfig, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    const commandTimeout = () => {
      if (!options.sharePrerequisiteDeadline) {
        return timeoutMs;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`${options.meetingLabel} audio prerequisite check timed out on the node.`);
      }
      return remainingMs;
    };
    const runtime = resolveMeetingAudioRuntimeForFormat({
      backend: config.backend,
      bufferBytes: config.bufferBytes,
      format: config.format,
      inputCommand: config.inputCommand,
      outputCommand: config.outputCommand,
    });
    await ensureMeetingAudioBackend({
      backend: runtime.backend,
      run: async (argv, requestedTimeoutMs) => {
        return runCommand(argv, Math.min(requestedTimeoutMs, commandTimeout()));
      },
      timeoutMs,
    });
    const commandNames = new Set(
      [runtime.inputCommand, runtime.outputCommand, config.bargeInInputCommand].flatMap(
        (command) => (command?.[0] ? [command[0]] : []),
      ),
    );
    for (const command of commandNames) {
      const probeResult = probeCommand(command, commandTimeout());
      if (probeResult === "timed-out") {
        throw new Error(`${options.meetingLabel} audio prerequisite check timed out on the node.`);
      }
      if (probeResult === "missing") {
        throw new Error(`Configured audio command not found on the node: ${command}`);
      }
    }
    return runtime;
  };

  const host = createMeetingNodeHost({
    ...options,
    assertAudioAvailable: async (timeoutMs) => {
      await prepareAudio(
        {
          backend: options.defaultAudio?.backend ?? "auto",
          bufferBytes: options.defaultAudio?.bufferBytes ?? 4_096,
          format: options.defaultAudio?.format ?? "pcm16-24khz",
        },
        timeoutMs,
      );
    },
    prepareAudio,
  });

  return async (paramsJSON?: string | null): Promise<string> =>
    await host.handleCommand(paramsJSON);
}
