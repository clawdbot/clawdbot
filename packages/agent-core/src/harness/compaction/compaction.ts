// Agent Core module implements compaction behavior.
import {
  resolveClaudeFable5ModelIdentity,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StreamFn,
  type Usage,
} from "../../../../llm-core/src/index.js";
import { resolveAgentReasoningOption } from "../../reasoning.js";
import {
  type AgentCoreCompletionRuntimeDeps,
  resolveAgentCoreCompleteFn,
} from "../../runtime-deps.js";
import type { AgentMessage, ThinkingLevel } from "../../types.js";
import {
  asAgentMessage,
  convertToLlm,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
  type HarnessMessage,
} from "../messages.js";
import { buildSessionContext } from "../session/session.js";
import {
  type CompactionEntry,
  CompactionError,
  err,
  ok,
  type Result,
  type SessionTreeEntry,
} from "../types.js";
import {
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessage,
  type FileOperations,
  formatFileOperations,
  getCompactionContentBlockText,
  serializeConversation,
} from "./utils.js";

/** File-operation details stored on generated compaction entries. */
export interface CompactionDetails {
  /** Files read in the compacted history. */
  readFiles: string[];
  /** Files modified in the compacted history. */
  modifiedFiles: string[];
}
function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function extractFileOperations(
  messages: AgentMessage[],
  entries: SessionTreeEntry[],
  prevCompactionIndex: number,
): FileOperations {
  const fileOps = createFileOps();
  if (prevCompactionIndex >= 0) {
    const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
    if (!prevCompaction.fromHook && prevCompaction.details) {
      const details = prevCompaction.details as CompactionDetails;
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
  for (const msg of messages) {
    extractFileOpsFromMessage(msg, fileOps);
  }

  return fileOps;
}
function getMessageFromEntry(entry: SessionTreeEntry): AgentMessage | undefined {
  if (entry.type === "message") {
    return entry.message;
  }
  if (entry.type === "custom_message") {
    return asAgentMessage(
      createCustomMessage(
        entry.customType,
        entry.content,
        entry.display,
        entry.details,
        entry.timestamp,
      ),
    );
  }
  if (entry.type === "branch_summary") {
    return asAgentMessage(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
  }
  if (entry.type === "compaction") {
    return asAgentMessage(
      createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
    );
  }
  return undefined;
}

function getMessageFromEntryForCompaction(entry: SessionTreeEntry): AgentMessage | undefined {
  if (entry.type === "compaction") {
    return undefined;
  }
  return getMessageFromEntry(entry);
}

/** Generated compaction data ready to be persisted as a compaction entry. */
export interface CompactionResult<T = unknown> {
  /** Summary text that replaces compacted history in future context. */
  summary: string;
  /** Entry id where retained history starts. */
  firstKeptEntryId: string;
  /** Estimated context tokens before compaction. */
  tokensBefore: number;
  /** Optional implementation-specific details stored with the compaction entry. */
  details?: T;
}

/** Compaction thresholds and retention settings. */
export interface CompactionSettings {
  /** Enable automatic compaction decisions. */
  enabled: boolean;
  /** Tokens reserved for summary prompt and output. */
  reserveTokens: number;
  /** Approximate recent-context tokens to keep after compaction. */
  keepRecentTokens: number;
}

/** Default compaction settings used by the harness. */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
  if (usage.contextUsage?.state === "available") {
    return usage.contextUsage.totalTokens;
  }
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
  if (msg.role === "assistant" && "usage" in msg) {
    const assistantMsg = msg;
    if (
      assistantMsg.stopReason !== "aborted" &&
      assistantMsg.stopReason !== "error" &&
      assistantMsg.usage
    ) {
      return assistantMsg.usage;
    }
  }
  return undefined;
}

/** Return usage from the last successful assistant message in session entries. */
export function getLastAssistantUsage(entries: SessionTreeEntry[]): Usage | undefined {
  for (const entry of entries.toReversed()) {
    if (entry.type === "message") {
      const usage = getAssistantUsage(entry.message);
      if (usage) {
        return usage;
      }
    }
  }
  return undefined;
}

/** Estimated context-token usage for a message list. */
export interface ContextUsageEstimate {
  /** Estimated total context tokens. */
  tokens: number;
  /** Tokens reported by the most recent assistant usage block. */
  usageTokens: number;
  /** Estimated tokens not covered by usable provider usage. */
  trailingTokens: number;
  /** Index of the message that provided usage, or null when none exists. */
  lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(
  messages: AgentMessage[],
): { usage: Usage; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages.at(i);
    if (!message) {
      continue;
    }
    const usage = getAssistantUsage(message);
    if (usage && usage.contextUsage?.state !== "unavailable") {
      return { usage, index: i };
    }
  }
  return undefined;
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
  const usageInfo = getLastAssistantUsageInfo(messages);

  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) {
      estimated += estimateTokens(message);
    }
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null,
    };
  }

  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (const message of messages.slice(usageInfo.index + 1)) {
    trailingTokens += estimateTokens(message);
  }

  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: usageInfo.index,
  };
}

