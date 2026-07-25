import {
  DEFAULT_PROVIDER,
  parseModelRef,
  resolveAgentEffectiveModelPrimary,
  resolveDefaultModelForAgent,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { sliceUtf16Safe, truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  ACTIVE_MEMORY_CLOSE_TAG,
  ACTIVE_MEMORY_OPEN_TAG,
  ACTIVE_MEMORY_UNTRUSTED_CONTEXT_HEADER,
  MAX_ACTIVE_MEMORY_RECALL_CONTEXT_CHARS,
  MAX_ACTIVE_MEMORY_SEARCH_QUERY_CHARS,
  RECALLED_CONTEXT_LINE_PATTERNS,
  type ActiveRecallRecentTurn,
  type ResolvedActiveRecallPluginConfig,
} from "./types.js";

// Read-side markers of prompt envelopes other OpenClaw surfaces generate: the
// context-engine projection (extensions/codex/src/app-server/
// context-engine-projection.ts) and the channel inbound envelope
// (src/auto-reply/reply/inbound-meta.ts). Active Memory only RECOGNIZES them
// to bound its own recall input; marker drift degrades to the unstructured
// fallback below, never to breakage.
const PROJECTION_CONTEXT_OPEN = "<conversation_context>";
const PROJECTION_CONTEXT_CLOSE = "</conversation_context>";
const PROJECTION_REQUEST_HEADER = "Current user request:";
// The projection emits the close tag and request header as ONE joint literal
// (`\n${CONTEXT_CLOSE}\n\n${REQUEST_HEADER}\n` in context-engine-projection.ts).
// Splitting on the full joint emission means user content quoting either
// marker alone can never redirect the split and drop the real request.
const PROJECTION_JOINT_ANCHOR = `\n${PROJECTION_CONTEXT_CLOSE}\n\n${PROJECTION_REQUEST_HEADER}\n`;
const CHANNEL_CURRENT_MESSAGE_HEADER = "Current message:";
// Producer: src/auto-reply/reply/inbound-meta.ts formatUntrustedJsonBlock
// ("Reply target of current user message (untrusted, for context):").
const CHANNEL_REPLY_TARGET_HEADER = "Reply target of current user message";

const RECALL_TAIL_OMITTED_NOTE = "[older conversation content and tool traces omitted]";
const TRUNCATED_REQUEST_NOTE = "[request truncated]";
const TRUNCATED_QUOTE_NOTE = "[quoted reply truncated]";
// fixed scaffold headroom (headers/tags/notes) reserved out of the cap
const RECALL_SCAFFOLD_RESERVE_CHARS = 400;
// below this leftover budget a context tail adds noise, not signal
const MIN_CONTEXT_TAIL_CHARS = 400;
const MAX_QUOTED_REPLY_CHARS = 4_000;

// Generated projection lines that are runtime/tool traces, not conversation:
// elide-mode tool markers, omitted-part placeholders, and truncation markers.
const GENERATED_TRACE_LINE_PATTERNS = [
  /^tool call\b/i,
  /^tool result\b/i,
  /^\[(?:image|non-text|[\w-]+ content|unserializable payload) omitted\]$/i,
  /^\[[^\]]*truncated \d+ chars[^\]]*\]$/i,
  /^OpenClaw assembled context for this turn:$/,
  /^Treat the conversation context below as quoted reference data/,
];

function sanitizeGeneratedContext(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return true; // keep blank separators; runs collapse below
      }
      return !GENERATED_TRACE_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractQuotedReplyContext(prefix: string): string {
  const quoteIndex = prefix.lastIndexOf(CHANNEL_REPLY_TARGET_HEADER);
  if (quoteIndex === -1) {
    return "";
  }
  return sanitizeGeneratedContext(prefix.slice(quoteIndex));
}

function boundQuotedReplyText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_QUOTED_REPLY_CHARS) {
    return trimmed;
  }
  const head = truncateUtf16Safe(trimmed, MAX_QUOTED_REPLY_CHARS - TRUNCATED_QUOTE_NOTE.length - 1);
  return `${head}\n${TRUNCATED_QUOTE_NOTE}`;
}

