/** Strips internal scaffolding from text before user-facing delivery. */
import { stripPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/index.js";
import { CURRENT_MESSAGE_MARKER, HISTORY_CONTEXT_MARKER } from "../../auto-reply/reply/history.js";
import { stripInboundMetadata } from "../../auto-reply/reply/strip-inbound-meta.js";
import { coerceChatContentText } from "../../shared/chat-content.js";
import { escapeRegExp } from "../../shared/regexp.js";
import {
  stripAssistantInternalTraceLines,
  stripLegacyBracketToolCallBlocks,
  stripMinimaxToolCallXml,
  stripToolCallXmlTags,
} from "../../shared/text/assistant-visible-text.js";
import { findCodeRegions, isInsideCode } from "../../shared/text/code-regions.js";
import { stripFinalTags } from "../../shared/text/final-tags.js";
import { EXEC_NO_OUTPUT_PLACEHOLDER } from "../bash-tools.exec-output.js";
import { stripInternalRuntimeContext } from "../internal-runtime-context.js";

const TOOL_CALLS_OMITTED_PLACEHOLDER_LINE_RE = /^[ \t]*\[tool calls omitted\][ \t]*$/i;

function stripFinalTagsFromText(text: unknown): string {
  const normalized = coerceChatContentText(text);
  return normalized ? stripFinalTags(normalized) : normalized;
}

function stripInternalPlaceholderLines(text: string): string {
  if (
    !text.toLowerCase().includes("[tool calls omitted]") &&
    !text.includes(EXEC_NO_OUTPUT_PLACEHOLDER)
  ) {
    return text;
  }
  let protectedRegions: ReturnType<typeof findCodeRegions> | undefined;
  let result = "";
  let start = 0;
  while (start < text.length) {
    const newlineIndex = text.indexOf("\n", start);
    const end = newlineIndex === -1 ? text.length : newlineIndex + 1;
    const chunk = text.slice(start, end);
    const line = chunk.endsWith("\n") ? chunk.slice(0, -1).replace(/\r$/, "") : chunk;
    const isInternalPlaceholder =
      TOOL_CALLS_OMITTED_PLACEHOLDER_LINE_RE.test(line) ||
      line.trim() === EXEC_NO_OUTPUT_PLACEHOLDER;
    if (
      !isInternalPlaceholder ||
      isInsideCode(start, (protectedRegions ??= findCodeRegions(text)))
    ) {
      result += chunk;
    }
    start = end;
  }
  return result;
}

const MARKDOWN_LINE_PREFIX =
  "[ \\t]*(?:(?:>|[-+*](?=[ \\t])|#{1,6}(?=[ \\t])|\\d{1,9}[.)](?=[ \\t]))[ \\t]*)*";

type VerifiedConversationContext = {
  readonly normalizedSource: string;
  sourceLines?: string[];
  firstSourceLine?: string;
  copiedPrompt?: RegExp;
  markdownWrapper?: RegExp;
  incompleteMarkdownWrapper?: RegExp;
};

function hasConversationContextMarker(text: string): boolean {
  return text.includes(HISTORY_CONTEXT_MARKER) || text.includes(CURRENT_MESSAGE_MARKER);
}

function prepareVerifiedConversationContext(
  source: string | undefined,
): VerifiedConversationContext | undefined {
  if (!source || !hasConversationContextMarker(source)) {
    return undefined;
  }
  const sourceCodeRegions = findCodeRegions(source);
  const ownsConversationContext = [HISTORY_CONTEXT_MARKER, CURRENT_MESSAGE_MARKER].some(
    (marker) => {
      let markerOffset = source.indexOf(marker);
      while (markerOffset !== -1) {
        const markerEnd = markerOffset + marker.length;
        const startsLine = markerOffset === 0 || source[markerOffset - 1] === "\n";
        const endsLine =
          markerEnd === source.length || source[markerEnd] === "\n" || source[markerEnd] === "\r";
        if (startsLine && endsLine && !isInsideCode(markerOffset, sourceCodeRegions)) {
          return true;
        }
        markerOffset = source.indexOf(marker, markerEnd);
      }
      return false;
    },
  );
  if (!ownsConversationContext) {
    return undefined;
  }

  return { normalizedSource: source.replace(/\r\n?/gu, "\n") };
}

function stripVerifiedConversationContext(
  text: string,
  context: VerifiedConversationContext | undefined,
  streaming = false,
): string {
  if (!context) {
    return text;
  }
  const { normalizedSource } = context;
  let result = text;
  if (hasConversationContextMarker(text)) {
    if (!context.copiedPrompt) {
      const promptPattern = (context.sourceLines ??= normalizedSource.split("\n"))
        .map(escapeRegExp)
        .join(`(?:\\r\\n?|\\n)${MARKDOWN_LINE_PREFIX}`);
      context.copiedPrompt = new RegExp(`(?:^${MARKDOWN_LINE_PREFIX})?${promptPattern}`, "gmu");
    }
    // Markdown formatting does not make an exact owner-bound private prompt safe to disclose.
    result = text.replace(context.copiedPrompt, "");
  }
  if (!streaming) {
    return result;
  }

  const sourceStart = normalizedSource.charAt(0);
  const firstSourceLine = (context.firstSourceLine ??=
    normalizedSource.split("\n", 1)[0] ?? normalizedSource);
  const completedSourceStart = result.indexOf(firstSourceLine);
  // Anchor every completed prompt start; wrappers can be arbitrarily wide and markers can repeat.
  const searchStart =
    completedSourceStart === -1
      ? Math.max(0, result.length - normalizedSource.length * 2)
      : completedSourceStart;
  const markdownWrapper = (context.markdownWrapper ??= new RegExp(
    `^${MARKDOWN_LINE_PREFIX}$`,
    "u",
  ));
  const incompleteMarkdownWrapper = (context.incompleteMarkdownWrapper ??= new RegExp(
    `^${MARKDOWN_LINE_PREFIX}(?:[-+*]|#{1,6}|\\d{1,9}[.)]?)?$`,
    "u",
  ));
  let candidateStart = result.indexOf(sourceStart, searchStart);
  let completedCandidates = 0;
  while (candidateStart !== -1) {
    const remainingLength = result.length - candidateStart;
    const startsPromptLine =
      remainingLength >= firstSourceLine.length
        ? result.startsWith(firstSourceLine, candidateStart)
        : firstSourceLine.startsWith(result.slice(candidateStart));
    if (!startsPromptLine) {
      candidateStart = result.indexOf(sourceStart, candidateStart + 1);
      continue;
    }
    // Bound attacker-controlled full-marker floods without releasing an ambiguous private suffix.
    if (++completedCandidates > 16) {
      return result.slice(0, searchStart);
    }
    const suffix = result.slice(candidateStart).replace(/\r\n?/gu, "\n");
    const sourceLines = (context.sourceLines ??= normalizedSource.split("\n"));
    let lineIndex = 0;
    const unwrappedSuffix = suffix.replace(/\n([^\n]*)/gu, (_match, line: string) => {
      const sourceLine = sourceLines[++lineIndex];
      if (sourceLine === undefined) {
        return `\n${line}`;
      }
      if (!sourceLine) {
        return incompleteMarkdownWrapper.test(line) ? "\n" : `\n${line}`;
      }
      const sourceLineStart = sourceLine.charAt(0);
      let contentStart = line.indexOf(sourceLineStart);
      while (contentStart !== -1) {
        const content = line.slice(contentStart);
        if (sourceLine.startsWith(content) && markdownWrapper.test(line.slice(0, contentStart))) {
          return `\n${content}`;
        }
        contentStart = line.indexOf(sourceLineStart, contentStart + 1);
      }
      return incompleteMarkdownWrapper.test(line) ? "\n" : `\n${line}`;
    });
    if (
      (suffix.length < normalizedSource.length && normalizedSource.startsWith(suffix)) ||
      (unwrappedSuffix.length < normalizedSource.length &&
        normalizedSource.startsWith(unwrappedSuffix))
    ) {
      // A later stream update can complete private prompt bytes that cannot be retracted once sent.
      return result.slice(0, candidateStart);
    }
    candidateStart = result.indexOf(sourceStart, candidateStart + 1);
  }
  return result;
}

export function createVerifiedConversationContextStreamFilter(
  getConversationContext?: () => string | undefined,
): (delta: string) => string {
  let accumulatedText = "";
  let releasedText: string | null = "";
  let conversationContextSource: string | undefined;
  let preparedConversationContext: VerifiedConversationContext | undefined;
  return (delta) => {
    accumulatedText += delta;
    const conversationContext = getConversationContext?.();
    const sourceChanged = conversationContext !== conversationContextSource;
    if (sourceChanged) {
      preparedConversationContext = prepareVerifiedConversationContext(conversationContext?.trim());
      conversationContextSource = conversationContext;
    }
    const safeText = stripVerifiedConversationContext(
      accumulatedText,
      preparedConversationContext,
      true,
    );
    // An unchanged unowned source keeps the known prefix; changing ownership must recheck it.
    if (
      releasedText === null ||
      ((sourceChanged || preparedConversationContext) && !safeText.startsWith(releasedText))
    ) {
      releasedText = null;
      return "";
    }
    const newlySafeText = safeText.slice(releasedText.length);
    releasedText = safeText;
    return newlySafeText;
  };
}

function collapseConsecutiveDuplicateBlocks(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }
  const blocks = trimmed.split(/\n{2,}/);
  if (blocks.length < 2) {
    return text;
  }
  const result: string[] = [];
  let lastNormalized: string | null = null;
  for (const block of blocks) {
    const normalized = block.trim().replace(/\s+/g, " ");
    if (lastNormalized && normalized === lastNormalized) {
      continue;
    }
    result.push(block.trim());
    lastNormalized = normalized;
  }
  return result.length === blocks.length ? text : result.join("\n\n");
}

