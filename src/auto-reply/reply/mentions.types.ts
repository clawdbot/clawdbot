import type { ResolveMentionPatternPolicyParams } from "../../channels/mention-pattern-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export type BuildMentionRegexesOptions = Omit<ResolveMentionPatternPolicyParams, "cfg" | "agentId">;

export type BuildMentionRegexes = (
  cfg: OpenClawConfig | undefined,
  agentId?: string,
  options?: BuildMentionRegexesOptions,
) => RegExp[];

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
