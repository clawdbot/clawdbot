/** Strips internal scaffolding from text before user-facing delivery. */
import { CURRENT_MESSAGE_MARKER, HISTORY_CONTEXT_MARKER } from "../../auto-reply/reply/history.js";
import {
  INBOUND_METADATA_MARKERS,
  stripInboundMetadata,
} from "../../auto-reply/reply/strip-inbound-meta.js";
import { coerceChatContentText } from "../../shared/chat-content.js";
import { escapeRegExp } from "../../shared/regexp.js";
import {
  assistantTraceTextFilter,
  plainToolCallTextFilter,
  stripLegacyBracketToolCallBlocks,
  stripMinimaxToolCallXml,
  stripToolCallXmlTags,
} from "../../shared/text/assistant-visible-text.js";
import {
  findCodeRegions,
  isInsideCode,
  stripLinesOutsideCode,
} from "../../shared/text/code-regions.js";
import { stripFinalTags } from "../../shared/text/final-tags.js";
import {
  applyTextFilters,
  duplicateParagraphTextFilter,
  leadingEmptyLinesTextFilter,
  type TextFilter,
} from "../../shared/text/text-projection.js";
import { EXEC_NO_OUTPUT_PLACEHOLDER } from "../bash-tools.exec-output.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
  stripInternalRuntimeContext,
} from "../internal-runtime-context.js";

const TOOL_CALLS_OMITTED_PLACEHOLDER_LINE_RE = /^[ \t]*\[tool calls omitted\][ \t]*$/i;

function stripInternalPlaceholderLines(text: string): string {
  if (
    !text.toLowerCase().includes("[tool calls omitted]") &&
    !text.includes(EXEC_NO_OUTPUT_PLACEHOLDER)
  ) {
    return text;
  }
  return stripLinesOutsideCode(
    text,
    (line) =>
      TOOL_CALLS_OMITTED_PLACEHOLDER_LINE_RE.test(line) ||
      line.trim() === EXEC_NO_OUTPUT_PLACEHOLDER,
  );
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

// Share descriptors only; createTextProjection owns each stream's mutable state.
const userFacingFilters: Partial<Record<"normal" | "error", readonly TextFilter[]>> = {};

export function userFacingTextFilters(errorContext = false): readonly TextFilter[] {
  return (userFacingFilters[errorContext ? "error" : "normal"] ??= [
    { transform: stripFinalTags, activationTokens: ["<"] },
    {
      transform: stripInternalRuntimeContext,
      activationTokens: [
        INTERNAL_RUNTIME_CONTEXT_BEGIN,
        INTERNAL_RUNTIME_CONTEXT_END,
        OPENCLAW_RUNTIME_CONTEXT_NOTICE,
      ],
    },
    { transform: stripInboundMetadata, activationTokens: INBOUND_METADATA_MARKERS },
    { transform: stripMinimaxToolCallXml, activationTokens: ["<"] },
    {
      transform: (text) => stripToolCallXmlTags(text, { stripFunctionCallsXmlPayloads: true }),
      activationTokens: ["<"],
    },
    {
      transform: stripInternalPlaceholderLines,
      activationTokens: [EXEC_NO_OUTPUT_PLACEHOLDER, "[tool calls omitted]"],
    },
    ...(errorContext ? [assistantTraceTextFilter] : []),
    { transform: stripLegacyBracketToolCallBlocks, activationTokens: ["["] },
    plainToolCallTextFilter,
    leadingEmptyLinesTextFilter,
    duplicateParagraphTextFilter,
  ]);
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
  return applyTextFilters(withoutConversationContext, userFacingTextFilters(opts?.errorContext));
}
