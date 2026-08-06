// Google Meet injects device/URL labels into the shared node-side browser audio host.
import { spawnSync } from "node:child_process";
import { createMeetingNodeHost } from "openclaw/plugin-sdk/meeting-runtime";
import {
  DEFAULT_GOOGLE_MEET_AUDIO_INPUT_COMMAND,
  DEFAULT_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND,
} from "./config.js";
import {
  GOOGLE_MEET_SYSTEM_PROFILER_COMMAND,
  outputMentionsBlackHole2ch,
} from "./transports/chrome-audio-device.js";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "./transports/google-meet-platform-adapter.js";
import { GOOGLE_MEET_NODE_COMMAND } from "./transports/google-meet-platform-constants.js";

function assertBlackHoleAvailable(timeoutMs: number) {
  if (process.platform !== "darwin") {
    throw new Error("Chrome Meet transport with blackhole-2ch audio is currently macOS-only");
  }
  const result = spawnSync(GOOGLE_MEET_SYSTEM_PROFILER_COMMAND, ["SPAudioDataType"], {
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
}

function normalizeMeetKey(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "meet.google.com") {
      return value;
    }
    const match = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/i.exec(url.pathname);
    return match?.[1]?.toLowerCase() ?? value;
  } catch {
    return value;
  }
}

const googleMeetNodeHost = createMeetingNodeHost({
  commandName: GOOGLE_MEET_NODE_COMMAND,
  displayName: "Google Meet",
  browserLabel: "Meet",
  bridgeIdPrefix: "meet_node_",
  defaultAudioInputCommand: DEFAULT_GOOGLE_MEET_AUDIO_INPUT_COMMAND,
  defaultAudioOutputCommand: DEFAULT_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND,
  talkBackModes: new Set(["agent", "bidi", "realtime"]),
  agentMode: "agent",
  normalizeUrl: (url) => GOOGLE_MEET_PLATFORM_ADAPTER.urls.validateAndNormalize(url),
  normalizeMeetingKey: normalizeMeetKey,
  assertAudioAvailable: assertBlackHoleAvailable,
  browser: {
    application: "Google Chrome",
    buildProfileArgs: (profile) => ["--args", `--profile-directory=${profile}`],
    openedStatus: "chrome-opened",
    openedNotes: [
      "Browser page control is handled by OpenClaw browser automation when using chrome-node.",
    ],
  },
});

export async function handleGoogleMeetNodeHostCommand(paramsJSON?: string | null): Promise<string> {
  return await googleMeetNodeHost.handleCommand(paramsJSON);
}