/** Return whether context usage exceeds the configured compaction threshold. */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) {
    return false;
  }
  return contextTokens > contextWindow - settings.reserveTokens;
}

const IMAGE_BLOCK_CHARS = 4800;

function countContentBlockChars(
  content: Array<{ type: string; content?: unknown; text?: string }>,
): number {
  let chars = 0;
  for (const block of content) {
    if (block.type === "image") {
      chars += IMAGE_BLOCK_CHARS;
    } else {
      chars += getCompactionContentBlockText(block).length;
    }
  }
  return chars;
}

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: AgentMessage): number {
  let chars = 0;
  const harnessMessage = message as HarnessMessage;

  switch (harnessMessage.role) {
    case "user": {
      const content = (
        harnessMessage as { content: string | Array<{ type: string; text?: string }> }
      ).content;
      if (typeof content === "string") {
        chars = content.length;
      } else if (Array.isArray(content)) {
        chars = countContentBlockChars(content);
      }
      return Math.ceil(chars / 4);
    }
    case "assistant": {
      const assistant = harnessMessage;
      for (const block of assistant.content) {
        if (block.type === "text") {
          chars += block.text.length;
        } else if (block.type === "thinking") {
          chars += block.thinking.length;
        } else if (block.type === "toolCall") {
          chars += block.name.length + safeJsonStringify(block.arguments).length;
        }
      }
      return Math.ceil(chars / 4);
    }
    case "custom":
    case "toolResult": {
      if (typeof harnessMessage.content === "string") {
        chars = harnessMessage.content.length;
      } else {
        chars = countContentBlockChars(harnessMessage.content);
      }
      return Math.ceil(chars / 4);
    }
    case "bashExecution": {
      chars = harnessMessage.command.length + harnessMessage.output.length;
      return Math.ceil(chars / 4);
    }
    case "branchSummary":
    case "compactionSummary": {
      chars = harnessMessage.summary.length;
      return Math.ceil(chars / 4);
    }
  }

  return 0;
}
function findValidCutPoints(
  entries: SessionTreeEntry[],
  startIndex: number,
  endIndex: number,
): number[] {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    switch (entry.type) {
      case "message": {
        const role = (entry.message as HarnessMessage).role;
        switch (role) {
          case "bashExecution":
          case "custom":
          case "branchSummary":
          case "compactionSummary":
          case "user":
          case "assistant":
            cutPoints.push(i);
            break;
          case "toolResult":
            break;
        }
        break;
      }
      case "thinking_level_change":
      case "model_change":
      case "compaction":
      case "branch_summary":
      case "custom":
      case "custom_message":
      case "label":
      case "session_info":
      case "leaf":
        break;
    }
    if (entry.type === "branch_summary" || entry.type === "custom_message") {
      cutPoints.push(i);
    }
  }
  return cutPoints;
}

/** Find the user-visible message that starts the turn containing an entry. */
export function findTurnStartIndex(
  entries: SessionTreeEntry[],
  entryIndex: number,
  startIndex: number,
): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    if (entry.type === "branch_summary" || entry.type === "custom_message") {
      return i;
    }
    if (entry.type === "message") {
      const role = (entry.message as HarnessMessage).role;
      if (role === "user" || role === "bashExecution") {
        return i;
      }
    }
  }
  return -1;
}

/** Cut point selected for compaction. */
interface CutPointResult {
  /** Index of the first entry retained after compaction. */
  firstKeptEntryIndex: number;
  /** Index of the turn-start entry when the cut splits a turn, otherwise -1. */
  turnStartIndex: number;
  /** Whether the selected cut point splits an in-progress turn. */
  isSplitTurn: boolean;
}

