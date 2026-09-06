import type {
  TranscriptSessionSummary,
  TranscriptsGetResult,
  TranscriptsStatusResult,
} from "@openclaw/gateway-protocol";

export const meetingEntry = {
  selector: "2026-08-27/design-review",
  sessionId: "design-review",
  title: "Design review",
  providerId: "test-voice",
  participants: ["Avery"],
  active: false,
  source: { providerId: "test-voice", accountId: "team", guildId: "guild", channelId: "room" },
  agentId: "notes",
  startedAt: "2026-08-27T09:00:00.000Z",
  updatedAt: "2026-08-27T09:30:00.000Z",
  utteranceCount: 2,
  lastUtteranceAt: "2026-08-27T09:29:00.000Z",
  hasSummary: true,
  activeSubscription: false,
} satisfies TranscriptSessionSummary;

export const meetingPage = {
  session: meetingEntry,
  utterances: [
    {
      sequence: 0,
      startedAt: meetingEntry.startedAt,
      speakerLabel: "Avery",
      speakerId: "speaker-a",
      text: "Keep the reader quiet and readable.",
    },
  ],
  nextCursor: "reader-page-2",
  summary: {
    source: "heuristic",
    participants: ["Avery"],
    markdown: "# Design review\n\nReader layout discussed.\n",
    generatedAt: meetingEntry.updatedAt,
    overview: "Reader layout discussed.",
    decisions: ["Keep one reading column."],
    actionItems: [],
    risks: [],
    utteranceCount: 2,
  },
} satisfies TranscriptsGetResult;

export const meetingStatus = {
  enabled: true,
  providers: [
    {
      providerId: "test-voice",
      name: "Test voice",
      availability: "enabled",
      canStart: true,
      autoStart: { accountId: "optional", guildId: "required", channelId: "required" },
      sourceKinds: ["live-audio"],
    },
  ],
  configuredSources: [
    {
      source: meetingEntry.source,
      title: meetingEntry.title,
      sessionId: "custom-session",
      state: "not-active",
      activeSelectors: [],
    },
  ],
  active: [],
  latestTranscript: meetingEntry,
  omitted: { providers: 0, configuredSources: 0, active: 0 },
} satisfies TranscriptsStatusResult;
