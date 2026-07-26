import {
  DEFAULT_PROVIDER,
  parseModelRef,
  resolveAgentEffectiveModelPrimary,
  resolveDefaultModelForAgent,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  ACTIVE_MEMORY_CLOSE_TAG,
  ACTIVE_MEMORY_OPEN_TAG,
  ACTIVE_MEMORY_UNTRUSTED_CONTEXT_HEADER,
  MAX_ACTIVE_MEMORY_SEARCH_QUERY_CHARS,
  RECALLED_CONTEXT_LINE_PATTERNS,
  type ActiveRecallRecentTurn,
  type ResolvedActiveRecallPluginConfig,
} from "./types.js";

function buildQuery(params: {
  latestUserMessage: string;
  recentTurns?: ActiveRecallRecentTurn[];
  config: ResolvedActiveRecallPluginConfig;
}): string {
  const latest = params.latestUserMessage.trim();
  if (params.config.queryMode === "message") {
    return latest;
  }
  if (params.config.queryMode === "full") {
    const allTurns = (params.recentTurns ?? [])
      .map((turn) => `${turn.role}: ${turn.text.trim().replace(/\s+/g, " ")}`)
      .filter((turn) => turn.length > 0);
    if (allTurns.length === 0) {
      return latest;
    }
    return ["Full conversation context:", ...allTurns, "", "Latest user message:", latest].join(
      "\n",
    );
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
    return latest;
  }
  return [
    "Recent conversation tail:",
    ...recentTurns.map((turn) => `${turn.role}: ${turn.text}`),
    "",
    "Latest user message:",
    latest,
  ].join("\n");
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