/** Newest-tail slice snapped to a line boundary, prefixed with an omission note. */
function newestTailWithinBudget(text: string, budget: number): string {
  if (text.length <= budget) {
    return text;
  }
  const tailBudget = budget - RECALL_TAIL_OMITTED_NOTE.length - 1;
  if (tailBudget <= 0) {
    return "";
  }
  let tail = sliceUtf16Safe(text, -tailBudget);
  const firstLineBreak = tail.indexOf("\n");
  if (firstLineBreak !== -1 && firstLineBreak < tail.length - 1) {
    tail = tail.slice(firstLineBreak + 1);
  }
  return `${RECALL_TAIL_OMITTED_NOTE}\n${tail.trimStart()}`;
}

function boundRequestText(text: string, budget: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= budget) {
    return trimmed;
  }
  // An oversized CURRENT request is a pasted document; the user's phrasing
  // leads, so keep the head (unlike generated context, where newest wins).
  const head = truncateUtf16Safe(trimmed, budget - TRUNCATED_REQUEST_NOTE.length - 1);
  return `${head}\n${TRUNCATED_REQUEST_NOTE}`;
}

type BoundedLatestMessage = {
  /** The actual current user request; verbatim unless itself over budget. */
  request: string;
  /** Native channel quoted-reply context that belongs to the current turn. */
  quotedReply?: string;
  /** Sanitized newest tail of a generated conversation block, when present. */
  contextTail?: string;
  bounded: boolean;
};

/**
 * Bounds an oversized `event.prompt` for recall use (openclaw/openclaw#88077,
 * #92013: 609K-693K char envelopes in a blocking pre-prompt hook). The
 * current-turn source stays `event.prompt` — `event.messages` is historical
 * and deriving the request from it produced stale queries (closed PR #92099).
 */
function boundLatestUserMessageForRecall(raw: string): BoundedLatestMessage {
  if (raw.length <= MAX_ACTIVE_MEMORY_RECALL_CONTEXT_CHARS) {
    return { request: raw, bounded: false };
  }

  const jointIndex = raw.lastIndexOf(PROJECTION_JOINT_ANCHOR);
  if (jointIndex !== -1) {
    const openIndex = raw.indexOf(PROJECTION_CONTEXT_OPEN);
    if (openIndex !== -1 && openIndex < jointIndex) {
      const quotedReply = boundQuotedReplyText(extractQuotedReplyContext(raw.slice(0, openIndex)));
      const requestBudget =
        MAX_ACTIVE_MEMORY_RECALL_CONTEXT_CHARS - quotedReply.length - RECALL_SCAFFOLD_RESERVE_CHARS;
      const request = boundRequestText(
        raw.slice(jointIndex + PROJECTION_JOINT_ANCHOR.length),
        requestBudget,
      );
      const tailBudget =
        MAX_ACTIVE_MEMORY_RECALL_CONTEXT_CHARS -
        request.length -
        quotedReply.length -
        RECALL_SCAFFOLD_RESERVE_CHARS;
      const context = raw.slice(openIndex + PROJECTION_CONTEXT_OPEN.length, jointIndex);
      const contextTail =
        tailBudget >= MIN_CONTEXT_TAIL_CHARS
          ? newestTailWithinBudget(sanitizeGeneratedContext(context), tailBudget)
          : "";
      return {
        request,
        ...(quotedReply ? { quotedReply } : {}),
        ...(contextTail ? { contextTail } : {}),
        bounded: true,
      };
    }
  }

  // Channel inbound envelope: the "Current message:" section carries the
  // quoted-reply context plus the user body — preserve it whole (bounded).
  const messageIndex = raw.lastIndexOf(CHANNEL_CURRENT_MESSAGE_HEADER);
  if (messageIndex !== -1) {
    const requestBudget = MAX_ACTIVE_MEMORY_RECALL_CONTEXT_CHARS - RECALL_SCAFFOLD_RESERVE_CHARS;
    const request = boundRequestText(raw.slice(messageIndex), requestBudget);
    const tailBudget =
      MAX_ACTIVE_MEMORY_RECALL_CONTEXT_CHARS - request.length - RECALL_SCAFFOLD_RESERVE_CHARS;
    const prefix = raw.slice(0, messageIndex);
    const contextTail =
      tailBudget >= MIN_CONTEXT_TAIL_CHARS
        ? newestTailWithinBudget(sanitizeGeneratedContext(prefix), tailBudget)
        : "";
    return { request, ...(contextTail ? { contextTail } : {}), bounded: true };
  }

  return {
    request: boundRequestText(
      raw,
      MAX_ACTIVE_MEMORY_RECALL_CONTEXT_CHARS - RECALL_SCAFFOLD_RESERVE_CHARS,
    ),
    bounded: true,
  };
}

