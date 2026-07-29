import {
  createMeetingPluginConfigSchema,
  type MeetingPluginConfig,
  type MeetingPluginMode,
  type MeetingPluginTransport,
} from "openclaw/plugin-sdk/meeting-runtime";
import { addTimerTimeoutGraceMs } from "openclaw/plugin-sdk/number-runtime";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "openclaw/plugin-sdk/realtime-voice";

export type ZoomMeetingsMode = MeetingPluginMode;
export type ZoomMeetingsTransport = MeetingPluginTransport;
export type ZoomMeetingsConfig = MeetingPluginConfig;

const zoomMeetingsConfig = createMeetingPluginConfigSchema({
  defaultRealtimeInstructions: `You are joining a private Zoom meeting as an OpenClaw voice transport. Keep spoken replies brief and natural. In agent mode, wait for OpenClaw consult results and speak them exactly. In bidi mode, answer directly and call ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} for deeper reasoning, current information, or tools.`,
  resolveGatewayOperationTimeoutMs: (config) =>
    Math.max(
      60_000,
      addTimerTimeoutGraceMs(
        config.chrome.joinTimeoutMs,
        config.chrome.waitForInCallMs + config.chrome.joinTimeoutMs + 30_000,
      ) ?? 1,
    ),
  resolveSoxAudioDevice: () => ({ device: "BlackHole 2ch", deviceType: "coreaudio" }),
});

export const ZOOM_MEETINGS_CONFIG_SCHEMA = zoomMeetingsConfig.configSchema;
export const DEFAULT_ZOOM_MEETINGS_AUDIO_INPUT_COMMAND =
  zoomMeetingsConfig.defaultAudioInputCommand;
export const DEFAULT_ZOOM_MEETINGS_AUDIO_OUTPUT_COMMAND =
  zoomMeetingsConfig.defaultAudioOutputCommand;
export const resolveZoomMeetingsConfig = zoomMeetingsConfig.resolveConfig;
export const resolveZoomMeetingsGatewayOperationTimeoutMs =
  zoomMeetingsConfig.resolveGatewayOperationTimeoutMs;
