import {
  MeetingPlatformAdapter,
  resolveMeetingProbeTimeoutMs,
  type MeetingProbeContext,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { TeamsMeetingsConfig, TeamsMeetingsMode, TeamsMeetingsTransport } from "./config.js";
import type {
  TeamsMeetingsChromeHealth,
  TeamsMeetingsJoinRequest,
  TeamsMeetingsSession,
} from "./transports/types.js";

export type TeamsMeetingsProbeContext = MeetingProbeContext<
  TeamsMeetingsConfig,
  TeamsMeetingsMode,
  TeamsMeetingsTransport,
  TeamsMeetingsChromeHealth,
  TeamsMeetingsSession,
  TeamsMeetingsJoinRequest
>;

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
  resolveTimeoutMs: resolveMeetingProbeTimeoutMs,
  shouldWaitForListening: (session) => Boolean(session.chrome?.launched),
  talkBackMode: MeetingPlatformAdapter.isTalkBackMode,
});

export const testTeamsMeetingListening = probes.testListening;
export const testTeamsMeetingSpeech = probes.testSpeech;
