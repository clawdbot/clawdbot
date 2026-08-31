import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { ZoomMeetingsConfig } from "./config.js";
import { ZOOM_MEETINGS_PLATFORM_ADAPTER } from "./transports/zoom-meetings-platform-adapter.js";

export function createZoomMeetingsNodeInvokePolicy(config: ZoomMeetingsConfig) {
  return MeetingPlatformAdapter.createPluginNodeInvokePolicy(config, {
    deniedCode: "ZOOM_MEETINGS_NODE_POLICY_DENIED",
    platform: ZOOM_MEETINGS_PLATFORM_ADAPTER,
  });
}
