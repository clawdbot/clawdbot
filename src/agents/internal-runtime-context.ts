/**
 * Internal runtime-context delimiter and stripping helpers.
 * Protects runtime-generated prompt blocks from user text and removes old
 * context formats before replaying or comparing messages.
 */
/** Opening delimiter for protected OpenClaw runtime context blocks. */
export const INTERNAL_RUNTIME_CONTEXT_BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
/** Closing delimiter for protected OpenClaw runtime context blocks. */
export const INTERNAL_RUNTIME_CONTEXT_END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

const ESCAPED_INTERNAL_RUNTIME_CONTEXT_BEGIN = "[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]";
const ESCAPED_INTERNAL_RUNTIME_CONTEXT_END = "[[OPENCLAW_INTERNAL_CONTEXT_END]]";

/** Notice inserted into runtime-generated context blocks. */
export const OPENCLAW_RUNTIME_CONTEXT_NOTICE =
  "This context is runtime-generated, not user-authored. Keep internal details private.";
/** Header for context attached to the immediately preceding user message. */
export const OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER =
  "OpenClaw runtime context for the immediately preceding user message.";
/** Header for runtime events passed as prompt context. */
export const OPENCLAW_RUNTIME_EVENT_HEADER = "OpenClaw runtime event.";
/** Custom message type used for structured runtime-context messages. */
export const OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE = "openclaw.runtime-context";

const LEGACY_INTERNAL_CONTEXT_HEADER =
  ["OpenClaw runtime context (internal):", OPENCLAW_RUNTIME_CONTEXT_NOTICE, ""].join("\n") + "\n";

const LEGACY_INTERNAL_EVENT_MARKER = "[Internal task completion event]";
const LEGACY_INTERNAL_EVENT_SEPARATOR = "\n\n---\n\n";
const LEGACY_UNTRUSTED_RESULT_BEGIN = "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>";
const LEGACY_UNTRUSTED_RESULT_END = "<<<END_UNTRUSTED_CHILD_RESULT>>>";