/** Find the compaction cut point that keeps approximately the requested recent-token budget. */
export function findCutPoint(
  entries: SessionTreeEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPointResult {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }
  let accumulatedTokens = 0;
  const firstCutIndex = cutPoints.at(0);
  if (firstCutIndex === undefined) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }
  let cutIndex = firstCutIndex;

  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== "message") {
      continue;
    }
    const messageTokens = estimateTokens(entry.message);
    accumulatedTokens += messageTokens;
    if (accumulatedTokens >= keepRecentTokens) {
      const lastCutIndex = cutPoints.at(-1);
      if (lastCutIndex === undefined) {
        throw new Error("compaction cut-point list became empty during selection");
      }
      cutIndex = lastCutIndex;
      for (const cutPoint of cutPoints) {
        if (cutPoint >= i) {
          cutIndex = cutPoint;
          break;
        }
      }
      break;
    }
  }
  while (cutIndex > startIndex) {
    const prevEntry = entries[cutIndex - 1];
    if (!prevEntry) {
      break;
    }
    if (prevEntry.type === "compaction") {
      break;
    }
    if (prevEntry.type === "message") {
      break;
    }
    cutIndex--;
  }
  const cutEntry = entries[cutIndex];
  if (!cutEntry) {
    throw new Error("compaction cut point does not reference a session entry");
  }
  const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
  const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isUserMessage && turnStartIndex !== -1,
  };
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

function createSummarizationOptions(
  model: Model,
  maxTokens: number,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
  thinkingLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
  const options: SimpleStreamOptions = { maxTokens, signal, apiKey, headers };
  const fableReasoning =
    (model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") &&
    resolveClaudeFable5ModelIdentity(model) !== undefined;
  if ((model.reasoning || fableReasoning) && thinkingLevel) {
    options.reasoning = resolveAgentReasoningOption(model, thinkingLevel);
  }
  return options;
}

async function completeSummarization(
  model: Model,
  context: Context,
  options: SimpleStreamOptions,
  streamFn?: StreamFn,
  runtime?: AgentCoreCompletionRuntimeDeps,
): Promise<AssistantMessage> {
  if (streamFn) {
    return (await streamFn(model, context, options)).result();
  }
  return await resolveAgentCoreCompleteFn(runtime)(model, context, options);
}

/** Runs one summarization completion and maps abort/error stops to CompactionError. */
async function runSummarizationCompletion(params: {
  promptText: string;
  model: Model;
  maxTokens: number;
  apiKey: string | undefined;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
  streamFn?: StreamFn;
  runtime?: AgentCoreCompletionRuntimeDeps;
  errorLabel: string;
}): Promise<Result<string, CompactionError>> {
  const summarizationMessages = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: params.promptText }],
      timestamp: Date.now(),
    },
  ];

  const response = await completeSummarization(
    params.model,
    { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
    createSummarizationOptions(
      params.model,
      params.maxTokens,
      params.apiKey,
      params.headers,
      params.signal,
      params.thinkingLevel,
    ),
    params.streamFn,
    params.runtime,
  );
  if (response.stopReason === "aborted") {
    return err(
      new CompactionError("aborted", response.errorMessage || `${params.errorLabel} aborted`),
    );
  }
  if (response.stopReason === "error") {
    return err(
      new CompactionError(
        "summarization_failed",
        `${params.errorLabel} failed: ${response.errorMessage || "Unknown error"}`,
      ),
    );
  }

  return ok(
    response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n"),
  );
}

