import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { DEEPSEEK_DSML_MARKERS, DEEPSEEK_DSML_MARKER_PATTERN } from "./deepseek-dsml-grammar.js";
import { measureUtf8AppendBytes } from "./openai-transport-shared.js";

export type RecoveredDeepSeekDsmlToolCall = {
  kind: "toolCall";
  name: string;
  arguments: Record<string, unknown>;
  partialArgs: string;
};

type DeepSeekDsmlRecoveredPart = { kind: "text"; text: string } | RecoveredDeepSeekDsmlToolCall;

const DEEPSEEK_DSML_TOOL_KINDS = ["tool_calls", "tool_call", "function_calls"] as const;
const DEEPSEEK_DSML_TOOL_OPEN_TOKENS = DEEPSEEK_DSML_MARKERS.flatMap((marker) =>
  DEEPSEEK_DSML_TOOL_KINDS.map((kind) => `<${marker}${kind}>`),
);
const DEEPSEEK_DSML_INVOKE_OPEN_PREFIXES = DEEPSEEK_DSML_MARKERS.map(
  (marker) => `<${marker}invoke`,
);
const DEEPSEEK_DSML_INVOKE_OPEN_TAG = new RegExp(
  `^<${DEEPSEEK_DSML_MARKER_PATTERN}invoke\\b[^<>]*>$`,
);
const DEEPSEEK_DSML_TOOL_MAX_OPEN_TOKEN_LEN = Math.max(
  ...DEEPSEEK_DSML_TOOL_OPEN_TOKENS.map((token) => token.length),
);
const DEEPSEEK_DSML_RECOVERY_MAX_BOUNDARY_LEN = Math.max(
  ...DEEPSEEK_DSML_TOOL_OPEN_TOKENS.map((token) => token.length + 1),
  ...DEEPSEEK_DSML_INVOKE_OPEN_PREFIXES.map((token) => token.length + 2),
);

// Match the shared Chat tool-argument and post-tool-call buffer limits.
const MAX_DSML_RECOVERY_BUFFER_BYTES = 256_000;
const DEEPSEEK_DSML_SCAN_BATCH_CHARS = 64 * 1_024;

type DeepSeekDsmlToolBlockScanState = {
  offset: number;
  invoke?: { kind: "open"; start: number } | { kind: "body"; closeToken: string };
};

export function createDsmlRecoverer() {
  let buffer = "";
  let bufferBytes = 0;
  let bufferEndsWithHighSurrogate = false;
  let pendingScanChars = 0;
  let activeOpenToken: string | null = null;
  let blockScanState: DeepSeekDsmlToolBlockScanState = { offset: 0 };
  const resetBlockScan = () => {
    activeOpenToken = null;
    pendingScanChars = 0;
    blockScanState = { offset: 0 };
  };

  const consume = (final: boolean): DeepSeekDsmlRecoveredPart[] => {
    const output: DeepSeekDsmlRecoveredPart[] = [];
    while (buffer) {
      const open = activeOpenToken
        ? { index: 0, token: activeOpenToken }
        : findEarliestStringToken(buffer, DEEPSEEK_DSML_TOOL_OPEN_TOKENS);
      if (!open) {
        resetBlockScan();
        if (final) {
          output.push({ kind: "text", text: buffer });
          buffer = "";
          bufferBytes = 0;
          bufferEndsWithHighSurrogate = false;
          return output;
        }
        const keep = longestDeepSeekDsmlToolOpenPrefixSuffixLength(buffer);
        const emitLength = buffer.length - keep;
        if (emitLength > 0) {
          const emitted = buffer.slice(0, emitLength);
          output.push({ kind: "text", text: emitted });
          bufferBytes -= Buffer.byteLength(emitted, "utf8");
          buffer = buffer.slice(emitted.length);
          if (!buffer) {
            bufferEndsWithHighSurrogate = false;
          }
        }
        return output;
      }

      if (open.index > 0) {
        const prefix = buffer.slice(0, open.index);
        output.push({ kind: "text", text: prefix });
        bufferBytes -= Buffer.byteLength(prefix, "utf8");
        buffer = buffer.slice(prefix.length);
        resetBlockScan();
      }

      activeOpenToken = open.token;
      if (blockScanState.offset === 0) {
        blockScanState.offset = open.token.length;
      }
      const blockScan = scanDeepSeekDsmlToolBlock(
        buffer,
        open.token.replace("<", "</"),
        open.token.length,
        blockScanState,
      );
      if (blockScan.kind === "nested-open") {
        throw new Error("Nested DeepSeek DSML recovery wrappers are not supported");
      }
      const close = blockScan.kind === "close" ? blockScan : null;
      if (!close) {
        if (final) {
          output.push({ kind: "text", text: buffer });
          buffer = "";
          bufferBytes = 0;
          bufferEndsWithHighSurrogate = false;
          return output;
        }
        if (bufferBytes > MAX_DSML_RECOVERY_BUFFER_BYTES) {
          throw new Error("Exceeded DeepSeek DSML recovery buffer limit");
        }
        return output;
      }

      resetBlockScan();
      const body = buffer.slice(open.token.length, close.index);
      const blockText = buffer.slice(0, close.index + close.token.length);
      const blockBytes = Buffer.byteLength(blockText, "utf8");
      if (blockBytes > MAX_DSML_RECOVERY_BUFFER_BYTES) {
        throw new Error("Exceeded DeepSeek DSML recovery buffer limit");
      }
      const recoveredToolCalls = parseDeepSeekDsmlToolCallBlock(body);
      if (recoveredToolCalls.length > 0) {
        output.push(...recoveredToolCalls);
      } else {
        output.push({ kind: "text", text: blockText });
      }
      bufferBytes -= Buffer.byteLength(blockText, "utf8");
      buffer = buffer.slice(blockText.length);
      if (!buffer) {
        bufferEndsWithHighSurrogate = false;
      }
    }
    return output;
  };

  return {
    push(chunk: string) {
      const append = measureUtf8AppendBytes(bufferEndsWithHighSurrogate, chunk);
      bufferBytes += append.bytes;
      bufferEndsWithHighSurrogate = append.endsWithHighSurrogate;
      buffer += chunk;
      pendingScanChars += chunk.length;
      if (
        activeOpenToken &&
        pendingScanChars < DEEPSEEK_DSML_SCAN_BATCH_CHARS &&
        !chunk.includes("<") &&
        !chunk.includes(">") &&
        bufferBytes <= MAX_DSML_RECOVERY_BUFFER_BYTES
      ) {
        return [];
      }
      pendingScanChars = 0;
      return consume(false);
    },
    flush() {
      return consume(true);
    },
  };
}

