import type {
  CliBackendParseJsonlEvent,
  CliBackendParseJsonlLifecycleEvent,
} from "openclaw/plugin-sdk/cli-backend";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { findCodeRegions, type CodeRegion } from "openclaw/plugin-sdk/text-chunking";

const CLAUDE_RAW_TOOL_OUTPUT_ERROR =
  "Claude CLI returned malformed tool output (invalid request format): raw tool protocol appeared as assistant text. OpenClaw refused to persist or deliver it.";

const RAW_INVOKE_TAG_RE = /<invoke(?=[ \t>])[^<>\r\n]*>/gu;
const RAW_PARAMETER_TAG_RE = /<parameter(?=[ \t>])[^<>\r\n]*>/gu;
const RAW_INVOKE_CLOSE_TAG_RE = /<\/invoke[ \t]*>/gu;
const RAW_PARAMETER_LOOKAHEAD_CHARS = 2_048;
const OBSERVED_TRUNCATED_LEAK_PREFIXES = new Set(["call", "count", "court"]);

function readTagNameAttribute(tag: string, elementName: "invoke" | "parameter"): string {
  const attribute = /[ \t]+([^\s=/>]+)[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)')/gy;
  const tagEnd = tag.length - 1;
  let cursor = elementName.length + 1;
  while (cursor < tagEnd) {
    attribute.lastIndex = cursor;
    const match = attribute.exec(tag);
    if (!match) {
      return "";
    }
    if (match[1] === "name") {
      return match[2] ?? match[3] ?? "";
    }
    cursor = attribute.lastIndex;
  }
  return "";
}

function isStandaloneLineTag(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return /^[ ]{0,3}$/u.test(text.slice(lineStart, index));
}

function isStandaloneOpeningTagLine(text: string, index: number, tagLength: number): boolean {
  if (!isStandaloneLineTag(text, index)) {
    return false;
  }
  const lineEnd = text.indexOf("\n", index + tagLength);
  const trailingText = text.slice(index + tagLength, lineEnd === -1 ? text.length : lineEnd);
  return /^[ \t]*\r?$/u.test(trailingText);
}

