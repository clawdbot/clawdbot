/** Runtime type contracts for mention-pattern matching helpers. */
import type { ResolveMentionPatternPolicyParams } from "../../channels/mention-pattern-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Options for building mention regexes without binding config/agent id. */
export type BuildMentionRegexesOptions = Omit<ResolveMentionPatternPolicyParams, "cfg" | "agentId">;

/** Builds mention regexes for the current config and agent. */
export type BuildMentionRegexes = (
  cfg: OpenClawConfig | undefined,
  agentId?: string,
  options?: BuildMentionRegexesOptions,
) => RegExp[];

/** Tests plain text against mention regexes. */
export type MatchesMentionPatterns = (text: string, mentionRegexes: RegExp[]) => boolean;

/** Explicit mention metadata supplied by channel adapters. */
export type ExplicitMentionSignal = {
  hasAnyMention: boolean;
  isExplicitlyMentioned: boolean;
  canResolveExplicit: boolean;
};

/** Tests mention state using regexes plus explicit channel mention metadata. */
export type MatchesMentionWithExplicit = (params: {
  text: string;
  mentionRegexes: RegExp[];
  explicit?: ExplicitMentionSignal;
  transcript?: string;
}) => boolean;