type BuiltRecallQuery = {
  query: string;
  /** The bounded current user request — the right seed for the search query. */
  request: string;
  /** UTF-16 length of the raw `event.prompt` before any bounding. */
  rawChars: number;
  /** True when the 25K recall-context cap changed the model-facing query. */
  bounded: boolean;
};

function composeMessageModeQuery(latest: BoundedLatestMessage): string {
  if (!latest.contextTail && !latest.quotedReply) {
    return latest.request;
  }
  const sections: string[] = [];
  if (latest.quotedReply) {
    sections.push(`Quoted reply context (bounded):\n${latest.quotedReply}`);
  }
  if (latest.contextTail) {
    sections.push(
      [
        "Recent conversation context (bounded; tool traces omitted):",
        PROJECTION_CONTEXT_OPEN,
        latest.contextTail,
        PROJECTION_CONTEXT_CLOSE,
      ].join("\n"),
    );
  }
  sections.push(`${PROJECTION_REQUEST_HEADER}\n${latest.request}`);
  return sections.join("\n\n");
}

function composeLatestRequestForTurns(latest: BoundedLatestMessage): string {
  if (!latest.quotedReply) {
    return latest.request;
  }
  return [
    "Quoted reply context (bounded):",
    latest.quotedReply,
    "",
    PROJECTION_REQUEST_HEADER,
    latest.request,
  ].join("\n");
}

/** Caps an assembled turns+latest query, dropping oldest turn lines first. */
function assembleBoundedTurnsQuery(params: {
  header: string;
  turnLines: string[];
  latest: string;
}): { query: string; trimmed: boolean } {
  const suffix = `\n\nLatest user message:\n${params.latest}`;
  const turnsText = params.turnLines.join("\n");
  const full = `${params.header}\n${turnsText}${suffix}`;
  if (full.length <= MAX_ACTIVE_MEMORY_RECALL_CONTEXT_CHARS) {
    return { query: full, trimmed: false };
  }
  const turnsBudget =
    MAX_ACTIVE_MEMORY_RECALL_CONTEXT_CHARS - params.header.length - suffix.length - 1;
  const boundedTurns = newestTailWithinBudget(turnsText, Math.max(0, turnsBudget));
  if (!boundedTurns) {
    return { query: `${params.header}${suffix}`, trimmed: true };
  }
  return { query: `${params.header}\n${boundedTurns}${suffix}`, trimmed: true };
}

