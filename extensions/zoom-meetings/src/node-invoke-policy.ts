import { createMeetingBrowserNodeInvokePolicy } from "openclaw/plugin-sdk/meeting-runtime";
import type {
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ZoomMeetingsConfig } from "./config.js";
import { ZOOM_MEETINGS_PLATFORM_ADAPTER } from "./transports/zoom-meetings-platform-adapter.js";
import { ZOOM_MEETINGS_NODE_COMMAND } from "./transports/zoom-meetings-platform-constants.js";

export function createZoomMeetingsNodeInvokePolicy(
  config: ZoomMeetingsConfig,
): OpenClawPluginNodeInvokePolicy {
  const base = createMeetingBrowserNodeInvokePolicy({
    commandName: ZOOM_MEETINGS_NODE_COMMAND,
    displayName: "Zoom meetings",
    deniedCode: "ZOOM_MEETINGS_NODE_POLICY_DENIED",
    supportedModes: new Set(["agent", "bidi", "transcribe"]),
    normalizeUrl: (url) => ZOOM_MEETINGS_PLATFORM_ADAPTER.urls.validateAndNormalize(url),
    start: config.chrome,
  });
  return {
    ...base,
    async handle(ctx: OpenClawPluginNodeInvokePolicyContext) {
      const params =
        ctx.params && typeof ctx.params === "object" && !Array.isArray(ctx.params)
          ? (ctx.params as Record<string, unknown>)
          : {};
      if (ctx.command !== ZOOM_MEETINGS_NODE_COMMAND || params.action !== "setup") {
        return await base.handle(ctx);
      }
      return await ctx.invokeNode({
        params: {
          action: "setup",
          audioInputCommand: [...config.chrome.audioInputCommand],
          audioOutputCommand: [...config.chrome.audioOutputCommand],
          ...(config.chrome.bargeInInputCommand
            ? { bargeInInputCommand: [...config.chrome.bargeInInputCommand] }
            : {}),
        },
      });
    },
  };
}