/** Escape protected context delimiters before embedding untrusted text. */
export function escapeInternalRuntimeContextDelimiters(value: string): string {
  return value
    .replaceAll(INTERNAL_RUNTIME_CONTEXT_BEGIN, ESCAPED_INTERNAL_RUNTIME_CONTEXT_BEGIN)
    .replaceAll(INTERNAL_RUNTIME_CONTEXT_END, ESCAPED_INTERNAL_RUNTIME_CONTEXT_END);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findDelimitedTokenIndex(text: string, token: string, from: number): number {
  const tokenRe = new RegExp(`(?:^|\\r?\\n)${escapeRegExp(token)}(?=\\r?\\n|$)`, "g");
  tokenRe.lastIndex = Math.max(0, from);
  const match = tokenRe.exec(text);
  if (!match) {
    return -1;
  }
  const prefixLength = match[0].length - token.length;
  return match.index + prefixLength;
}

function extractDelimitedBlocks(
  text: string,
  begin: string,
  end: string,
): { text: string; blocks: string[] } {
  let next = text;
  const blocks: string[] = [];
  for (;;) {
    const start = findDelimitedTokenIndex(next, begin, 0);
    if (start === -1) {
      return { text: next, blocks };
    }

    let cursor = start + begin.length;
    let depth = 1;
    let finish = -1;
    while (depth > 0) {
      const nextBegin = findDelimitedTokenIndex(next, begin, cursor);
      const nextEnd = findDelimitedTokenIndex(next, end, cursor);
      if (nextEnd === -1) {
        break;
      }
      if (nextBegin !== -1 && nextBegin < nextEnd) {
        depth += 1;
        cursor = nextBegin + begin.length;
        continue;
      }
      depth -= 1;
      finish = nextEnd;
      cursor = nextEnd + end.length;
    }

    const before = next.slice(0, start).trimEnd();
    if (finish === -1 || depth !== 0) {
      return { text: before, blocks };
    }
    const blockEnd = finish + end.length;
    blocks.push(next.slice(start, blockEnd).trim());
    const after = next.slice(blockEnd).trimStart();
    next = before && after ? `${before}\n\n${after}` : `${before}${after}`;
  }
}

function stripDelimitedBlock(text: string, begin: string, end: string): string {
  return extractDelimitedBlocks(text, begin, end).text;
}

function findLegacyInternalEventEnd(text: string, start: number): number | null {
  if (!text.startsWith(LEGACY_INTERNAL_EVENT_MARKER, start)) {
    return null;
  }

  const resultBegin = text.indexOf(
    LEGACY_UNTRUSTED_RESULT_BEGIN,
    start + LEGACY_INTERNAL_EVENT_MARKER.length,
  );
  if (resultBegin === -1) {
    return null;
  }

  const resultEnd = text.indexOf(
    LEGACY_UNTRUSTED_RESULT_END,
    resultBegin + LEGACY_UNTRUSTED_RESULT_BEGIN.length,
  );
  if (resultEnd === -1) {
    return null;
  }

  const actionIndex = text.indexOf("\n\nAction:\n", resultEnd + LEGACY_UNTRUSTED_RESULT_END.length);
  if (actionIndex === -1) {
    return null;
  }

  const afterAction = actionIndex + "\n\nAction:\n".length;
  const nextEvent = text.indexOf(
    `${LEGACY_INTERNAL_EVENT_SEPARATOR}${LEGACY_INTERNAL_EVENT_MARKER}`,
    afterAction,
  );
  if (nextEvent !== -1) {
    return nextEvent;
  }

  const nextParagraph = text.indexOf("\n\n", afterAction);
  return nextParagraph === -1 ? text.length : nextParagraph;
}

function stripLegacyInternalRuntimeContext(text: string): string {
  let next = text;
  let searchFrom = 0;
  for (;;) {
    const headerStart = next.indexOf(LEGACY_INTERNAL_CONTEXT_HEADER, searchFrom);
    if (headerStart === -1) {
      return next;
    }

    const eventStart = headerStart + LEGACY_INTERNAL_CONTEXT_HEADER.length;
    if (!next.startsWith(LEGACY_INTERNAL_EVENT_MARKER, eventStart)) {
      searchFrom = eventStart;
      continue;
    }

    let blockEnd = findLegacyInternalEventEnd(next, eventStart);
    if (blockEnd == null) {
      const nextParagraph = next.indexOf("\n\n", eventStart + LEGACY_INTERNAL_EVENT_MARKER.length);
      blockEnd = nextParagraph === -1 ? next.length : nextParagraph;
    } else {
      while (
        next.startsWith(
          `${LEGACY_INTERNAL_EVENT_SEPARATOR}${LEGACY_INTERNAL_EVENT_MARKER}`,
          blockEnd,
        )
      ) {
        const nextEventStart = blockEnd + LEGACY_INTERNAL_EVENT_SEPARATOR.length;
        const nextEventEnd = findLegacyInternalEventEnd(next, nextEventStart);
        if (nextEventEnd == null) {
          break;
        }
        blockEnd = nextEventEnd;
      }
    }

    const before = next.slice(0, headerStart).trimEnd();
    const after = next.slice(blockEnd).trimStart();
    next = before && after ? `${before}\n\n${after}` : `${before}${after}`;
    searchFrom = Math.max(0, before.length - 1);
  }
}

function isRuntimeContextPromptHeader(line: string): boolean {
  return (
    line === OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER || line === OPENCLAW_RUNTIME_EVENT_HEADER
  );
}

function stripRuntimeContextPromptPreface(text: string): string {
  const lines = text.split(/\r?\n/);
  let changed = false;
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";
    if (
      isRuntimeContextPromptHeader(line.trim()) &&
      nextLine.trim() === OPENCLAW_RUNTIME_CONTEXT_NOTICE
    ) {
      changed = true;
      index += 1;
      while (index + 1 < lines.length && (lines[index + 1] ?? "").trim() === "") {
        index += 1;
      }
      continue;
    }
    output.push(line);
  }

  return changed
    ? output
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    : text;
}

/** Remove protected and legacy runtime-context blocks from text. */
export function stripInternalRuntimeContext(text: string): string {
  if (!text) {
    return text;
  }
  const withoutDelimitedBlocks = stripDelimitedBlock(
    text,
    INTERNAL_RUNTIME_CONTEXT_BEGIN,
    INTERNAL_RUNTIME_CONTEXT_END,
  );
  return stripRuntimeContextPromptPreface(
    stripLegacyInternalRuntimeContext(withoutDelimitedBlocks),
  );
}

/** Extract protected runtime-context blocks while returning remaining visible text. */
export function extractInternalRuntimeContext(text: string): {
  text: string;
  runtimeContext?: string;
} {
  const extracted = extractDelimitedBlocks(
    text,
    INTERNAL_RUNTIME_CONTEXT_BEGIN,
    INTERNAL_RUNTIME_CONTEXT_END,
  );
  return {
    text: extracted.text,
    ...(extracted.blocks.length > 0 ? { runtimeContext: extracted.blocks.join("\n\n") } : {}),
  };
}

