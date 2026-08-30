import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { TeamsMeetingsConfig, TeamsMeetingsMode, TeamsMeetingsTransport } from "./config.js";
import { teamsMeetingsInvalidRequest } from "./errors.js";
import type {
  TeamsMeetingsChromeHealth,
  TeamsMeetingsJoinRequest,
  TeamsMeetingsSession,
} from "./transports/types.js";

const probes = MeetingPlatformAdapter.createRuntimeProbes<
  TeamsMeetingsConfig,
  TeamsMeetingsMode,
  TeamsMeetingsTransport,
  TeamsMeetingsChromeHealth,
  TeamsMeetingsSession,
  TeamsMeetingsJoinRequest
>({
  defaultSpeechMessage: "Say exactly: Microsoft Teams speech test complete.",
  invalidRequest: teamsMeetingsInvalidRequest,
  resolveTimeoutMs: (input, fallback) =>
    MeetingPlatformAdapter.resolveProbeTimeoutMs(input, fallback, teamsMeetingsInvalidRequest),
  shouldWaitForListening: ({ chrome }) => Boolean(chrome?.launched || chrome?.browserTab?.targetId),
  talkBackMode: MeetingPlatformAdapter.isTalkBackMode,
});

export const testTeamsMeetingListening = probes.testListening;
export const testTeamsMeetingSpeech = probes.testSpeech;
