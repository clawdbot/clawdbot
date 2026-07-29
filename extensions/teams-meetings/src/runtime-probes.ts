import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { TeamsMeetingsConfig, TeamsMeetingsMode, TeamsMeetingsTransport } from "./config.js";
import type {
  TeamsMeetingsChromeHealth,
  TeamsMeetingsJoinRequest,
  TeamsMeetingsPluginTypes,
  TeamsMeetingsSession,
} from "./transports/types.js";

export type TeamsMeetingsProbeContext = TeamsMeetingsPluginTypes["ProbeContext"];

const probes = MeetingPlatformAdapter.createRuntimeProbes<
  TeamsMeetingsConfig,
  TeamsMeetingsMode,
  TeamsMeetingsTransport,
  TeamsMeetingsChromeHealth,
  TeamsMeetingsSession,
  TeamsMeetingsJoinRequest
>({
  defaultSpeechMessage: "Say exactly: Microsoft Teams speech test complete.",
  invalidRequest: (message) => new Error(message),
  resolveTimeoutMs: MeetingPlatformAdapter.resolveProbeTimeoutMs,
  shouldWaitForListening: (session) => Boolean(session.chrome?.launched),
  talkBackMode: MeetingPlatformAdapter.isTalkBackMode,
});

export const testTeamsMeetingListening = probes.testListening;
export const testTeamsMeetingSpeech = probes.testSpeech;