function buildQuery(params: {
  latestUserMessage: string;
  recentTurns?: ActiveRecallRecentTurn[];
  config: ResolvedActiveRecallPluginConfig;
}): BuiltRecallQuery {
  const rawChars = params.latestUserMessage.length;
  const boundedLatest = boundLatestUserMessageForRecall(params.latestUserMessage);
  // In recent/full modes the recent turns already carry conversation context
  // under their own explicit budgets, so use only current-turn material (the
  // extracted request plus any native quoted reply) as the latest message.
  // Embedding the generated envelope tail too would duplicate history.
  const request = boundedLatest.request.trim();
  if (params.config.queryMode === "message") {
    return {
      query: composeMessageModeQuery({ ...boundedLatest, request }),
      request,
      rawChars,
      bounded: boundedLatest.bounded,
    };
  }
  const latest = composeLatestRequestForTurns({ ...boundedLatest, request });
  if (params.config.queryMode === "full") {
    const allTurns = (params.recentTurns ?? [])
      .map((turn) => `${turn.role}: ${turn.text.trim().replace(/\s+/g, " ")}`)
      .filter((turn) => turn.length > 0);
    if (allTurns.length === 0) {
      return { query: latest, request, rawChars, bounded: boundedLatest.bounded };
    }
    const assembled = assembleBoundedTurnsQuery({
      header: "Full conversation context:",
      turnLines: allTurns,
      latest,
    });
    return {
      query: assembled.query,
      request,
      rawChars,
      bounded: boundedLatest.bounded || assembled.trimmed,
    };
  }
  let remainingUser = params.config.recentUserTurns;
  let remainingAssistant = params.config.recentAssistantTurns;
  const selected: ActiveRecallRecentTurn[] = [];
  for (let index = (params.recentTurns ?? []).length - 1; index >= 0; index -= 1) {
    const turn = params.recentTurns?.[index];
    if (!turn) {
      continue;
    }
    if (turn.role === "user") {
      if (remainingUser <= 0) {
        continue;
      }
      remainingUser -= 1;
      selected.push({
        role: "user",
        text: truncateUtf16Safe(
          turn.text.trim().replace(/\s+/g, " "),
          params.config.recentUserChars,
        ),
      });
      continue;
    }
    if (remainingAssistant <= 0) {
      continue;
    }
    remainingAssistant -= 1;
    selected.push({
      role: "assistant",
      text: truncateUtf16Safe(
        turn.text.trim().replace(/\s+/g, " "),
        params.config.recentAssistantChars,
      ),
    });
  }
  const recentTurns = selected.toReversed().filter((turn) => turn.text.length > 0);
  if (recentTurns.length === 0) {
    return { query: latest, request, rawChars, bounded: boundedLatest.bounded };
  }
  const assembled = assembleBoundedTurnsQuery({
    header: "Recent conversation tail:",
    turnLines: recentTurns.map((turn) => `${turn.role}: ${turn.text}`),
    latest,
  });
  return {
    query: assembled.query,
    request,
    rawChars,
    bounded: boundedLatest.bounded || assembled.trimmed,
  };
}

function stripExternalUntrustedBlocks(text: string): string {
  return text.replace(
    /<<<EXTERNAL_UNTRUSTED_CONTENT\b[^>]*>>>[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT\b[^>]*>>>/g,
    " ",
  );
}

function stripJsonFences(text: string): string {
  return text.replace(/```(?:json)?\s*[\s\S]*?```/gi, " ");
}

function stripActiveMemoryXmlBlocks(text: string): string {
  return text.replace(/<active_memory_plugin>[\s\S]*?<\/active_memory_plugin>/gi, " ");
}

function normalizeSearchQueryText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) {
        return false;
      }
      if (/^(conversation info|sender|untrusted context)\b/i.test(line)) {
        return false;
      }
      if (/^(source: external|---|untrusted discord message body)$/i.test(line)) {
        return false;
      }
      if (/^⚠️?\s*Agent couldn't generate a response/i.test(line)) {
        return false;
      }
      if (/^Please try again\.?$/i.test(line)) {
        return false;
      }
      return true;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function clampSearchQuery(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > MAX_ACTIVE_MEMORY_SEARCH_QUERY_CHARS
    ? truncateUtf16Safe(normalized, MAX_ACTIVE_MEMORY_SEARCH_QUERY_CHARS).trim()
    : normalized;
}

function buildSearchQuery(params: {
  latestUserMessage: string;
  recentTurns?: ActiveRecallRecentTurn[];
}): string {
  const latest = clampSearchQuery(
    normalizeSearchQueryText(
      stripActiveMemoryXmlBlocks(
        stripJsonFences(stripExternalUntrustedBlocks(params.latestUserMessage)),
      ),
    ),
  );
  if (latest.length >= 12 || !params.recentTurns?.length) {
    return latest || clampSearchQuery(params.latestUserMessage);
  }
  const previousUser = [...params.recentTurns]
    .toReversed()
    .find((turn) => turn.role === "user" && turn.text.trim() !== params.latestUserMessage.trim());
  if (!previousUser) {
    return latest || clampSearchQuery(params.latestUserMessage);
  }
  const context = truncateUtf16Safe(
    clampSearchQuery(normalizeSearchQueryText(stripRecalledContextNoise(previousUser.text))),
    120,
  ).trim();
  return clampSearchQuery(context ? `${context} ${latest}` : latest);
}

function extractTextContentParts(content: unknown): string[] {
  if (typeof content === "string") {
    return content.trim() ? [content] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const typed = item as { type?: unknown; text?: unknown; content?: unknown };
    if (typeof typed.text === "string") {
      parts.push(typed.text);
      continue;
    }
    if (typed.type === "text" && typeof typed.content === "string") {
      parts.push(typed.content);
    }
  }
  return parts.map((part) => part.trim()).filter(Boolean);
}

