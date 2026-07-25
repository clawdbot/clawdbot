/**
 * Slim context-usage breakdown for session rows and the chat composer ring.
 *
 * Category math mirrors context-treemap dedupe so skills / workspace files are
 * not double-counted inside the system prompt bucket.
 */
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import {
  countTextTokens,
  countTokensFromChars,
  resolveTokenEncoding,
  type TokenEncodingName,
} from "./token-counter.js";

export const CONTEXT_USAGE_CATEGORY_IDS = [
  "system",
  "tools",
  "rules",
  "skills",
  "mcpTools",
  "summaries",
  "conversation",
] as const;

export type ContextUsageCategoryId = (typeof CONTEXT_USAGE_CATEGORY_IDS)[number];

export type ContextUsageCategory = {
  id: ContextUsageCategoryId;
  tokens: number;
};

export type ContextUsageBreakdown = {
  categories: ContextUsageCategory[];
  totalTokens: number;
  estimatedAt: number;
  approximate: boolean;
  encoding: TokenEncodingName;
};

export type ConversationCharTotals = {
  user: number;
  assistant: number;
  toolResults: number;
  summaries: number;
  other: number;
  runtimeContext: number;
  modelOnlyPrompt: number;
};

export type ToolReportEntry = SessionSystemPromptReport["tools"]["entries"][number] & {
  source?: string | null;
};

function tokensForChars(
  chars: number,
  encoding: TokenEncodingName,
  preferCharFallback: boolean,
): { tokens: number; approximate: boolean } {
  if (chars <= 0) {
    return { tokens: 0, approximate: false };
  }
  // Report buckets store chars only; without source text we use the CJK-aware
  // char heuristic. Conversation paths pass real text into countTextTokens.
  if (preferCharFallback) {
    return countTokensFromChars(chars, { encoding });
  }
  return countTokensFromChars(chars, { encoding });
}

function isMcpToolEntry(entry: ToolReportEntry): boolean {
  const source = (entry.source ?? "").trim().toLowerCase();
  if (source === "mcp" || source === "bundle-mcp" || source.includes("mcp")) {
    return true;
  }
  const name = entry.name.trim().toLowerCase();
  return name.startsWith("mcp_") || name.startsWith("mcp__");
}

/** Build treemap-safe category token totals from a system prompt report + conversation chars. */
export function buildContextUsageBreakdown(params: {
  report: SessionSystemPromptReport | null | undefined;
  conversation?: ConversationCharTotals | null;
  provider?: string | null;
  model?: string | null;
  encodingOverride?: string | null;
  estimatedAt?: number;
  /**
   * Optional already-tokenized overrides when callers have real text (e.g.
   * conversation messages counted via countTextTokens).
   */
  conversationTokenOverrides?: Partial<Record<"summaries" | "conversation", number>> | null;
}): ContextUsageBreakdown {
  const resolved = resolveTokenEncoding({
    provider: params.provider ?? params.report?.provider,
    model: params.model ?? params.report?.model,
    encodingOverride: params.encodingOverride,
  });
  const encoding = resolved.encoding;
  let approximate = resolved.approximate;

  const report = params.report;
  const injectedTotal =
    report?.injectedWorkspaceFiles.reduce((sum, file) => sum + file.injectedChars, 0) ?? 0;
  const projectContextChars = report?.systemPrompt.projectContextChars ?? 0;
  const projectFrameChars = Math.max(0, projectContextChars - injectedTotal);
  const skillTotal =
    report?.skills.entries.reduce((sum, skill) => sum + skill.blockChars, 0) ??
    report?.skills.promptChars ??
    0;
  const systemBaseChars = Math.max(
    0,
    (report?.systemPrompt.nonProjectContextChars ?? 0) - skillTotal,
  );
  const rulesChars = injectedTotal + projectFrameChars;

  const toolEntries = (report?.tools.entries ?? []) as ToolReportEntry[];
  let toolsChars = 0;
  let mcpToolsChars = 0;
  for (const entry of toolEntries) {
    const chars = (entry.schemaChars ?? 0) + (entry.summaryChars ?? 0);
    if (isMcpToolEntry(entry)) {
      mcpToolsChars += chars;
    } else {
      toolsChars += chars;
    }
  }
  if (toolEntries.length === 0 && report) {
    toolsChars = (report.tools.listChars ?? 0) + (report.tools.schemaChars ?? 0);
  }

  const estimate = report?.promptTokenEstimate;
  const systemCounted = estimate
    ? { tokens: estimate.system, approximate: estimate.approximate }
    : tokensForChars(systemBaseChars, encoding, true);
  const toolsCounted = estimate
    ? { tokens: estimate.tools, approximate: estimate.approximate }
    : tokensForChars(toolsChars, encoding, true);
  const rulesCounted = estimate
    ? { tokens: estimate.rules, approximate: estimate.approximate }
    : tokensForChars(rulesChars, encoding, true);
  const skillsCounted = estimate
    ? { tokens: estimate.skills, approximate: estimate.approximate }
    : tokensForChars(skillTotal, encoding, true);
  const mcpCounted = estimate
    ? { tokens: estimate.mcpTools, approximate: estimate.approximate }
    : tokensForChars(mcpToolsChars, encoding, true);
  if (estimate?.encoding === "cl100k_base" || estimate?.encoding === "o200k_base") {
    // Prefer the encoding used when the prompt was assembled.
  }
  approximate =
    approximate ||
    Boolean(estimate?.approximate) ||
    systemCounted.approximate ||
    toolsCounted.approximate ||
    rulesCounted.approximate ||
    skillsCounted.approximate ||
    mcpCounted.approximate;

  const convo = params.conversation;
  const summaryChars = convo?.summaries ?? 0;
  const conversationChars =
    (convo?.user ?? 0) +
    (convo?.assistant ?? 0) +
    (convo?.toolResults ?? 0) +
    (convo?.other ?? 0) +
    (convo?.runtimeContext ?? 0) +
    (convo?.modelOnlyPrompt ?? 0);

  let summariesTokens = params.conversationTokenOverrides?.summaries;
  let conversationTokens = params.conversationTokenOverrides?.conversation;
  if (summariesTokens === undefined) {
    const counted = tokensForChars(summaryChars, encoding, true);
    summariesTokens = counted.tokens;
    approximate = approximate || counted.approximate;
  }
  if (conversationTokens === undefined) {
    const counted = tokensForChars(conversationChars, encoding, true);
    conversationTokens = counted.tokens;
    approximate = approximate || counted.approximate;
  }

  const categories: ContextUsageCategory[] = (
    [
      { id: "system", tokens: systemCounted.tokens },
      { id: "tools", tokens: toolsCounted.tokens },
      { id: "rules", tokens: rulesCounted.tokens },
      { id: "skills", tokens: skillsCounted.tokens },
      { id: "mcpTools", tokens: mcpCounted.tokens },
      { id: "summaries", tokens: summariesTokens },
      { id: "conversation", tokens: conversationTokens },
    ] as const
  ).filter((category) => category.tokens > 0);

  const totalTokens = categories.reduce((sum, category) => sum + category.tokens, 0);
  return {
    categories,
    totalTokens,
    estimatedAt: params.estimatedAt ?? Date.now(),
    approximate,
    encoding,
  };
}

