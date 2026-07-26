import { createMeetingBrowserNodeInvokePolicy } from "openclaw/plugin-sdk/meeting-runtime";
import type { ZoomMeetingsConfig } from "./config.js";
import { ZOOM_MEETINGS_PLATFORM_ADAPTER } from "./transports/zoom-meetings-platform-adapter.js";
import { ZOOM_MEETINGS_NODE_COMMAND } from "./transports/zoom-meetings-platform-constants.js";

export function createZoomMeetingsNodeInvokePolicy(config: ZoomMeetingsConfig) {
  return createMeetingBrowserNodeInvokePolicy({
    commandName: ZOOM_MEETINGS_NODE_COMMAND,
    displayName: "Zoom meetings",
    deniedCode: "ZOOM_MEETINGS_NODE_POLICY_DENIED",
    supportedModes: new Set(["agent", "bidi", "transcribe"]),
    normalizeUrl: (url) => ZOOM_MEETINGS_PLATFORM_ADAPTER.urls.validateAndNormalize(url),
    useConfiguredSetupCommands: true,
    start: config.chrome,
  });
}
