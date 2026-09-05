/**
 * Internal runtime-context delimiter and stripping helpers.
 * Protects runtime-generated prompt blocks from user text and removes old
 * context formats before replaying or comparing messages.
 */
import { escapeRegExp } from "../shared/regexp.js";

/** Opening delimiter for protected OpenClaw runtime context blocks. */
export const INTERNAL_RUNTIME_CONTEXT_BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
/** Closing delimiter for protected OpenClaw runtime context blocks. */
export const INTERNAL_RUNTIME_CONTEXT_END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

const ESCAPED_INTERNAL_RUNTIME_CONTEXT_BEGIN = "[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]";
const ESCAPED_INTERNAL_RUNTIME_CONTEXT_END = "[[OPENCLAW_INTERNAL_CONTEXT_END]]";

/** Notice inserted into runtime-generated context blocks. */
export const OPENCLAW_RUNTIME_CONTEXT_NOTICE =
  "This context is runtime-generated, not user-authored. Keep internal details private.";
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

function createDelimitedToken(token: string) {
  return {
    token,
    pattern: new RegExp(`(?:^|\\r?\\n)[ \\t]*${escapeRegExp(token)}[ \\t]*(?=\\r?\\n|$)`, "g"),
  };
}

const BEGIN_DELIMITER = createDelimitedToken(INTERNAL_RUNTIME_CONTEXT_BEGIN);
const END_DELIMITER = createDelimitedToken(INTERNAL_RUNTIME_CONTEXT_END);

function findDelimitedTokenIndex(
  text: string,
  delimiter: ReturnType<typeof createDelimitedToken>,
  from: number,
): number {
  // Private patterns are reused synchronously; each search owns its offset so
  // nested blocks and later calls never inherit an earlier match's lastIndex.
  delimiter.pattern.lastIndex = Math.max(0, from);
  const match = delimiter.pattern.exec(text);
  if (!match) {
    return -1;
  }
  return match.index + match[0].indexOf(delimiter.token);
}

function findDelimitedTokenLinePrefixStart(text: string, tokenIndex: number): number {
  const lineStart = text.lastIndexOf("\n", tokenIndex - 1) + 1;
  if (lineStart === 0) {
    return 0;
  }
  return text[lineStart - 2] === "\r" ? lineStart - 2 : lineStart - 1;
}

function extractDelimitedBlocks(
  text: string,
  options: { preserveSurroundingWhitespace?: boolean; separator?: string } = {},
): { text: string; blocks: string[] } {
  const begin = BEGIN_DELIMITER;
  const end = END_DELIMITER;
  let next = text;
  const blocks: string[] = [];
  for (;;) {
    const start = findDelimitedTokenIndex(next, begin, 0);
    if (start === -1) {
      return { text: next, blocks };
    }

    let cursor = start + begin.token.length;
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
        cursor = nextBegin + begin.token.length;
        continue;
      }
      depth -= 1;
      finish = nextEnd;
      cursor = nextEnd + end.token.length;
    }

    const blockStart = options.preserveSurroundingWhitespace
      ? findDelimitedTokenLinePrefixStart(next, start)
      : start;
    const before = options.preserveSurroundingWhitespace
      ? next.slice(0, blockStart)
      : next.slice(0, start).trimEnd();
    if (finish === -1 || depth !== 0) {
      return { text: before, blocks };
    }
    let blockEnd = finish + end.token.length;
    while (next[blockEnd] === " " || next[blockEnd] === "\t") {
      blockEnd += 1;
    }
    blocks.push(next.slice(start, blockEnd).trim());
    const after = options.preserveSurroundingWhitespace
      ? next.slice(blockEnd)
      : next.slice(blockEnd).trimStart();
    next =
      !options.preserveSurroundingWhitespace && before && after
        ? `${before}${options.separator ?? "\n\n"}${after}`
        : `${before}${after}`;
  }
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

// Prefaces of carriers persisted before the system prompt explained the markers; kept for stripping.
const RUNTIME_CONTEXT_PROMPT_HEADERS: readonly string[] = [
  "OpenClaw runtime context for the active user request in this turn. Do not reply to or describe this context. Use it to continue answering the active user request now. Do not wait for another message.",
  "OpenClaw runtime context for the immediately preceding user message.",
  OPENCLAW_RUNTIME_EVENT_HEADER,
];

