import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type { AutoFallbackPrimaryProbe } from "../../agents/agent-scope.js";
import type { ExecToolDefaults } from "../../agents/bash-tools.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ExtractedFileImage } from "../../media-understanding/extracted-file-images.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { buildCommandContext } from "./commands.js";
import type { InlineDirectives } from "./directive-handling.js";
import type { InternalGetReplyOptions as BaseInternalGetReplyOptions } from "./get-reply.types.js";
import type { createModelSelectionState } from "./model-selection.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import type { ReplySessionEntryHandle } from "./session-entry-handle.js";
import type { TypingController } from "./typing.js";

export type InternalGetReplyOptions = BaseInternalGetReplyOptions & {
  /**
   * Dispatch-owned pre-run operation. This is intentionally not part of the
   * public reply API; it lets dispatch prep and hook work share the same
   * diagnostic/abort ownership as the eventual agent run.
   */
  replyOperation?: ReplyOperation;
  /**
   * Source-owned abort signal to persist with queued room-event followups. This
   * can differ from abortSignal when dispatch temporarily borrows an active lane.
   */
  queuedFollowupAbortSignal?: AbortSignal;
  onSessionPrepared?: (binding: {
    sessionKey?: string;
    sessionId: string;
    storePath?: string;
  }) => void;
  extractedFileImages?: ExtractedFileImage[];
};

type AgentDefaults = NonNullable<OpenClawConfig["agents"]>["defaults"];
export type ExecOverrides = Pick<
  ExecToolDefaults,
  "host" | "security" | "ask" | "node" | "nodeCwd"
>;

export type RunPreparedReplyParams = {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  agentCfg: AgentDefaults;
  sessionCfg: OpenClawConfig["session"];
  commandAuthorized: boolean;
  command: ReturnType<typeof buildCommandContext>;
  commandSource?: string;
  allowTextCommands: boolean;
  directives: InlineDirectives;
  defaultActivation: "always" | "mention";
  resolvedThinkLevel: ThinkLevel | undefined;
  resolvedFastMode?: FastMode;
  resolvedFastModeAutoOnSeconds?: number;
  resolvedFastModeOverride?: boolean;
  resolvedFastModeAutoOnSecondsOverride?: boolean;
  resolvedVerboseLevel: VerboseLevel | undefined;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel: ElevatedLevel;
  execOverrides?: ExecOverrides;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  modelState: Awaited<ReturnType<typeof createModelSelectionState>>;
  provider: string;
  model: string;
  perMessageQueueMode?: InlineDirectives["queueMode"];
  perMessageQueueOptions?: {
    debounceMs?: number;
    cap?: number;
    dropPolicy?: InlineDirectives["dropPolicy"];
  };
  typing: TypingController;
  opts?: InternalGetReplyOptions;
  defaultModel: string;
  timeoutMs: number;
  isNewSession: boolean;
  resetTriggered: boolean;
  systemSent: boolean;
  sessionEntry?: SessionEntry;
  sessionEntryHandle?: ReplySessionEntryHandle;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  sessionId?: string;
  storePath?: string;
  workspaceDir: string;
  abortedLastRun: boolean;
  autoFallbackPrimaryProbe?: AutoFallbackPrimaryProbe;
};
