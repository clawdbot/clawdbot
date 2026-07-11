import type { FastMode } from "@openclaw/normalization-core/string-coerce";
// Status text types describe runtime status records used by status rendering.
import type {
  ElevatedLevel,
  ReasoningLevel,
  ThinkLevel,
  VerboseLevel,
} from "../auto-reply/thinking.js";
import type { SessionEntry, SessionScope } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MediaUnderstandingDecision } from "../media-understanding/types.js";

// Input contract for buildStatusText. Most fields are already resolved by the
// caller so status rendering can stay presentation-focused and side-effect-light.
export type BuildStatusTextParams = {
  cfg: OpenClawConfig;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  parentSessionKey?: string;
  sessionScope?: SessionScope;
  storePath?: string;
  statusChannel: string;
  statusAccountId?: string;
  workspaceDir?: string;
  provider: string;
  model: string;
  contextTokens?: number;
  resolvedThinkLevel?: ThinkLevel;
  resolvedFastMode?: FastMode;
  resolvedHarness?: string;
  resolvedVerboseLevel: VerboseLevel;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel?: ElevatedLevel;
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
  isGroup: boolean;
  defaultGroupActivation: () => "always" | "mention";
  mediaDecisions?: MediaUnderstandingDecision[];
  taskLineOverride?: string;
  pluginHealthLineOverride?: string;
  skipDefaultTaskLookup?: boolean;
  primaryModelLabelOverride?: string;
  modelAuthOverride?: string;
  activeModelAuthOverride?: string;
  includeTranscriptUsage?: boolean;
};