function stripRuntimeContextPromptPreface(text: string): string {
  const lines = text.split(/\r?\n/);
  let changed = false;
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";
    if (
      RUNTIME_CONTEXT_PROMPT_HEADERS.includes(line.trim()) &&
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
export function stripInternalRuntimeContext(
  text: string,
  options: { preserveSurroundingWhitespace?: boolean; separator?: string } = {},
): string {
  // All removable formats contain a delimiter or the exact runtime notice.
  // Skip delimiter scans and line parsing for ordinary display text.
  if (
    !text.includes(INTERNAL_RUNTIME_CONTEXT_BEGIN) &&
    !text.includes(INTERNAL_RUNTIME_CONTEXT_END) &&
    !text.includes(OPENCLAW_RUNTIME_CONTEXT_NOTICE)
  ) {
    return text;
  }
  const withoutDelimitedBlocks = extractDelimitedBlocks(text, options).text.replace(
    END_DELIMITER.pattern,
    "",
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
  const extracted = extractDelimitedBlocks(text);
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
    findDelimitedTokenIndex(text, BEGIN_DELIMITER, 0) !== -1 ||
    text.includes(LEGACY_INTERNAL_CONTEXT_HEADER) ||
    RUNTIME_CONTEXT_PROMPT_HEADERS.some((header) =>
      text.includes(`${header}\n${OPENCLAW_RUNTIME_CONTEXT_NOTICE}`),
    )
  );
}

/** Identifies hidden runtime context independently of its queue or transcript owner. */
export function isOpenClawRuntimeContextCustomMessage(message: unknown): boolean {
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

type RuntimeContextPromptOwner = { user?: unknown; transcriptUser?: unknown; release: () => void };
const retainedRuntimeContextMessages = new WeakMap<object, RuntimeContextPromptOwner>();

/** Prompt submission owns retention through streaming, steering, and retry, then releases it. */
export function retainRuntimeContextMessageForPrompt(message: object): RuntimeContextPromptOwner {
  const owner: RuntimeContextPromptOwner = {
    release: () => {
      retainedRuntimeContextMessages.delete(message);
    },
  };
  retainedRuntimeContextMessages.set(message, owner);
  return owner;
}

function isRetainedRuntimeContextMessage(message: unknown): boolean {
  return (
    typeof message === "object" && message !== null && retainedRuntimeContextMessages.has(message)
  );
}

/** Steering extends this prompt; it does not retire its original user's context. */
export function resolveRuntimeContextPromptOwner(messages: readonly unknown[]) {
  const carrierIndex = messages.findIndex(isRetainedRuntimeContextMessage);
  const carrier = messages[carrierIndex];
  if (typeof carrier !== "object" || carrier === null) {
    return undefined;
  }
  const userIndex = messages.findIndex(
    (message, index) => index > carrierIndex && isUserMessage(message),
  );
  const owner = retainedRuntimeContextMessages.get(carrier);
  return owner ? { owner, userIndex } : undefined;
}

/** Keeps the live prompt's context and unretained context immediately before the active user. */
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
    return currentRuntimeContextIndexes.has(index) || isRetainedRuntimeContextMessage(message);
  });
}

/**
 * Place prompt context after its own user's tool scaffolding, before a later
 * steering user. Full-resend providers keep their cacheable tool prefix, while
 * steering appends without relocating context already sent in the active request.
 * Runs after historical context stripping; already-placed carriers stay put.
 */
export function relocateCurrentRuntimeContextCarrierToTail<T>(messages: T[]): T[] {
  const carrierIndex = messages.findIndex(isOpenClawRuntimeContextCustomMessage);
  const userIndex = messages.findIndex(
    (message, index) => index > carrierIndex && isUserMessage(message),
  );
  if (carrierIndex < 0 || userIndex < 0) {
    return messages;
  }
  const nextUserIndex = messages.findIndex(
    (message, index) => index > userIndex && isUserMessage(message),
  );
  const boundary = nextUserIndex < 0 ? messages.length : nextUserIndex;
  const prefix = messages
    .slice(0, boundary)
    .filter((message) => !isOpenClawRuntimeContextCustomMessage(message));
  const carriers = messages.filter(isOpenClawRuntimeContextCustomMessage);
  return [
    ...prefix,
    ...carriers,
    ...messages
      .slice(boundary)
      .filter((message) => !isOpenClawRuntimeContextCustomMessage(message)),
  ];
}
