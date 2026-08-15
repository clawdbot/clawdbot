import type {
  CliBackendConfig,
  CliBackendJsonlUsage,
  CliBackendParseJsonlEvent,
} from "../plugins/cli-backend.types.js";
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
  yielded?: true;
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
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  onThinkingDelta?: (delta: CliThinkingDelta) => void;
  onThinkingProgress?: (progress: CliThinkingProgress) => void;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
  onDisplayToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onDisplayToolResult?: (delta: CliToolResultDelta) => void;
  onCommentaryText?: (text: string) => void;
  onSessionId?: (sessionId: string) => void;
  onAssistantMessage?: (message: unknown) => void;
  onUsage?: (usage: CliUsage, terminal: boolean) => void;
};
