// Markdown Core owns block-aware incremental reasoning-tag partitioning.
import {
  REASONING_TAG_NAMES,
  REASONING_TAG_NAME_SET,
  findNextLineEnding,
  isInsideCode,
  isTagNameCharacter,
  isTagWhitespace,
  parseMarkdownOwnership,
  parseReasoningTagAt,
  reduceReasoningText,
  scanReasoningTags,
  skipTagWhitespace,
  type ReasoningTagTextDelta,
  type ReductionState,
} from "./reasoning-tag-parser.js";

export {
  findMarkdownCodeSpans,
  scanReasoningTags,
  stripReasoningTagsFromMarkdown,
} from "./reasoning-tag-parser.js";
export type { ReasoningTagTextDelta } from "./reasoning-tag-parser.js";

const MARKDOWN_CONTAINER_LINE_RE = /^(?: {0,3}(?:>|[-+*][\t ]|\d{1,9}[.)][\t ]))/mu;
const BLANK_BOUNDARY_RE = /(?:\r\n|\r(?!\n)|\n)[\t ]*(?:\r\n|\r(?!\n)|\n)$/u;

type PendingTagProbe = {
  nameResolved: boolean;
  quote?: '"' | "'";
  resolved: boolean;
  scannedThrough: number;
  start: number;
};

function reasoningTagNameStatus(text: string): "invalid" | "partial" | "resolved" {
  let cursor = skipTagWhitespace(text, 1);
  if (text.charAt(cursor) === "/") {
    cursor = skipTagWhitespace(text, cursor + 1);
  }
  const start = cursor;
  while (cursor < text.length && isTagNameCharacter(text.charCodeAt(cursor))) {
    cursor += 1;
  }
  const name = text.slice(start, cursor).toLowerCase();
  if (!name) {
    return cursor === text.length ? "partial" : "invalid";
  }
  if (!REASONING_TAG_NAME_SET.has(name)) {
    return REASONING_TAG_NAMES.some((known) => known.startsWith(name)) && cursor === text.length
      ? "partial"
      : "invalid";
  }
  if (cursor === text.length) {
    return "partial";
  }
  const boundary = text.charAt(cursor);
  return isTagWhitespace(boundary) || boundary === "/" || boundary === ">" ? "resolved" : "invalid";
}

