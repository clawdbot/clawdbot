import type { ImageContent, TextContent } from "@openclaw/llm-core";
import type { AgentMessage } from "../types.js";

export { err, ok } from "@openclaw/normalization-core/result";
export type { Result } from "@openclaw/normalization-core/result";

type CompactionErrorCode = "aborted" | "summarization_failed" | "invalid_session" | "unknown";

export class CompactionError extends Error {
  public code: CompactionErrorCode;

  constructor(code: CompactionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CompactionError";
    this.code = code;
  }
}

type BranchSummaryErrorCode = "aborted" | "summarization_failed" | "invalid_session";

export class BranchSummaryError extends Error {
  public code: BranchSummaryErrorCode;

  constructor(code: BranchSummaryErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BranchSummaryError";
    this.code = code;
  }
}

interface SessionTreeEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  appendMode?: "side";
}

interface MessageEntry extends SessionTreeEntryBase {
  type: "message";
  message: AgentMessage;
}

interface ThinkingLevelChangeEntry extends SessionTreeEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

interface ModelChangeEntry extends SessionTreeEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface CompactionEntry<T = unknown> extends SessionTreeEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: T;
  fromHook?: boolean;
}

type ResetReason = "new" | "reset" | "idle" | "daily" | "cron-stale";

export interface ResetEntry extends SessionTreeEntryBase {
  type: "reset";
  reason: ResetReason;
  firstKeptEntryId?: string;
}

interface BranchSummaryEntry<T = unknown> extends SessionTreeEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: T;
  fromHook?: boolean;
}

interface CustomEntry<T = unknown> extends SessionTreeEntryBase {
  type: "custom";
  customType: string;
  data?: T;
}

interface CustomMessageEntry<T = unknown> extends SessionTreeEntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: T;
  display: boolean;
}

interface LabelEntry extends SessionTreeEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

interface SessionInfoEntry extends SessionTreeEntryBase {
  type: "session_info";
  name?: string;
}

interface LeafEntry extends SessionTreeEntryBase {
  type: "leaf";
  targetId: string | null;
  appendParentId?: string | null;
}

export type SessionTreeEntry =
  | MessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | ResetEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry
  | LeafEntry;

export interface SessionContext {
  messages: AgentMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

export interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

export interface BranchSummaryResult {
  summary: string;
  readFiles: string[];
  modifiedFiles: string[];
}
