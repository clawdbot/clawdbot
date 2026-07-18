import { spawnSync } from "node:child_process";
import { createMeetingNodeHost } from "openclaw/plugin-sdk/meeting-runtime";
import {
  DEFAULT_TEAMS_MEETINGS_AUDIO_INPUT_COMMAND,
  DEFAULT_TEAMS_MEETINGS_AUDIO_OUTPUT_COMMAND,
} from "./config.js";
import {
  TEAMS_MEETINGS_SYSTEM_PROFILER_COMMAND,
  outputMentionsBlackHole2ch,
} from "./transports/chrome-audio-device.js";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./transports/teams-meetings-platform-adapter.js";
import { TEAMS_MEETINGS_NODE_COMMAND } from "./transports/teams-meetings-platform-constants.js";

function commandExists(command: string, timeoutMs: number): boolean {
  const result = spawnSync("/bin/sh", ["-lc", 'command -v "$1" >/dev/null 2>&1', "sh", command], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return result.status === 0;
}

function assertTalkBackPrerequisites(
  timeoutMs: number,
  commands: readonly (readonly string[])[] = [
    DEFAULT_TEAMS_MEETINGS_AUDIO_INPUT_COMMAND,
    DEFAULT_TEAMS_MEETINGS_AUDIO_OUTPUT_COMMAND,
  ],
) {
  if (process.platform !== "darwin") {
    throw new Error("Microsoft Teams meeting talk-back with BlackHole 2ch is macOS-only");
  }
  const result = spawnSync(TEAMS_MEETINGS_SYSTEM_PROFILER_COMMAND, ["SPAudioDataType"], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const stderr =
    result.stderr ??
    (result.error
      ? result.error instanceof Error
        ? result.error.message
        : String(result.error)
      : "");
  const output = `${result.stdout ?? ""}\n${stderr}`;
  if (
    (typeof result.status === "number" ? result.status : result.error ? 1 : 0) !== 0 ||
    !outputMentionsBlackHole2ch(output)
  ) {
    throw new Error("BlackHole 2ch audio device not found on the node.");
  }
  for (const argv of commands) {
    const command = argv[0];
    if (!command || !commandExists(command, timeoutMs)) {
      throw new Error(`Configured audio command not found on the node: ${command || "<empty>"}`);
    }
  }
}

function readCommand(params: Record<string, unknown>, name: string): string[] {
  const value = params[name];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${name} must be a non-empty string array.`);
  }
  return value as string[];
}

const teamsMeetingsNodeHost = createMeetingNodeHost({
  commandName: TEAMS_MEETINGS_NODE_COMMAND,
  displayName: "Microsoft Teams meetings",
  browserLabel: "Teams meeting",
  bridgeIdPrefix: "teams_meeting_node_",
  defaultAudioInputCommand: DEFAULT_TEAMS_MEETINGS_AUDIO_INPUT_COMMAND,
  defaultAudioOutputCommand: DEFAULT_TEAMS_MEETINGS_AUDIO_OUTPUT_COMMAND,
  talkBackModes: new Set(["agent", "bidi"]),
  agentMode: "agent",
  normalizeUrl: (url) => TEAMS_MEETINGS_PLATFORM_ADAPTER.urls.validateAndNormalize(url),
  normalizeMeetingKey: (url) => TEAMS_MEETINGS_PLATFORM_ADAPTER.urls.normalizeForReuse(url),
  assertAudioAvailable: assertTalkBackPrerequisites,
  browser: {
    application: "Google Chrome",
    buildProfileArgs: (profile) => ["--args", `--profile-directory=${profile}`],
    openedStatus: "chrome-opened",
    openedNotes: [
      "Teams page control is handled by OpenClaw browser automation when using chrome-node.",
    ],
  },
});

export async function handleTeamsMeetingsNodeHostCommand(
  paramsJSON?: string | null,
): Promise<string> {
  if (paramsJSON) {
    let raw: unknown;
    try {
      raw = JSON.parse(paramsJSON) as unknown;
    } catch {
      throw new Error("Microsoft Teams meetings node host received malformed params JSON.");
    }
    const params =
      raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    if (params.action === "setup") {
      const commands = [
        readCommand(params, "audioInputCommand"),
        readCommand(params, "audioOutputCommand"),
      ];
      if (params.bargeInInputCommand !== undefined) {
        commands.push(readCommand(params, "bargeInInputCommand"));
      }
      assertTalkBackPrerequisites(10_000, commands);
      return JSON.stringify({ ok: true });
    }
  }
  return await teamsMeetingsNodeHost.handleCommand(paramsJSON);
}
