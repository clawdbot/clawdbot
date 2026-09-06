import type {
  TranscriptsGetResult,
  TranscriptsListResult,
  TranscriptsStatusResult,
} from "../../packages/gateway-protocol/src/schema/transcripts.js";

export const transcriptListFixture: TranscriptsListResult = {
  sessions: [
    {
      selector: "2026-08-20/team-check-in",
      sessionId: "team-check-in",
      title: "Team check-in",
      source: { providerId: "manual-transcript", kind: "posthoc-transcript" },
      providerId: "manual-transcript",
      agentId: "main",
      startedAt: "2026-08-20T15:00:00.000Z",
      stoppedAt: "2026-08-20T15:15:00.000Z",
      updatedAt: "2026-08-20T15:15:01.000Z",
      utteranceCount: 2,
      lastUtteranceAt: "2026-08-20T15:14:00.000Z",
      hasSummary: true,
      active: false,
      participants: ["Alex", "Sam"],
      activeSubscription: false,
    },
  ],
  nextCursor: null,
};
export const transcriptGetFixture: TranscriptsGetResult = {
  session: transcriptListFixture.sessions[0]!,
  utterances: [
    {
      sequence: 0,
      speakerLabel: "Alex",
      text: "We agreed to verify the reader before shipping.",
      startedAt: "2026-08-20T15:00:00.000Z",
      final: true,
    },
    {
      sequence: 1,
      speakerLabel: "Sam",
      text: "Action: check pagination and permissions.",
      startedAt: "2026-08-20T15:14:00.000Z",
      final: true,
    },
  ],
  nextCursor: null,
  summary: {
    source: "heuristic",
    participants: ["Alex", "Sam"],
    markdown: "## Overview\n\nWe agreed to verify the reader before shipping.",
    generatedAt: "2026-08-20T15:15:01.000Z",
    overview: "We agreed to verify the reader before shipping.",
    decisions: ["Alex: We agreed to verify the reader before shipping."],
    actionItems: ["Sam: Action: check pagination and permissions."],
    risks: [],
    utteranceCount: 2,
  },
};
export const transcriptStatusFixture: TranscriptsStatusResult = {
  enabled: true,
  providers: [
    {
      providerId: "manual-transcript",
      name: "Manual Transcript Import",
      availability: "enabled",
      sourceKinds: ["posthoc-transcript"],
      canStart: false,
      canStop: false,
      canImport: true,
    },
  ],
  configuredSources: [],
  active: [],
  latestTranscript: transcriptListFixture.sessions[0]!,
  omitted: { providers: 0, configuredSources: 0, active: 0 },
};
