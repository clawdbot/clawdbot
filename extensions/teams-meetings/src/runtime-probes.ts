import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { TeamsMeetingsConfig, TeamsMeetingsMode, TeamsMeetingsTransport } from "./config.js";
import type {
  TeamsMeetingsChromeHealth,
  TeamsMeetingsJoinRequest,
  TeamsMeetingsJoinResult,
  TeamsMeetingsSession,
} from "./transports/types.js";

export type TeamsMeetingsProbeContext = {
  config: TeamsMeetingsConfig;
  resolveAgentId(request: TeamsMeetingsJoinRequest): string;
  list(): TeamsMeetingsSession[];
  join(request: TeamsMeetingsJoinRequest): Promise<TeamsMeetingsJoinResult>;
  isReusable(
    session: TeamsMeetingsSession,
    resolved: {
      url: string;
      transport: TeamsMeetingsTransport;
      mode: TeamsMeetingsMode;
      agentId: string;
    },
  ): boolean;
  hasHealthHandle(sessionId: string): boolean;
  refreshHealth(sessionId: string): void;
  refreshCaptionHealth(session: TeamsMeetingsSession, timeoutMs: number): Promise<void>;
};

function resolveProbeTimeoutMs(input: number | undefined, fallback: number): number {
  if (input === undefined) {
    return Math.min(Math.max(fallback, 1), 120_000);
  }
  if (!Number.isFinite(input) || input <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }
  return Math.min(Math.trunc(input), 120_000);
}

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
  resolveTimeoutMs: resolveProbeTimeoutMs,
  shouldWaitForListening: (session) => Boolean(session.chrome?.launched),
  talkBackMode: (mode) => mode === "agent" || mode === "bidi",
});

export const testTeamsMeetingListening: (
  context: TeamsMeetingsProbeContext,
  request: TeamsMeetingsJoinRequest,
) => ReturnType<typeof probes.testListening> = probes.testListening;

export const testTeamsMeetingSpeech: (
  context: TeamsMeetingsProbeContext,
  request: TeamsMeetingsJoinRequest,
) => ReturnType<typeof probes.testSpeech> = probes.testSpeech;
