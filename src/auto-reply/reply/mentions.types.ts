import type { OpenClawConfig } from "../../config/types.openclaw.js";

export type BuildMentionRegexes = (cfg: OpenClawConfig | undefined, agentId?: string) => RegExp[];

export type MatchesMentionPatterns = (text: string, mentionRegexes: RegExp[]) => boolean;

export type ExplicitMentionSignal = {
  hasAnyMention: boolean;
  isExplicitlyMentioned: boolean;
  canResolveExplicit: boolean;
};

export type MatchesMentionWithExplicit = (params: {
  text: string;
  mentionRegexes: RegExp[];
  explicit?: ExplicitMentionSignal;
  transcript?: string;
}) => boolean;