function isInsideCodeRegion(index: number, regions: CodeRegion[]): boolean {
  let low = 0;
  let high = regions.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const region = regions[middle];
    if (!region) {
      return false;
    }
    if (index < region.start) {
      high = middle - 1;
    } else if (index >= region.end) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

function hasObservedTruncatedLeakPrefix(text: string, index: number, toolName: string): boolean {
  const previousNonEmptyLine = text
    .slice(0, index)
    .split(/\r?\n/gu)
    .findLast((line) => line.trim().length > 0)
    ?.trim();
  return (
    previousNonEmptyLine === toolName ||
    (previousNonEmptyLine !== undefined &&
      OBSERVED_TRUNCATED_LEAK_PREFIXES.has(previousNonEmptyLine))
  );
}

function findNextStandaloneTag(
  text: string,
  index: number,
  regions: CodeRegion[],
  pattern: RegExp,
): number | null {
  const scanner = new RegExp(pattern.source, pattern.flags);
  scanner.lastIndex = index;
  for (let match = scanner.exec(text); match; match = scanner.exec(text)) {
    if (
      isStandaloneOpeningTagLine(text, match.index, match[0].length) &&
      !isInsideCodeRegion(match.index, regions)
    ) {
      return match.index;
    }
  }
  return null;
}

/** Detect Claude's legacy tool protocol only when it occupies standalone assistant lines. */
export function hasClaudeRawToolInvocation(text: string): boolean {
  if (!text.includes("<invoke") || !text.includes("<parameter")) {
    return false;
  }

  const codeRegions = findCodeRegions(text);
  RAW_INVOKE_TAG_RE.lastIndex = 0;
  for (const match of text.matchAll(RAW_INVOKE_TAG_RE)) {
    const index = match.index;
    const toolName = readTagNameAttribute(match[0], "invoke");
    if (
      (!/^[A-Z]/u.test(toolName) && !toolName.startsWith("mcp__")) ||
      !isStandaloneOpeningTagLine(text, index, match[0].length) ||
      isInsideCodeRegion(index, codeRegions)
    ) {
      continue;
    }

    const invocationBodyStart = index + match[0].length;
    const invokeCloseIndex = findNextStandaloneTag(
      text,
      invocationBodyStart,
      codeRegions,
      RAW_INVOKE_CLOSE_TAG_RE,
    );
    const nextInvokeIndex = findNextStandaloneTag(
      text,
      invocationBodyStart,
      codeRegions,
      RAW_INVOKE_TAG_RE,
    );
    const completeInvokeCloseIndex =
      invokeCloseIndex !== null && (nextInvokeIndex === null || invokeCloseIndex < nextInvokeIndex)
        ? invokeCloseIndex
        : null;
    const parameterSearchEnd = Math.min(
      text.length,
      invocationBodyStart + RAW_PARAMETER_LOOKAHEAD_CHARS,
      completeInvokeCloseIndex ?? text.length,
      nextInvokeIndex ?? text.length,
    );
    const parameterText = text.slice(invocationBodyStart, parameterSearchEnd);
    let parameterIndex: number | null = null;
    for (const parameterMatch of parameterText.matchAll(RAW_PARAMETER_TAG_RE)) {
      const candidateIndex = invocationBodyStart + parameterMatch.index;
      if (
        readTagNameAttribute(parameterMatch[0], "parameter") &&
        isStandaloneLineTag(text, candidateIndex) &&
        !isInsideCodeRegion(candidateIndex, codeRegions)
      ) {
        parameterIndex = candidateIndex;
        break;
      }
    }
    if (parameterIndex === null) {
      continue;
    }
    if (
      // Upstream shows both complete blocks and prefix-led truncated blocks. Requiring a close
      // misses the latter; requiring a prefix misses the complete leak reproduced in this PR.
      // Complete unfenced examples remain the accepted false positive and surface as format errors.
      completeInvokeCloseIndex !== null ||
      (completeInvokeCloseIndex === null && hasObservedTruncatedLeakPrefix(text, index, toolName))
    ) {
      return true;
    }
  }
  return false;
}

function parseClaudeJsonlRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Project Claude-owned lifecycle records without widening the legacy parser event union. */
export const parseClaudeCliJsonlLifecycleEvent: CliBackendParseJsonlLifecycleEvent = (line) => {
  if (!line.includes("compacting") && !line.includes("compact_result")) {
    return null;
  }
  const parsed = parseClaudeJsonlRecord(line);
  if (!parsed) {
    return null;
  }
  if (parsed.compact_result === "success" || parsed.compact_result === "failed") {
    return {
      kind: "compaction",
      phase: "end",
      completed: parsed.compact_result === "success",
    };
  }
  if (parsed.type === "system" && parsed.subtype === "status") {
    return parsed.status === "compacting" ? { kind: "compaction", phase: "start" } : null;
  }
  return null;
};

/** Reject malformed terminal Claude results before the generic CLI runner accepts them as prose. */
export const parseClaudeCliJsonlEvent: CliBackendParseJsonlEvent = (line) => {
  const mightContainRawToolProtocol =
    (line.includes("<invoke") ||
      line.includes("\\u003cinvoke") ||
      line.includes("\\u003Cinvoke")) &&
    (line.includes("<parameter") ||
      line.includes("\\u003cparameter") ||
      line.includes("\\u003Cparameter"));
  if (!mightContainRawToolProtocol) {
    return null;
  }
  const parsed = parseClaudeJsonlRecord(line);
  if (!parsed) {
    return null;
  }
  if (
    parsed.type !== "result" ||
    typeof parsed.result !== "string" ||
    !hasClaudeRawToolInvocation(parsed.result)
  ) {
    return null;
  }
  // Core classifies this exact phrase as a format failure, enabling safe fallback instead of
  // accepting the malformed terminal result as a successful assistant response.
  return { kind: "result", errorText: CLAUDE_RAW_TOOL_OUTPUT_ERROR };
};