function extractTextContent(content: unknown): string {
  return extractTextContentParts(content).join(" ").trim();
}

function stripRecalledContextNoise(text: string): string {
  const lines = text.split("\n");
  const cleanedLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      continue;
    }
    if (line === ACTIVE_MEMORY_UNTRUSTED_CONTEXT_HEADER) {
      continue;
    }
    if (line === ACTIVE_MEMORY_OPEN_TAG) {
      let closeIndex = -1;
      for (let probe = index + 1; probe < lines.length; probe += 1) {
        if ((lines[probe]?.trim() ?? "") === ACTIVE_MEMORY_CLOSE_TAG) {
          closeIndex = probe;
          break;
        }
      }
      if (closeIndex !== -1) {
        index = closeIndex;
        continue;
      }
    }
    if (line === ACTIVE_MEMORY_CLOSE_TAG) {
      continue;
    }
    if (RECALLED_CONTEXT_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      continue;
    }
    cleanedLines.push(line);
  }

  return cleanedLines.join(" ").replace(/\s+/g, " ").trim();
}

function stripInjectedActiveMemoryPrefixOnly(text: string): string {
  const lines = text.split("\n");
  const cleanedLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      continue;
    }
    if (line === ACTIVE_MEMORY_UNTRUSTED_CONTEXT_HEADER) {
      const nextLine = lines[index + 1]?.trim() ?? "";
      if (nextLine === ACTIVE_MEMORY_OPEN_TAG) {
        let closeIndex = -1;
        for (let probe = index + 2; probe < lines.length; probe += 1) {
          if ((lines[probe]?.trim() ?? "") === ACTIVE_MEMORY_CLOSE_TAG) {
            closeIndex = probe;
            break;
          }
        }
        if (closeIndex !== -1) {
          index = closeIndex;
          continue;
        }
      }
    }
    cleanedLines.push(line);
  }

  return cleanedLines.join(" ").replace(/\s+/g, " ").trim();
}

function extractRecentTurns(messages: unknown[]): ActiveRecallRecentTurn[] {
  const turns: ActiveRecallRecentTurn[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const typed = message as { role?: unknown; content?: unknown };
    const role = typed.role === "user" || typed.role === "assistant" ? typed.role : undefined;
    if (!role) {
      continue;
    }
    const rawText = extractTextContent(typed.content);
    const text =
      role === "assistant"
        ? stripRecalledContextNoise(rawText)
        : stripInjectedActiveMemoryPrefixOnly(rawText);
    if (!text) {
      continue;
    }
    turns.push({ role, text });
  }
  return turns;
}

function parseModelCandidate(modelRef: string | undefined, defaultProvider = DEFAULT_PROVIDER) {
  if (!modelRef) {
    return undefined;
  }
  return parseModelRef(modelRef, defaultProvider) ?? { provider: defaultProvider, model: modelRef };
}

function getModelRef(
  runtimeConfig: OpenClawConfig,
  agentId: string,
  config: ResolvedActiveRecallPluginConfig,
  ctx?: {
    modelProviderId?: string;
    modelId?: string;
  },
): { provider: string; model: string } | undefined {
  const currentRunModel =
    ctx?.modelProviderId && ctx?.modelId ? `${ctx.modelProviderId}/${ctx.modelId}` : undefined;
  const configuredDefaultModel = resolveAgentEffectiveModelPrimary(runtimeConfig, agentId)
    ? resolveDefaultModelForAgent({ cfg: runtimeConfig, agentId })
    : undefined;
  const defaultProvider = configuredDefaultModel?.provider ?? DEFAULT_PROVIDER;
  const candidates = [
    config.model,
    currentRunModel,
    configuredDefaultModel
      ? `${configuredDefaultModel.provider}/${configuredDefaultModel.model}`
      : undefined,
    config.modelFallback,
  ];
  for (const candidate of candidates) {
    const parsed = parseModelCandidate(candidate, defaultProvider);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

export {
  buildQuery,
  buildSearchQuery,
  extractRecentTurns,
  extractTextContent,
  extractTextContentParts,
  getModelRef,
};
