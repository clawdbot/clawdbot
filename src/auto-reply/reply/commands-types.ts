import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type { QueueMode } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
/** Shared command handler context and result contracts. */
import type { BlockReplyChunking } from "../../agents/embedded-agent-block-chunker.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { SessionEntry, SessionScope } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionMemoryTranscript } from "../../hooks/bundled/session-memory/capture.js";
import type { PluginCommandContext } from "../../plugins/types.js";
import type { SkillCommandSpec } from "../../skills/types.js";
import type { MsgContext } from "../templating.js";
import type {
  ElevatedLevel,
  ReasoningLevel,
  ThinkLevel,
  ThinkingCatalogEntry,
  VerboseLevel,
} from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { TypingController } from "./typing.js";

/** Normalized command metadata derived from an inbound message. */
export type CommandContext = {
  surface: string;
  channel: string;
  channelId?: ChannelId;
  accountId?: string;
  ownerList: string[];
  senderIsOwner: boolean;
  isAuthorizedSender: boolean;
  senderId?: string;
  abortKey?: string;
  rawBodyNormalized: string;
  commandBodyNormalized: string;
  from?: string;
  to?: string;
  /** Internal marker to prevent duplicate reset-hook emission across command pipelines. */
  resetHookTriggered?: boolean;
  /** Internal marker for prompt reload without session rollover. */
  softResetTriggered?: boolean;
  /** Optional tail to append after a soft reset startup prompt. */
  softResetTail?: string;
};

/** Full input object passed to each command handler. */
export type HandleCommandsParams = {
  ctx: MsgContext;
  rootCtx?: MsgContext;
  cfg: OpenClawConfig;
  command: CommandContext;
  agentId: string;
  agentDir?: string;
  directives: InlineDirectives;
  elevated: {
    enabled: boolean;
    allowed: boolean;
    failures: Array<{ gate: string; key: string }>;
  };
  sessionEntry?: SessionEntry;
  /** Snapshot captured before command handlers mutate the active entry. */
  initialSessionEntry?: SessionEntry;
  /** True only when the current command owns first creation of this session row. */
  allowCreateSessionEntry?: boolean;
  previousSessionEntry?: SessionEntry;
  previousSessionMemory?: SessionMemoryTranscript;
  previousSessionResetMessages?: unknown[];
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  sessionScope?: SessionScope;
  workspaceDir: string;
  opts?: InternalGetReplyOptions;
  defaultGroupActivation: () => "always" | "mention";
  /** Catalog snapshot prepared by model selection for status rendering. */
  thinkingCatalog?: ThinkingCatalogEntry[];
  resolvedThinkLevel?: ThinkLevel;
  resolvedFastMode?: FastMode;
  resolvedVerboseLevel: VerboseLevel;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel?: ElevatedLevel;
  blockReplyChunking?: BlockReplyChunking;
  resolvedBlockStreamingBreak?: "text_end" | "message_end";
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
  provider: string;
  model: string;
  contextTokens: number;
  isGroup: boolean;
  skillCommands?: SkillCommandSpec[];
  loadSkillCommands?: () => Promise<SkillCommandSpec[]>;
  typing?: TypingController;
  /** Invocation authority for host-bound plugin command capabilities. */
  commandInvocationSignal?: AbortSignal;
  /** Session generation captured when a host-bound compaction capability was admitted. */
  compactionSessionEntry?: SessionEntry;
};

/** Result returned by a command handler. */
export type CommandHandlerResult = {
  reply?: ReplyPayload;
  /** Turn-local queue override requested by an authorized continuation command. */
  queueModeOverride?: QueueMode;
  sessionCompaction?: Awaited<
    ReturnType<NonNullable<NonNullable<PluginCommandContext["runtimeContext"]>["compactCurrent"]>>
  >;
  shouldContinue: boolean;
};

/** Command handler function shape. */
export type CommandHandler = (
  params: HandleCommandsParams,
  allowTextCommands: boolean,
) => Promise<CommandHandlerResult | null>;
