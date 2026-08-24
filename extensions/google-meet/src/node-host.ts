// Google Meet injects device/URL labels into the shared node-side browser audio host.
import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import {
  DEFAULT_GOOGLE_MEET_AUDIO_INPUT_COMMAND,
  DEFAULT_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND,
} from "./config.js";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "./transports/google-meet-platform-adapter.js";
import { GOOGLE_MEET_NODE_COMMAND } from "./transports/google-meet-platform-constants.js";

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

const googleMeetNodeHost = MeetingPlatformAdapter.createNodeHostHandler({
  commandName: GOOGLE_MEET_NODE_COMMAND,
  displayName: "Google Meet",
  browserLabel: "Meet",
  bridgeIdPrefix: "meet_node_",
  defaultAudioInputCommand: DEFAULT_GOOGLE_MEET_AUDIO_INPUT_COMMAND,
  defaultAudioOutputCommand: DEFAULT_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND,
  defaultAudio: {
    backend: "auto",
    bufferBytes: 4_096,
    format: "pcm16-24khz",
  },
  meetingLabel: "Google Meet",
  sharePrerequisiteDeadline: true,
  talkBackModes: new Set(["agent", "bidi", "realtime"]),
  agentMode: "agent",
  normalizeUrl: (url) => GOOGLE_MEET_PLATFORM_ADAPTER.urls.validateAndNormalize(url),
  normalizeMeetingKey: normalizeMeetKey,
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
  return await googleMeetNodeHost(paramsJSON);
}