/** Return true when text contains current or legacy runtime-context markers. */
export function hasInternalRuntimeContext(text: string): boolean {
  if (!text) {
    return false;
  }
  return (
    findDelimitedTokenIndex(text, INTERNAL_RUNTIME_CONTEXT_BEGIN, 0) !== -1 ||
    text.includes(LEGACY_INTERNAL_CONTEXT_HEADER) ||
    text.includes(
      `${OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER}\n${OPENCLAW_RUNTIME_CONTEXT_NOTICE}`,
    ) ||
    text.includes(`${OPENCLAW_RUNTIME_EVENT_HEADER}\n${OPENCLAW_RUNTIME_CONTEXT_NOTICE}`)
  );
}

function isOpenClawRuntimeContextCustomMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const candidate = message as { role?: unknown; customType?: unknown };
  return (
    candidate.role === "custom" && candidate.customType === OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE
  );
}

/** Remove all structured runtime-context custom messages. */
export function stripRuntimeContextCustomMessages<T>(messages: T[]): T[] {
  if (!messages.some(isOpenClawRuntimeContextCustomMessage)) {
    return messages;
  }
  return messages.filter((message) => !isOpenClawRuntimeContextCustomMessage(message));
}

function isUserMessage(message: unknown): boolean {
  return Boolean(
    message && typeof message === "object" && (message as { role?: unknown }).role === "user",
  );
}

/** Keeps only current-turn runtime context positioned immediately before the active user. */
export function stripHistoricalRuntimeContextCustomMessages<T>(messages: T[]): T[] {
  if (!messages.some(isOpenClawRuntimeContextCustomMessage)) {
    return messages;
  }
  const lastUserIndex = messages.findLastIndex(isUserMessage);
  if (lastUserIndex === -1) {
    return messages.filter((message) => !isOpenClawRuntimeContextCustomMessage(message));
  }
  const currentRuntimeContextIndexes = new Set<number>();
  for (let index = lastUserIndex - 1; index >= 0; index -= 1) {
    if (!isOpenClawRuntimeContextCustomMessage(messages[index])) {
      break;
    }
    currentRuntimeContextIndexes.add(index);
  }
  return messages.filter((message, index) => {
    if (!isOpenClawRuntimeContextCustomMessage(message)) {
      return true;
    }
    return currentRuntimeContextIndexes.has(index);
  });
}

/**
 * Moves current-turn runtime-context carrier messages to the absolute tail of
 * the request (after the active user turn and any tool-call scaffolding).
 *
 * Prompt-cache rationale: a per-turn carrier that is stripped on replay makes
 * the next request diverge at the carrier's slot. Placed BEFORE the active user
 * turn, that slot precedes everything that gets reused, so the whole tail
 * (user turn + tool loop) re-bills every turn. Placed at the ABSOLUTE tail, the
 * divergence lands exactly where the next turn's new bytes (the assistant reply)
 * begin anyway, so the request is an append-only prefix-extension through the
 * active user turn — only the trailing carrier is ever re-billed.
 *
 * Runs after {@link stripHistoricalRuntimeContextCustomMessages}, so only the
 * current-turn carrier(s) remain. When there is no active user turn to anchor
 * after, messages are returned unchanged.
 */
export function relocateCurrentRuntimeContextCarrierToTail<T>(messages: T[]): T[] {
  const lastIndex = messages.length - 1;
  if (lastIndex < 0 || !messages.some(isOpenClawRuntimeContextCustomMessage)) {
    return messages;
  }
  // Already tail-placed (a contiguous carrier run ends the array): no-op so the
  // serialized bytes stay stable across re-attempts of the same request.
  let firstNonCarrierFromEnd = lastIndex;
  while (
    firstNonCarrierFromEnd >= 0 &&
    isOpenClawRuntimeContextCustomMessage(messages[firstNonCarrierFromEnd])
  ) {
    firstNonCarrierFromEnd -= 1;
  }
  const rest = messages.filter((message) => !isOpenClawRuntimeContextCustomMessage(message));
  // No active user turn to anchor after — leave placement to the strip pass.
  if (!rest.some(isUserMessage)) {
    return messages;
  }
  if (firstNonCarrierFromEnd === rest.length - 1) {
    return messages;
  }
  const carriers = messages.filter(isOpenClawRuntimeContextCustomMessage);
  return [...rest, ...carriers];
}
