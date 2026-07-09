// Google Meet realtime tests cover real local command-pair substitute processes.
import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "./config.js";
import { formatGoogleMeetRealtimeVoiceModelLog, startCommandAgentAudioBridge } from "./realtime.js";

const tempDirs: string[] = [];
const spawnedChildren: ChildProcess[] = [];

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

function makeRecordingSpawn(): NonNullable<
  Parameters<typeof startCommandAgentAudioBridge>[0]["spawn"]
> {
  return (command, args, options) => {
    const child = spawnChildProcess(command, args, options);
    spawnedChildren.push(child);
    return child as ReturnType<
      NonNullable<Parameters<typeof startCommandAgentAudioBridge>[0]["spawn"]>
    >;
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

describe("startCommandAgentAudioBridge real process stream errors", () => {
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

    const handle = await startCommandAgentAudioBridge({
      config: resolveGoogleMeetConfig({
        chrome: { audioFormat: "pcm16-24khz" },
        realtime: { provider: "openai", agentId: "jay", introMessage: "" },
      }),
      fullConfig: {} as never,
      runtime: {} as never,
      meetingSessionId: "meet-1",
      inputCommand: [process.execPath, bridgeScript, "capture"],
      outputCommand: [process.execPath, bridgeScript, "play"],
      logger: logger as never,
      providers: [provider],
      spawn: makeRecordingSpawn(),
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
});

describe("Google Meet realtime model logs", () => {
  it("keeps a whole code point when a provider id crosses the log boundary", () => {
    const prefix = "a".repeat(179);
    const log = formatGoogleMeetRealtimeVoiceModelLog({
      strategy: "native",
      provider: { id: `${prefix}😀tail` } as RealtimeVoiceProviderPlugin,
      providerConfig: {},
      audioFormat: "pcm16-24khz",
    });

    expect(log).toContain(`provider=${prefix} model=provider-default`);
  });
});