export function sanitizeUserFacingText(
  text: unknown,
  opts?: { errorContext?: boolean; conversationContext?: string; streaming?: boolean },
): string {
  const raw = coerceChatContentText(text);
  if (!raw) {
    return raw;
  }
  const conversationContext = opts?.conversationContext?.trim();
  const withoutConversationContext =
    conversationContext && (opts?.streaming || hasConversationContextMarker(raw))
      ? stripVerifiedConversationContext(
          raw,
          prepareVerifiedConversationContext(conversationContext),
          opts?.streaming,
        )
      : raw;
  const stripped = stripInboundMetadata(
    stripInternalRuntimeContext(stripFinalTagsFromText(withoutConversationContext)),
  );
  const withoutToolCallXml = stripToolCallXmlTags(stripMinimaxToolCallXml(stripped), {
    stripFunctionCallsXmlPayloads: true,
  });
  // Replay repair and empty exec output produce placeholders that never belong in visible replies.
  const withoutPlaceholder = stripInternalPlaceholderLines(withoutToolCallXml);
  const withoutInternalTraceLines = opts?.errorContext
    ? stripAssistantInternalTraceLines(withoutPlaceholder)
    : withoutPlaceholder;
  const withoutToolCallBlocks = stripPlainTextToolCallBlocks(
    stripLegacyBracketToolCallBlocks(withoutInternalTraceLines),
    { resolveProtectedRanges: findCodeRegions },
  );
  if (!withoutToolCallBlocks.trim()) {
    return "";
  }
  const withoutLeadingEmptyLines = withoutToolCallBlocks.replace(/^(?:[ \t]*\r?\n)+/, "");
  return collapseConsecutiveDuplicateBlocks(withoutLeadingEmptyLines);
}
