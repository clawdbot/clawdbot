import type {
  CliBackendConfig,
  CliBackendJsonlUsage,
  CliBackendParseJsonlEvent,
  CliBackendParseJsonlLifecycleEvent,
} from "../plugins/cli-backend.types.js";
import type { AcceptedSessionSpawn } from "./accepted-session-spawn.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "./embedded-agent-messaging.types.js";
import type { ToolSummaryTrace } from "./embedded-agent-runner/types.js";

export type CliUsage = CliBackendJsonlUsage;

type CliProcessDiagnostics = {
  backendId: string;
  processReason: string;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  durationMs: number;
  stdoutBytes: number;
  stdoutHash: string;
  stderrBytes: number;
  stderrHash: string;
  useResume: boolean;
};

export type CliTerminalFailure =
  | {
      reason: "max_turns";
      limit?: number;
    }
  | { reason: "synthetic_no_response" };

export type CliTerminalInterruption = {
  reason: "aborted" | "timeout";
};

/** Normalized result from a CLI-backed model provider turn. */
export type CliOutput = {
  text: string;
  rawText?: string;
  sessionId?: string;
  /** Backend-owned assistant boundary that can safely anchor a later resumed fork. */
  resumeCheckpointId?: string;
  usage?: CliUsage;
  /** Terminal cumulative turn usage for diagnostics; reply accounting keeps using `usage`. */
  diagnosticUsage?: CliUsage;
  toolSummary?: ToolSummaryTrace;
  errorText?: string;
  terminalFailure?: CliTerminalFailure;
  /** A caller interruption that ended the turn after usable assistant text was streamed. */
  terminalInterruption?: CliTerminalInterruption;
  diagnostics?: {
    process?: CliProcessDiagnostics;
  };
  finalPromptText?: string;
  didSendViaMessagingTool?: boolean;
  didDeliverSourceReplyViaMessageTool?: boolean;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: MessagingToolSend[];
  messagingToolSourceReplyPayloads?: MessagingToolSourceReplyPayload[];
  /** Trust-filtered explicit outbound media captured before CLI result normalization. */
  toolMediaUrls?: string[];
  toolAudioAsVoice?: boolean;
  toolTrustedLocalMedia?: boolean;
  /** Child sessions accepted by the turn-scoped loopback tool capture. */
  acceptedSessionSpawns?: AcceptedSessionSpawn[];
  yielded?: true;
  yieldAcknowledgment?: string;
};

export type CliStreamingDelta = {
  text: string;
  delta: string;
  sessionId?: string;
  usage?: CliUsage;
};

export type CliStreamJsonOutputLimits = {
  maxTurnRawChars: number;
  maxPendingLineChars: number;
  maxTurnLines: number;
};

/** Incremental thinking text emitted while parsing a streaming CLI response. */
export type CliThinkingDelta = {
  text: string;
  delta: string;
  isReasoningSnapshot?: boolean;
};

export type CliThinkingProgress = {
  progressTokens: number;
};

export type CliCompactionDelta = { phase: "start" } | { phase: "end"; completed: boolean };

/** Tool-call start event reconstructed from CLI stream output. */
export type CliToolUseStartDelta = {
  toolCallId: string;
  name: string;
  // Preserve the producer kind: a server-native start without its result is not a failed local call.
  kind: "tool_use" | "server_tool_use" | "mcp_tool_use";
  args: Record<string, unknown>;
};

/** Tool-call result event reconstructed from CLI stream output. */
export type CliToolResultDelta = {
  toolCallId: string;
  name: string;
  isError: boolean;
  result?: unknown;
};

export type CliJsonlStreamingParserOptions = {
  backend: CliBackendConfig;
  providerId: string;
  parseJsonlEvent?: CliBackendParseJsonlEvent;
  parseJsonlLifecycleEvent?: CliBackendParseJsonlLifecycleEvent;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  onThinkingDelta?: (delta: CliThinkingDelta) => void;
  onThinkingProgress?: (progress: CliThinkingProgress) => void;
  onCompaction?: (delta: CliCompactionDelta) => void;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
  onDisplayToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onDisplayToolResult?: (delta: CliToolResultDelta) => void;
  onCommentaryText?: (text: string) => void;
  onSessionId?: (sessionId: string) => void;
  onAssistantMessage?: (message: unknown) => void;
  onUsage?: (usage: CliUsage, terminal: boolean) => void;
};
