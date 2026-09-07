// Parses directive level values for reasoning, verbosity, and elevated mode.
import {
  normalizeFastMode,
  type FastMode,
  type ReasoningLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../thinking.js";

/** Resolves current directive levels from session, agent, and config defaults. */
export async function resolveCurrentDirectiveLevels(params: {
  sessionEntry?: {
    thinkingLevel?: unknown;
    fastMode?: unknown;
    verboseLevel?: unknown;
    reasoningLevel?: unknown;
  };
  agentEntry?: {
    fastModeDefault?: unknown;
    reasoningDefault?: unknown;
  };
  agentCfg?: {
    thinkingDefault?: unknown;
    verboseDefault?: unknown;
    reasoningDefault?: unknown;
  };
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
}): Promise<{
  currentThinkLevel: ThinkLevel | undefined;
  currentFastMode: FastMode | undefined;
  currentVerboseLevel: VerboseLevel | undefined;
  currentReasoningLevel: ReasoningLevel;
}> {
  const resolvedDefaultThinkLevel =
    (params.sessionEntry?.thinkingLevel as ThinkLevel | undefined) ??
    (await params.resolveDefaultThinkingLevel()) ??
    (params.agentCfg?.thinkingDefault as ThinkLevel | undefined);
  const currentThinkLevel = resolvedDefaultThinkLevel;
  const currentFastMode =
    normalizeFastMode(params.sessionEntry?.fastMode) ??
    normalizeFastMode(params.agentEntry?.fastModeDefault);
  const currentVerboseLevel =
    (params.sessionEntry?.verboseLevel as VerboseLevel | undefined) ??
    (params.agentCfg?.verboseDefault as VerboseLevel | undefined);
  const currentReasoningLevel =
    (params.sessionEntry?.reasoningLevel as ReasoningLevel | undefined) ??
    (params.agentEntry?.reasoningDefault as ReasoningLevel | undefined) ??
    (params.agentCfg?.reasoningDefault as ReasoningLevel | undefined) ??
    "off";
  return {
    currentThinkLevel,
    currentFastMode,
    currentVerboseLevel,
    currentReasoningLevel,
  };
}