/** Generate or update a conversation summary for compaction. */
export async function generateSummary(
  currentMessages: AgentMessage[],
  model: Model,
  reserveTokens: number,
  apiKey: string | undefined,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
  runtime?: AgentCoreCompletionRuntimeDeps,
): Promise<Result<string, CompactionError>> {
  const maxTokens = Math.min(
    Math.floor(0.8 * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
  }
  const llmMessages = convertToLlm(currentMessages);
  const conversationText = serializeConversation(llmMessages);
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;

  return await runSummarizationCompletion({
    promptText,
    model,
    maxTokens,
    apiKey,
    headers,
    signal,
    thinkingLevel,
    streamFn,
    runtime,
    errorLabel: "Summarization",
  });
}

/** Prepared inputs for a compaction run. */
export interface CompactionPreparation {
  /** Entry id where retained history starts. */
  firstKeptEntryId: string;
  /** Messages summarized into the history summary. */
  messagesToSummarize: AgentMessage[];
  /** Prefix messages summarized separately when compaction splits a turn. */
  turnPrefixMessages: AgentMessage[];
  /** Whether compaction splits a turn. */
  isSplitTurn: boolean;
  /** Estimated context tokens before compaction. */
  tokensBefore: number;
  /** Previous compaction summary used for iterative updates. */
  previousSummary?: string;
  /** File operations extracted from summarized history. */
  fileOps: FileOperations;
  /** Settings used to prepare compaction. */
  settings: CompactionSettings;
}

/** Prepare session entries for compaction, or return undefined when compaction is not applicable. */
export function prepareCompaction(
  pathEntries: SessionTreeEntry[],
  settings: CompactionSettings,
): Result<CompactionPreparation | undefined, CompactionError> {
  if (pathEntries.at(-1)?.type === "compaction" || pathEntries.length === 0) {
    return ok(undefined);
  }

  let prevCompactionIndex = -1;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    if (pathEntries.at(i)?.type === "compaction") {
      prevCompactionIndex = i;
      break;
    }
  }

  let previousSummary: string | undefined;
  let boundaryStart = 0;
  if (prevCompactionIndex >= 0) {
    const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
    previousSummary = prevCompaction.summary;
    const firstKeptEntryIndex = pathEntries.findIndex(
      (entry) => entry.id === prevCompaction.firstKeptEntryId,
    );
    boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
  }
  const boundaryEnd = pathEntries.length;

  const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

  const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
  const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) {
    return err(
      new CompactionError(
        "invalid_session",
        "First kept entry has no UUID - session may need migration",
      ),
    );
  }
  const firstKeptEntryId = firstKeptEntry.id;

  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  const messagesToSummarize: AgentMessage[] = [];
  for (let i = boundaryStart; i < historyEnd; i++) {
    const entry = pathEntries.at(i);
    const msg = entry ? getMessageFromEntryForCompaction(entry) : undefined;
    if (msg) {
      messagesToSummarize.push(msg);
    }
  }
  const turnPrefixMessages: AgentMessage[] = [];
  if (cutPoint.isSplitTurn) {
    for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
      const entry = pathEntries.at(i);
      const msg = entry ? getMessageFromEntryForCompaction(entry) : undefined;
      if (msg) {
        turnPrefixMessages.push(msg);
      }
    }
  }
  const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
  if (cutPoint.isSplitTurn) {
    for (const msg of turnPrefixMessages) {
      extractFileOpsFromMessage(msg, fileOps);
    }
  }

  return ok({
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,
    settings,
  });
}

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

export { serializeConversation } from "./utils.js";

/** Generate compaction summary data from prepared session history. */
export async function compact(
  preparation: CompactionPreparation,
  model: Model,
  apiKey: string | undefined,
  headers?: Record<string, string>,
  customInstructions?: string,
  signal?: AbortSignal,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
  runtime?: AgentCoreCompletionRuntimeDeps,
): Promise<Result<CompactionResult, CompactionError>> {
  const {
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,
    settings,
  } = preparation;

  if (!firstKeptEntryId) {
    return err(
      new CompactionError(
        "invalid_session",
        "First kept entry has no UUID - session may need migration",
      ),
    );
  }

  let summary: string;

  if (isSplitTurn && turnPrefixMessages.length > 0) {
    const historyResult =
      messagesToSummarize.length > 0
        ? await generateSummary(
            messagesToSummarize,
            model,
            settings.reserveTokens,
            apiKey,
            headers,
            signal,
            customInstructions,
            previousSummary,
            thinkingLevel,
            streamFn,
            runtime,
          )
        : ok<string, CompactionError>("No prior history.");
    if (!historyResult.ok) {
      return err(historyResult.error);
    }
    const turnPrefixResult = await generateTurnPrefixSummary(
      turnPrefixMessages,
      model,
      settings.reserveTokens,
      apiKey,
      headers,
      signal,
      thinkingLevel,
      streamFn,
      runtime,
    );
    if (!turnPrefixResult.ok) {
      return err(turnPrefixResult.error);
    }
    summary = `${historyResult.value}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.value}`;
  } else {
    const summaryResult = await generateSummary(
      messagesToSummarize,
      model,
      settings.reserveTokens,
      apiKey,
      headers,
      signal,
      customInstructions,
      previousSummary,
      thinkingLevel,
      streamFn,
      runtime,
    );
    if (!summaryResult.ok) {
      return err(summaryResult.error);
    }
    summary = summaryResult.value;
  }

  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);

  return ok({
    summary,
    firstKeptEntryId,
    tokensBefore,
    details: { readFiles, modifiedFiles } as CompactionDetails,
  });
}
async function generateTurnPrefixSummary(
  messages: AgentMessage[],
  model: Model,
  reserveTokens: number,
  apiKey: string | undefined,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
  runtime?: AgentCoreCompletionRuntimeDeps,
): Promise<Result<string, CompactionError>> {
  const maxTokens = Math.min(
    Math.floor(0.5 * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  const llmMessages = convertToLlm(messages);
  const conversationText = serializeConversation(llmMessages);
  const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
  return await runSummarizationCompletion({
    promptText,
    model,
    maxTokens,
    apiKey,
    headers,
    signal,
    thinkingLevel,
    streamFn,
    runtime,
    errorLabel: "Turn prefix summarization",
  });
}
