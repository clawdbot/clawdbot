import type {
  ElevatedLevel,
  ReasoningLevel,
  ThinkLevel,
  VerboseLevel,
} from "../auto-reply/thinking.js";
import type { SessionEntry, SessionScope } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MediaUnderstandingDecision } from "../media-understanding/types.js";

export type BuildStatusTextParams = {
  cfg: OpenClawConfig;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  parentSessionKey?: string;
  sessionScope?: SessionScope;
  storePath?: string;
  statusChannel: string;
  provider: string;
  model: string;
  contextTokens?: number;
  resolvedThinkLevel?: ThinkLevel;
  resolvedFastMode?: boolean;
  resolvedHarness?: string;
  resolvedVerboseLevel: VerboseLevel;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel?: ElevatedLevel;
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
  isGroup: boolean;
  defaultGroupActivation: () => "always" | "mention";
  mediaDecisions?: MediaUnderstandingDecision[];
  taskLineOverride?: string;
  skipDefaultTaskLookup?: boolean;
  primaryModelLabelOverride?: string;
  modelAuthOverride?: string;
  activeModelAuthOverride?: string;
  includeTranscriptUsage?: boolean;
};