function parseDeepSeekDsmlToolCallBlock(body: string): RecoveredDeepSeekDsmlToolCall[] {
  const toolCalls: RecoveredDeepSeekDsmlToolCall[] = [];
  const invokeOpenRegex = new RegExp(`<${DEEPSEEK_DSML_MARKER_PATTERN}invoke\\b([^<>]*)>`, "g");
  let openMatch: RegExpExecArray | null;
  while ((openMatch = invokeOpenRegex.exec(body)) !== null) {
    const invokeBodyStart = openMatch.index + openMatch[0].length;
    const invokeCloseToken = `</${openMatch[1]}invoke>`;
    const invokeCloseIndex = body.indexOf(invokeCloseToken, invokeBodyStart);
    if (invokeCloseIndex === -1) {
      break;
    }
    const invokeBody = body.slice(invokeBodyStart, invokeCloseIndex);
    invokeOpenRegex.lastIndex = invokeCloseIndex + invokeCloseToken.length;
    const invokeName = parseXmlAttribute(openMatch[2] ?? "", "name");
    if (!invokeName) {
      continue;
    }
    const parsedArguments = parseDeepSeekDsmlInvokeArguments(invokeBody);
    if (!parsedArguments) {
      continue;
    }
    toolCalls.push({
      kind: "toolCall",
      name: invokeName,
      arguments: parsedArguments,
      partialArgs: JSON.stringify(parsedArguments),
    });
  }
  return toolCalls;
}

function parseDeepSeekDsmlInvokeArguments(body: string): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  const parameterRegex = new RegExp(
    `<${DEEPSEEK_DSML_MARKER_PATTERN}parameter\\b([^>]*)>([\\s\\S]*?)</\\1parameter>`,
    "g",
  );
  let parameterMatch: RegExpExecArray | null;
  while ((parameterMatch = parameterRegex.exec(body)) !== null) {
    const name = parseXmlAttribute(parameterMatch[2] ?? "", "name");
    if (!name) {
      continue;
    }
    const rawValue = parameterMatch[3] ?? "";
    if (rawValue.length === 0) {
      continue;
    }
    args[name] = decodeDeepSeekDsmlText(rawValue);
  }
  if (Object.keys(args).length > 0) {
    return args;
  }

  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed) && Object.keys(parsed).length > 0) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

// Cache compiled attribute matchers by name so the streaming parser does not
// recompile a RegExp on every chunk/parameter it scans.
const xmlAttributeRegexCache = new Map<string, RegExp>();