function advancePendingTagProbe(probe: PendingTagProbe, text: string): void {
  for (const char of text) {
    if (probe.quote) {
      if (char === probe.quote) {
        probe.quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      probe.quote = char;
    } else if (char === ">" || char === "<") {
      probe.resolved = true;
      return;
    }
  }
}

export interface ReasoningTagTextPartitioner {
  markStrict(): void;
  push(chunk: string): ReasoningTagTextDelta[];
  pushVisible(chunk: string): ReasoningTagTextDelta[];
  flush(): ReasoningTagTextDelta[];
  hasPending(): boolean;
  isInsideReasoning(): boolean;
}

/** Creates a block-incremental parser that emits only Markdown-stable text. */
export function createReasoningTagTextPartitioner(): ReasoningTagTextPartitioner {
  const reduction: ReductionState = { depth: 0, visibleEver: false };
  let source = "";
  let blockStart = 0;
  let emitted = 0;
  let holdStart: number | undefined;
  let heldBacktickStart: number | undefined;
  let strictMode = false;
  let pendingTagProbe: PendingTagProbe | undefined;
  let fastPathCheckedThrough = 0;
  let fastPathCodeSafe = false;
  let nonFinalFullParses = 0;
  let nonFinalCodeSpans: Array<[number, number]> | undefined;
  let nonFinalCodeSpansEnd = 0;
  let nonFinalOpenEndedCode = false;
  let nonFinalRetainStart = 0;
  let nonFinalCloseReparseUsed = false;

  const compactCommittedSource = (retainStart: number) => {
    source = source.slice(retainStart);
    blockStart = source.length;
    emitted = source.length;
    holdStart = undefined;
    heldBacktickStart = undefined;
    pendingTagProbe = undefined;
    fastPathCheckedThrough = 0;
    fastPathCodeSafe = false;
    nonFinalFullParses = 0;
    nonFinalCodeSpans = undefined;
    nonFinalCodeSpansEnd = 0;
    nonFinalOpenEndedCode = false;
    nonFinalRetainStart = 0;
    nonFinalCloseReparseUsed = false;
  };

  const merge = (target: ReasoningTagTextDelta[], additions: ReasoningTagTextDelta[]) => {
    for (const addition of additions) {
      const previous = target.at(-1);
      if (previous?.kind === addition.kind) {
        previous.text += addition.text;
      } else {
        target.push({ ...addition });
      }
    }
  };

  const emitSafePrefix = (limit: number, output: ReasoningTagTextDelta[]) => {
    if (strictMode) {
      holdStart ??= emitted;
      return;
    }
    if (reduction.depth > 0) {
      holdStart ??= emitted;
      const segment = source.slice(emitted, limit);
      if (!fastPathCodeSafe || /[\r\n`]/u.test(segment)) {
        return;
      }
      const scan = scanReasoningTags(segment, false);
      const reduceEnd = scan.pendingStart === undefined ? limit : emitted + scan.pendingStart;
      merge(
        output,
        reduceReasoningText(source.slice(emitted, reduceEnd), [], reduction, {
          final: false,
          mode: "visible",
          scope: "all",
        }),
      );
      emitted = reduceEnd;
      fastPathCheckedThrough = reduceEnd;
      if (scan.pendingStart !== undefined) {
        pendingTagProbe = {
          nameResolved: false,
          resolved: false,
          scannedThrough: limit,
          start: reduceEnd,
        };
        advancePendingTagProbe(pendingTagProbe, source.slice(reduceEnd + 1, limit));
      }
      holdStart = reduction.depth > 0 || scan.pendingStart !== undefined ? emitted : undefined;
      return;
    }
    if (holdStart !== undefined || emitted >= limit) {
      return;
    }
    while (emitted < limit && holdStart === undefined) {
      let special = -1;
      for (let index = emitted; index < limit; index += 1) {
        const char = source.charAt(index);
        if (char === "<" || char === "`") {
          special = index;
          break;
        }
      }
      const end = special === -1 ? limit : special;
      if (special !== -1 && source.charAt(special) === "`") {
        heldBacktickStart = special;
        holdStart = emitted;
        return;
      }
      const text = source.slice(emitted, end);
      if (text) {
        merge(output, [{ kind: "text", text }]);
        if (text.trim()) {
          reduction.visibleEver = true;
        }
        emitted = end;
      }
      if (special === -1) {
        return;
      }
      const tail = source.slice(special, limit);
      const parsed = parseReasoningTagAt(tail, 0, false);
      if (parsed.kind === "invalid") {
        merge(output, [{ kind: "text", text: "<" }]);
        reduction.visibleEver = true;
        emitted = special + 1;
        continue;
      }
      holdStart = special;
      if (parsed.kind === "pending") {
        pendingTagProbe = {
          nameResolved: false,
          resolved: false,
          scannedThrough: limit,
          start: special,
        };
        advancePendingTagProbe(pendingTagProbe, tail.slice(1));
        return;
      }

      if (/[\r\n]/u.test(source.slice(blockStart, special))) {
        return;
      }

      const fastPathInvalidated = /[\r\n`]/u.test(source.slice(fastPathCheckedThrough, special));
      if (!fastPathCodeSafe || fastPathInvalidated) {
        if (nonFinalFullParses >= 1) {
          return;
        }
        nonFinalFullParses += 1;
        const ownership = parseMarkdownOwnership(source.slice(0, limit));
        nonFinalCodeSpans = ownership.codeSpans;
        nonFinalCodeSpansEnd = limit;
        nonFinalOpenEndedCode = nonFinalCodeSpans.some(([, spanEnd]) => spanEnd === limit);
        nonFinalRetainStart = ownership.retainStart;
        fastPathCodeSafe =
          !source.slice(blockStart, special).includes("`") &&
          !isInsideCode(special, nonFinalCodeSpans);
      }
      if (!fastPathCodeSafe) {
        return;
      }

      const nextBacktick = source.indexOf("`", special);
      const nextCarriageReturn = source.indexOf("\r", special);
      const nextLineFeed = source.indexOf("\n", special);
      const boundaries = [nextBacktick, nextCarriageReturn, nextLineFeed].filter(
        (index) => index !== -1 && index < limit,
      );
      const safeLimit = boundaries.length > 0 ? Math.min(...boundaries) : limit;
      const safeTail = source.slice(special, safeLimit);
      const scan = scanReasoningTags(safeTail, false);
      const pendingAt = scan.pendingStart;
      const reduceEnd = pendingAt === undefined ? safeLimit : special + pendingAt;
      merge(
        output,
        reduceReasoningText(source.slice(special, reduceEnd), [], reduction, {
          final: false,
          mode: "visible",
          scope: "all",
        }),
      );
      emitted = reduceEnd;
      fastPathCheckedThrough = reduceEnd;
      if (pendingAt !== undefined) {
        holdStart = reduceEnd;
        pendingTagProbe = {
          nameResolved: false,
          resolved: false,
          scannedThrough: limit,
          start: reduceEnd,
        };
        advancePendingTagProbe(pendingTagProbe, source.slice(reduceEnd + 1, limit));
      } else {
        holdStart = reduction.depth > 0 ? emitted : undefined;
      }
    }
  };

  const processBlock = (
    end: number,
    final: boolean,
    output: ReasoningTagTextDelta[],
    parsedCodeSpans?: Array<[number, number]>,
    parsedRetainStart?: number,
  ): boolean => {
    const previousBlockStart = blockStart;
    let blockCodeSpans = parsedCodeSpans;
    let blockRetainStart = parsedRetainStart;
    const finalizePending = () => {
      if (!final || reduction.depth === 0) {
        return;
      }
      merge(
        output,
        reduceReasoningText("", [], reduction, {
          final: true,
          mode: strictMode ? "hide" : "visible",
          scope: "all",
        }),
      );
    };
    if (end <= blockStart) {
      finalizePending();
      return true;
    }
    if (end <= emitted) {
      finalizePending();
      blockStart = end;
      fastPathCheckedThrough = Math.max(fastPathCheckedThrough, end);
      return true;
    }
    emitSafePrefix(end, output);
    if (holdStart !== undefined && holdStart < end) {
      const held = source.slice(holdStart, end);
      if (!final) {
        if (pendingTagProbe && !pendingTagProbe.resolved) {
          return false;
        }
        pendingTagProbe = undefined;
        const pendingStart = scanReasoningTags(held, false).pendingStart;
        if (pendingStart !== undefined) {
          pendingTagProbe = {
            nameResolved: false,
            resolved: false,
            scannedThrough: end,
            start: holdStart + pendingStart,
          };
          advancePendingTagProbe(pendingTagProbe, held.slice(pendingStart + 1));
          return false;
        }
      }
      const block = source.slice(0, end);
      const start = holdStart;
      if (!blockCodeSpans) {
        const ownership = parseMarkdownOwnership(block);
        blockCodeSpans = ownership.codeSpans;
        blockRetainStart = ownership.retainStart;
      }
      merge(
        output,
        reduceReasoningText(block, blockCodeSpans, reduction, {
          final,
          mode: strictMode ? "hide" : "visible",
          scope: "all",
          start,
        }),
      );
      emitted = end;
    } else if (emitted < end) {
      const text = source.slice(emitted, end);
      merge(output, [{ kind: "text", text }]);
      if (text.trim()) {
        reduction.visibleEver = true;
      }
      emitted = end;
    }
    finalizePending();
    const processedText = source.slice(previousBlockStart, end);
    const lastLineStart =
      Math.max(
        source.lastIndexOf("\n", Math.max(0, end - 1)),
        source.lastIndexOf("\r", Math.max(0, end - 1)),
      ) + 1;
    const crossedLineBoundary = /[\r\n]/u.test(processedText);
    blockStart = crossedLineBoundary && lastLineStart < end ? lastLineStart : end;
    holdStart = strictMode || reduction.depth > 0 ? end : undefined;
    heldBacktickStart = undefined;
    if (reduction.depth === 0) {
      nonFinalCloseReparseUsed = false;
    }
    pendingTagProbe = undefined;
    fastPathCheckedThrough = end;
    fastPathCodeSafe =
      !final &&
      !crossedLineBoundary &&
      emitted === source.length &&
      !blockCodeSpans?.some(([, spanEnd]) => spanEnd === source.length);
    if (
      !final &&
      reduction.depth === 0 &&
      emitted === source.length &&
      BLANK_BOUNDARY_RE.test(source) &&
      !MARKDOWN_CONTAINER_LINE_RE.test(source.slice(blockRetainStart ?? 0)) &&
      !blockCodeSpans?.some(([, spanEnd]) => spanEnd === source.length)
    ) {
      // A blank-terminated top-level block cannot gain code ownership from later input.
      // Drop it so block-incremental parsing stays bounded; containers retain their prefix.
      compactCommittedSource(blockRetainStart ?? 0);
    }
    return true;
  };

  const consume = (chunk: string, strict: boolean, final: boolean) => {
    strictMode ||= strict;
    const previousLength = source.length;
    const previousEndedBlankBlock = BLANK_BOUNDARY_RE.test(source);
    source += chunk;
    const appended = source.slice(previousLength);
    const appendedBlock = appended.replace(/^(?:\r\n|\r|\n)+/u, "");
    const appendedStartsTopLevelBlock =
      previousEndedBlankBlock &&
      /^[^\t \r\n]/u.test(appendedBlock) &&
      !MARKDOWN_CONTAINER_LINE_RE.test(appendedBlock);
    if (pendingTagProbe && !pendingTagProbe.resolved) {
      advancePendingTagProbe(pendingTagProbe, source.slice(pendingTagProbe.scannedThrough));
      pendingTagProbe.scannedThrough = source.length;
      if (!pendingTagProbe.nameResolved) {
        const status = reasoningTagNameStatus(source.slice(pendingTagProbe.start));
        pendingTagProbe.nameResolved = status === "resolved";
        pendingTagProbe.resolved ||= status === "invalid";
      }
    }
    if (pendingTagProbe?.resolved && holdStart !== undefined) {
      pendingTagProbe = undefined;
      holdStart = undefined;
      heldBacktickStart = undefined;
    }
    const output: ReasoningTagTextDelta[] = [];
    if (final) {
      processBlock(source.length, true, output);
    } else {
      emitSafePrefix(source.length, output);
      if (!strictMode && holdStart !== undefined && holdStart < source.length) {
        const ownershipStart = heldBacktickStart ?? holdStart;
        const heldLineStart =
          Math.max(
            source.lastIndexOf("\n", Math.max(0, ownershipStart - 1)),
            source.lastIndexOf("\r", Math.max(0, ownershipStart - 1)),
          ) + 1;
        const heldLineEnd = findNextLineEnding(source, ownershipStart);
        const heldLine = source.slice(
          heldLineStart,
          heldLineEnd === -1 ? source.length : heldLineEnd,
        );
        const tableLookaheadPending =
          heldLine.includes("|") &&
          (heldLineEnd === -1 ||
            findNextLineEnding(
              source,
              heldLineEnd +
                (source.charAt(heldLineEnd) === "\r" && source.charAt(heldLineEnd + 1) === "\n"
                  ? 2
                  : 1),
            ) === -1);
        const completedBlankBlock = BLANK_BOUNDARY_RE.test(source);
        const retainedContainerContext = MARKDOWN_CONTAINER_LINE_RE.test(
          source.slice(nonFinalRetainStart),
        );
        const heldBacktick = heldBacktickStart !== undefined;
        let openingRunEnd = ownershipStart;
        while (source.charAt(openingRunEnd) === "`") {
          openingRunEnd += 1;
        }
        const hasLaterBacktick = !heldBacktick || source.includes("`", openingRunEnd);
        const terminatedBacktickTail = !heldBacktick || source.at(-1) !== "`";
        const shouldTryParser = pendingTagProbe
          ? pendingTagProbe.resolved
          : reduction.depth > 0
            ? appended.includes("<")
            : !heldBacktick || (hasLaterBacktick && terminatedBacktickTail) || completedBlankBlock;
        const mayResolveHeldReasoning =
          reduction.depth > 0 &&
          !nonFinalCloseReparseUsed &&
          (appended.includes("<") || appended.includes(">")) &&
          scanReasoningTags(source.slice(holdStart), false).tags.some((tag) => tag.isClose);
        const reusableCodeSpans =
          nonFinalCodeSpansEnd === source.length ? nonFinalCodeSpans : undefined;
        const mayCloseTopLevelBlock =
          completedBlankBlock &&
          (!retainedContainerContext || appendedStartsTopLevelBlock) &&
          !nonFinalOpenEndedCode;
        if (
          (shouldTryParser || mayResolveHeldReasoning) &&
          !tableLookaheadPending &&
          (reusableCodeSpans !== undefined ||
            nonFinalFullParses < 1 ||
            mayCloseTopLevelBlock ||
            mayResolveHeldReasoning)
        ) {
          if (!reusableCodeSpans) {
            nonFinalFullParses += 1;
          }
          const ownership = reusableCodeSpans ? undefined : parseMarkdownOwnership(source);
          nonFinalCloseReparseUsed ||= mayResolveHeldReasoning;
          const codeSpans = reusableCodeSpans ?? ownership?.codeSpans ?? [];
          const retainStart = reusableCodeSpans
            ? nonFinalRetainStart
            : (ownership?.retainStart ?? 0);
          nonFinalRetainStart = retainStart;
          nonFinalOpenEndedCode = codeSpans.some(([, spanEnd]) => spanEnd === source.length);
          const heldCodeSpan = codeSpans.find(
            ([start, end]) => ownershipStart >= start && ownershipStart < end,
          );
          const heldInOpenEndedCode = heldCodeSpan?.[1] === source.length;
          const stableCode = heldCodeSpan !== undefined && !heldInOpenEndedCode;
          const stableNonDelimiter =
            heldBacktick && heldCodeSpan === undefined && completedBlankBlock;
          if ((!heldBacktick && !heldInOpenEndedCode) || stableCode || stableNonDelimiter) {
            let processEnd = source.length;
            if (stableNonDelimiter) {
              processEnd = source.length;
            } else if (mayCloseTopLevelBlock) {
              processEnd = source.length;
            } else if (stableCode && heldCodeSpan) {
              processEnd = heldCodeSpan[1];
              while (processEnd < source.length) {
                const char = source.charAt(processEnd);
                if (char === "\r" || char === "\n" || char === "<" || char === "`") {
                  break;
                }
                processEnd += 1;
              }
            } else {
              const nextBacktick = source.indexOf("`", holdStart);
              if (nextBacktick !== -1) {
                processEnd = nextBacktick;
              }
            }
            if (processEnd > holdStart) {
              const stableTagSuffix =
                processEnd < source.length &&
                source.charAt(processEnd) === "<" &&
                !isInsideCode(processEnd, codeSpans);
              processBlock(processEnd, false, output, codeSpans, retainStart);
              if (stableTagSuffix) {
                fastPathCodeSafe = true;
                fastPathCheckedThrough = processEnd;
                emitSafePrefix(source.length, output);
              }
            }
          }
        }
      }
      if (
        holdStart === undefined &&
        reduction.depth === 0 &&
        emitted === source.length &&
        BLANK_BOUNDARY_RE.test(source) &&
        (!MARKDOWN_CONTAINER_LINE_RE.test(source.slice(nonFinalRetainStart)) ||
          appendedStartsTopLevelBlock) &&
        nonFinalFullParses < 1
      ) {
        nonFinalFullParses += 1;
        const ownership = parseMarkdownOwnership(source);
        const codeSpans = ownership.codeSpans;
        nonFinalRetainStart = ownership.retainStart;
        nonFinalOpenEndedCode = codeSpans.some(([, spanEnd]) => spanEnd === source.length);
        if (!codeSpans.some(([, spanEnd]) => spanEnd === source.length)) {
          compactCommittedSource(ownership.retainStart);
        }
      }
    }
    if (final) {
      compactCommittedSource(source.length);
    }
    return output;
  };

  return {
    markStrict() {
      strictMode = true;
      holdStart ??= emitted;
    },
    push(chunk) {
      return consume(chunk, true, false);
    },
    pushVisible(chunk) {
      return consume(chunk, false, false);
    },
    flush() {
      return consume("", strictMode, true);
    },
    hasPending() {
      return (
        (holdStart !== undefined && holdStart < source.length) ||
        reduction.depth > 0 ||
        emitted < source.length
      );
    },
    isInsideReasoning() {
      return reduction.depth > 0;
    },
  };
}
