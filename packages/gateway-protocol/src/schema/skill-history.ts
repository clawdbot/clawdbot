import type { Static } from "typebox";
import { Type } from "typebox";
import { lazyCompile } from "../protocol-validator.js";
import { NonEmptyString } from "./primitives.js";

export const SkillsProposalHistoryStatusParamsSchema = Type.Object(
  { agentId: Type.Optional(NonEmptyString) },
  { additionalProperties: false },
);

export const SkillsProposalHistoryScanParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    direction: Type.Optional(Type.Union([Type.Literal("older"), Type.Literal("newer")])),
  },
  { additionalProperties: false },
);

export const SkillsProposalHistoryScanResultSchema = Type.Object(
  {
    schema: Type.Literal("openclaw.skill-workshop.history-scan.v1"),
    hasScanned: Type.Boolean(),
    reviewedSessions: Type.Integer({ minimum: 0 }),
    ideasFound: Type.Integer({ minimum: 0 }),
    hasMore: Type.Boolean(),
    lastScanReviewed: Type.Integer({ minimum: 0 }),
    lastScanIdeas: Type.Integer({ minimum: 0 }),
    lastScanAt: Type.Optional(NonEmptyString),
    oldestReviewedAt: Type.Optional(NonEmptyString),
    newestReviewedAt: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export type SkillsProposalHistoryStatusParams = Static<
  typeof SkillsProposalHistoryStatusParamsSchema
>;
export type SkillsProposalHistoryScanParams = Static<typeof SkillsProposalHistoryScanParamsSchema>;
export type SkillsProposalHistoryScanResult = Static<typeof SkillsProposalHistoryScanResultSchema>;

export const validateSkillsProposalHistoryStatusParams = lazyCompile(
  SkillsProposalHistoryStatusParamsSchema,
);
export const validateSkillsProposalHistoryScanParams = lazyCompile(
  SkillsProposalHistoryScanParamsSchema,
);