function xmlAttributeRegex(name: string): RegExp {
  const cached = xmlAttributeRegexCache.get(name);
  if (cached) {
    return cached;
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}=("([^"]*)"|'([^']*)'|([^\\s>]+))`);
  xmlAttributeRegexCache.set(name, pattern);
  return pattern;
}

function parseXmlAttribute(attributes: string, name: string): string | null {
  const match = xmlAttributeRegex(name).exec(attributes);
  const value = match?.[2] ?? match?.[3] ?? match?.[4];
  return value ? decodeDeepSeekDsmlText(value) : null;
}

function decodeDeepSeekDsmlText(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function findEarliestStringToken(text: string, tokens: readonly string[], fromIndex = 0) {
  let best: { index: number; token: string } | null = null;
  for (const token of tokens) {
    const index = text.indexOf(token, fromIndex);
    if (index !== -1 && (!best || index < best.index)) {
      best = { index, token };
    }
  }
  return best;
}

function scanDeepSeekDsmlToolBlock(
  text: string,
  closeToken: string,
  contentStartIndex: number,
  state: DeepSeekDsmlToolBlockScanState,
):
  | { kind: "close"; index: number; token: string }
  | { kind: "nested-open"; index: number; token: string }
  | { kind: "incomplete" } {
  while (state.offset < text.length) {
    if (state.invoke?.kind === "open") {
      const nextOpen = text.indexOf("<", state.offset);
      const nextClose = text.indexOf(">", state.offset);
      if (nextClose === -1 && nextOpen === -1) {
        state.offset = text.length;
        return { kind: "incomplete" };
      }
      if (nextOpen !== -1 && (nextClose === -1 || nextOpen < nextClose)) {
        state.invoke = undefined;
        state.offset = nextOpen;
        continue;
      }
      const invokeOpenTag = text.slice(state.invoke.start, nextClose + 1);
      const open = DEEPSEEK_DSML_INVOKE_OPEN_TAG.exec(invokeOpenTag);
      if (!open) {
        state.offset = state.invoke.start + 1;
        state.invoke = undefined;
        continue;
      }
      // Carry the exact opener across chunks; a foreign close cannot authorize a call.
      state.invoke = { kind: "body", closeToken: `</${open[1]}invoke>` };
      state.offset = nextClose + 1;
      continue;
    }

    if (state.invoke?.kind === "body") {
      const invokeCloseIndex = text.indexOf(state.invoke.closeToken, state.offset);
      if (invokeCloseIndex === -1) {
        state.offset = Math.max(0, text.length - DEEPSEEK_DSML_RECOVERY_MAX_BOUNDARY_LEN + 1);
        return { kind: "incomplete" };
      }
      state.offset = invokeCloseIndex + state.invoke.closeToken.length;
      state.invoke = undefined;
      continue;
    }

    const toolOpen = findEarliestStringToken(text, DEEPSEEK_DSML_TOOL_OPEN_TOKENS, state.offset);
    const toolCloseIndex = text.indexOf(closeToken, state.offset);
    const invokeOpen = findEarliestStringToken(
      text,
      DEEPSEEK_DSML_INVOKE_OPEN_PREFIXES,
      state.offset,
    );
    const next = [
      toolOpen ? { kind: "nested-open" as const, ...toolOpen } : null,
      toolCloseIndex === -1
        ? null
        : { kind: "close" as const, index: toolCloseIndex, token: closeToken },
      invokeOpen ? { kind: "invoke-open" as const, ...invokeOpen } : null,
    ]
      .filter((candidate) => candidate !== null)
      .toSorted((left, right) => left.index - right.index)[0];
    if (!next) {
      state.offset = Math.max(
        contentStartIndex,
        text.length - DEEPSEEK_DSML_RECOVERY_MAX_BOUNDARY_LEN + 1,
      );
      return { kind: "incomplete" };
    }
    if (next.kind === "invoke-open") {
      state.invoke = { kind: "open", start: next.index };
      state.offset = next.index + next.token.length;
      continue;
    }
    return next;
  }
  return { kind: "incomplete" };
}

function longestDeepSeekDsmlToolOpenPrefixSuffixLength(text: string) {
  const maxLength = Math.min(text.length, DEEPSEEK_DSML_TOOL_MAX_OPEN_TOKEN_LEN - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = text.slice(text.length - length);
    if (DEEPSEEK_DSML_TOOL_OPEN_TOKENS.some((token) => token.startsWith(suffix))) {
      return length;
    }
  }
  return 0;
}