/** Aggregate role char totals from transcript messages (same buckets as /context map). */
export function accumulateConversationCharTotals(
  messages: Array<{ role?: string }>,
  estimateChars: (message: { role?: string }) => number,
  extras?: { runtimeContextChars?: number; modelOnlyPromptChars?: number },
): ConversationCharTotals {
  const totals: ConversationCharTotals = {
    user: 0,
    assistant: 0,
    toolResults: 0,
    summaries: 0,
    other: 0,
    runtimeContext: Math.max(0, extras?.runtimeContextChars ?? 0),
    modelOnlyPrompt: Math.max(0, extras?.modelOnlyPromptChars ?? 0),
  };
  for (const message of messages) {
    const chars = estimateChars(message);
    if (chars <= 0) {
      continue;
    }
    const role = message.role;
    if (role === "user") {
      totals.user += chars;
    } else if (role === "assistant") {
      totals.assistant += chars;
    } else if (role === "toolResult") {
      totals.toolResults += chars;
    } else if (role === "branchSummary" || role === "compactionSummary") {
      totals.summaries += chars;
    } else {
      totals.other += chars;
    }
  }
  return totals;
}

/** Tokenize conversation messages with the real encoder when message text is available. */
export function countConversationTokensFromMessages(params: {
  messages: Array<{ role?: string }>;
  extractText: (message: { role?: string }) => string;
  encoding: TokenEncodingName;
  extras?: { runtimeContextChars?: number; modelOnlyPromptChars?: number };
}): {
  summaries: number;
  conversation: number;
  approximate: boolean;
  charTotals: ConversationCharTotals;
} {
  let summaries = 0;
  let conversation = 0;
  let approximate = false;
  const charTotals = accumulateConversationCharTotals(
    params.messages,
    (message) => params.extractText(message).length,
    params.extras,
  );

  for (const message of params.messages) {
    const text = params.extractText(message);
    if (!text) {
      continue;
    }
    const counted = countTextTokens(text, { encoding: params.encoding });
    approximate = approximate || counted.approximate;
    if (message.role === "branchSummary" || message.role === "compactionSummary") {
      summaries += counted.tokens;
    } else {
      conversation += counted.tokens;
    }
  }

  const runtimeChars =
    (params.extras?.runtimeContextChars ?? 0) + (params.extras?.modelOnlyPromptChars ?? 0);
  if (runtimeChars > 0) {
    const counted = countTokensFromChars(runtimeChars, { encoding: params.encoding });
    conversation += counted.tokens;
    approximate = true;
  }

  return { summaries, conversation, approximate, charTotals };
}
