// Agent Core module implements branch summarization behavior.
import type { Model, StreamFn } from "@openclaw/llm-core";
import {
  type AgentCoreCompletionRuntimeDeps,
  resolveAgentCoreCompleteFn,
} from "../../runtime-deps.js";
import type { AgentMessage } from "../../types.js";
import {
  asAgentMessage,
  convertToLlm,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
} from "../messages.js";
import type { BranchSummaryResult, SessionTreeEntry } from "../types.js";
import { BranchSummaryError, err, ok, type Result } from "../types.js";
import { estimateTokens, SUMMARIZATION_SYSTEM_PROMPT } from "./compaction.js";
import {
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessage,
  type FileOperations,
  formatFileOperations,
  serializeConversation,
} from "./utils.js";

/** File-operation details stored on generated branch summary entries. */
export interface BranchSummaryDetails {
  /** Files read while exploring the summarized branch. */
  readFiles: string[];
  /** Files modified while exploring the summarized branch. */
  modifiedFiles: string[];
}

/** Prepared branch content for summarization. */
export interface BranchPreparation {
  /** Messages selected for the branch summary. */
  messages: AgentMessage[];
  /** File operations extracted from the branch. */
  fileOps: FileOperations;
  /** Estimated token count for selected messages. */
  totalTokens: number;
}

/** Minimal tree entry shape needed to compare two session branches. */
export interface BranchPathEntry {
  /** Stable entry id. */
  id: string;
  /** Parent entry id, or null for the session root. */
  parentId: string | null;
}

/** Branch entries selected after comparing old and target paths. */
export interface CollectBranchPathEntriesResult<TEntry extends BranchPathEntry> {
  /** Entries to summarize in chronological order. */
  entries: TEntry[];
  /** Deepest common ancestor between the previous leaf and target entry. */
  commonAncestorId: string | null;
}

/** Options for generating a branch summary. */
interface GenerateBranchSummaryOptions {
  /** Model used for summarization. */
  model: Model;
  /** API key forwarded to the provider. */
  apiKey: string;
  /** Optional request headers forwarded to the provider. */
  headers?: Record<string, string>;
  /** Abort signal for the summarization request. */
  signal: AbortSignal;
  /** Runtime used to complete the summarization request. */
  runtime?: AgentCoreCompletionRuntimeDeps;
  /** Optional stream implementation used instead of the runtime complete function. */
  streamFn?: StreamFn;
  /** Optional instructions appended to or replacing the default prompt. */
  customInstructions?: string;
  /** Replace the default prompt with custom instructions instead of appending them. */
  replaceInstructions?: boolean;
  /** Tokens reserved for prompt and model output. Defaults to 16384. */
  reserveTokens?: number;
}

/** Collect entries that should be summarized before navigating to a different session tree entry. */
export function collectEntriesForBranchSummaryFromBranches<TEntry extends BranchPathEntry>(
  oldBranch: readonly TEntry[],
  targetBranch: readonly TEntry[],
): CollectBranchPathEntriesResult<TEntry> {
  const oldPath = new Set(oldBranch.map((entry) => entry.id));
  let commonAncestorId: string | null = null;
  for (const targetEntry of targetBranch.toReversed()) {
    if (oldPath.has(targetEntry.id)) {
      commonAncestorId = targetEntry.id;
      break;
    }
  }

  const firstSummarizedIndex =
    commonAncestorId === null
      ? 0
      : oldBranch.findIndex((entry) => entry.id === commonAncestorId) + 1;
  return { entries: oldBranch.slice(firstSummarizedIndex), commonAncestorId };
}

function getMessageFromEntry(entry: SessionTreeEntry): AgentMessage | undefined {
  switch (entry.type) {
    case "message":
      if (entry.message.role === "toolResult") {
        return undefined;
      }
      return entry.message;

    case "custom_message":
      return asAgentMessage(
        createCustomMessage(
          entry.customType,
          entry.content,
          entry.display,
          entry.details,
          entry.timestamp,
        ),
      );

    case "branch_summary":
      return asAgentMessage(
        createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp),
      );

    case "compaction":
      return asAgentMessage(
        createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
      );
    case "thinking_level_change":
    case "model_change":
    case "custom":
    case "label":
    case "session_info":
    case "leaf":
      return undefined;
  }
  return undefined;
}

/** Prepare branch entries for summarization within an optional token budget. */
export function prepareBranchEntries(
  entries: SessionTreeEntry[],
  tokenBudget = 0,
): BranchPreparation {
  const messages: AgentMessage[] = [];
  const fileOps = createFileOps();
  let totalTokens = 0;
  for (const entry of entries) {
    if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
      const details = entry.details as BranchSummaryDetails;
      if (Array.isArray(details.readFiles)) {
        for (const f of details.readFiles) {
          fileOps.read.add(f);
        }
      }
      if (Array.isArray(details.modifiedFiles)) {
        for (const f of details.modifiedFiles) {
          fileOps.edited.add(f);
        }
      }
    }
  }
  for (const entry of entries.toReversed()) {
    const message = getMessageFromEntry(entry);
    if (!message) {
      continue;
    }
    extractFileOpsFromMessage(message, fileOps);

    const tokens = estimateTokens(message);
    if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
      // Prefer already-compressed summaries when the budget is almost filled; they
      // preserve older branch context better than dropping the whole prefix.
      if (entry.type === "compaction" || entry.type === "branch_summary") {
        if (totalTokens < tokenBudget * 0.9) {
          messages.unshift(message);
          totalTokens += tokens;
        }
      }
      break;
    }

    messages.unshift(message);
    totalTokens += tokens;
  }

  return { messages, fileOps, totalTokens };
}

const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Generate a summary for abandoned branch entries. */
export async function generateBranchSummary(
  entries: SessionTreeEntry[],
  options: GenerateBranchSummaryOptions,
): Promise<Result<BranchSummaryResult, BranchSummaryError>> {
  const {
    model,
    apiKey,
    headers,
    signal,
    customInstructions,
    replaceInstructions,
    reserveTokens = 16384,
  } = options;
  const contextWindow = model.contextWindow || 128000;
  const tokenBudget = contextWindow - reserveTokens;

  const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

  if (messages.length === 0) {
    return ok({ summary: "No content to summarize", readFiles: [], modifiedFiles: [] });
  }
  const llmMessages = convertToLlm(messages);
  const conversationText = serializeConversation(llmMessages);
  let instructions: string;
  if (replaceInstructions && customInstructions) {
    instructions = customInstructions;
  } else if (customInstructions) {
    instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
  } else {
    instructions = BRANCH_SUMMARY_PROMPT;
  }
  const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

  const summarizationMessages = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: promptText }],
      timestamp: Date.now(),
    },
  ];
  const context = { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages };
  const streamOptions = { apiKey, headers, signal, maxTokens: 2048 };
  const response = options.streamFn
    ? await (await options.streamFn(model, context, streamOptions)).result()
    : await resolveAgentCoreCompleteFn(options.runtime)(model, context, streamOptions);
  if (response.stopReason === "aborted") {
    return err(
      new BranchSummaryError("aborted", response.errorMessage || "Branch summary aborted"),
    );
  }
  if (response.stopReason === "error") {
    return err(
      new BranchSummaryError(
        "summarization_failed",
        `Branch summary failed: ${response.errorMessage || "Unknown error"}`,
      ),
    );
  }

  let summary = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  summary = BRANCH_SUMMARY_PREAMBLE + summary;
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);

  return ok({
    summary: summary || "No summary generated",
    readFiles,
    modifiedFiles,
  });
}
