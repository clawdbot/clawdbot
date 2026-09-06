import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const SummarySourceSchema = Type.Union([Type.Literal("model"), Type.Literal("heuristic")]);

export const TranscriptSessionSummarySchema = closedObject({
  selector: NonEmptyString,
  sessionId: NonEmptyString,
  title: Type.Optional(Type.String()),
  providerId: NonEmptyString,
  providerName: Type.Optional(Type.String()),
  source: closedObject({
    providerId: NonEmptyString,
    accountId: Type.Optional(Type.String()),
    guildId: Type.Optional(Type.String()),
    channelId: Type.Optional(Type.String()),
    meetingUrl: Type.Optional(Type.String()),
  }),
  startedAt: NonEmptyString,
  stoppedAt: Type.Optional(Type.String()),
  active: Type.Boolean(),
  utteranceCount: Type.Integer({ minimum: 0 }),
  participants: Type.Array(Type.String()),
  hasSummary: Type.Boolean(),
  summarySource: Type.Optional(SummarySourceSchema),
  overview: Type.Optional(Type.String({ maxLength: 280 })),
});

export const TranscriptsListParamsSchema = closedObject({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
  providerId: Type.Optional(NonEmptyString),
});
export const TranscriptsListResultSchema = closedObject({
  sessions: Type.Array(TranscriptSessionSummarySchema, { maxItems: 200 }),
});
export const TranscriptsGetParamsSchema = closedObject({
  selector: NonEmptyString,
  includeUtterances: Type.Optional(Type.Boolean()),
});
export const TranscriptsGetResultSchema = closedObject({
  session: TranscriptSessionSummarySchema,
  summary: Type.Optional(
    closedObject({
      generatedAt: Type.String(),
      overview: Type.String(),
      decisions: Type.Array(Type.String()),
      actionItems: Type.Array(Type.String()),
      risks: Type.Array(Type.String()),
      participants: Type.Array(Type.String()),
      source: Type.Optional(SummarySourceSchema),
      model: Type.Optional(Type.String()),
      markdown: Type.String(),
    }),
  ),
  utterances: Type.Optional(
    Type.Array(
      closedObject({
        sequence: Type.Integer({ minimum: 0 }),
        startedAt: Type.Optional(Type.String()),
        endedAt: Type.Optional(Type.String()),
        speakerId: Type.Optional(Type.String()),
        speakerLabel: Type.Optional(Type.String()),
        text: Type.String({ maxLength: 4000 }),
        final: Type.Optional(Type.Boolean()),
      }),
    ),
  ),
});

export type TranscriptSessionSummary = Static<typeof TranscriptSessionSummarySchema>;
export type TranscriptsListParams = Static<typeof TranscriptsListParamsSchema>;
export type TranscriptsListResult = Static<typeof TranscriptsListResultSchema>;
export type TranscriptsGetParams = Static<typeof TranscriptsGetParamsSchema>;
export type TranscriptsGetResult = Static<typeof TranscriptsGetResultSchema>;
