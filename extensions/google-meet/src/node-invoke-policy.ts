import { createMeetingBrowserNodeInvokePolicy } from "openclaw/plugin-sdk/meeting-runtime";
import type { OpenClawPluginNodeInvokePolicy } from "openclaw/plugin-sdk/plugin-entry";
import type { GoogleMeetConfig } from "./config.js";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "./transports/google-meet-platform-adapter.js";
import { GOOGLE_MEET_NODE_COMMAND } from "./transports/google-meet-platform-constants.js";

export const GOOGLE_MEET_CHROME_NODE_COMMAND = GOOGLE_MEET_NODE_COMMAND;

const START_MODES = new Set(["agent", "bidi", "realtime", "transcribe"]);

export function createGoogleMeetChromeNodeInvokePolicy(
  config: GoogleMeetConfig,
): OpenClawPluginNodeInvokePolicy {
  return createMeetingBrowserNodeInvokePolicy({
    commandName: GOOGLE_MEET_CHROME_NODE_COMMAND,
    displayName: "Google Meet",
    deniedCode: "GOOGLE_MEET_NODE_POLICY_DENIED",
    supportedModes: START_MODES,
    normalizeUrl: (url) => GOOGLE_MEET_PLATFORM_ADAPTER.urls.validateAndNormalize(url),
    start: config.chrome,
  });
}
