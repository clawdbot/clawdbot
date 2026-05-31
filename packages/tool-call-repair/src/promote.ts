import { parseStandalonePlainTextToolCallBlocks, type PlainTextToolCallBlock } from "./payload.js";

export type ToolCallRepairNameResolver = (
  rawName: string,
  allowedToolNames: Set<string>,
) => string | null;

export type PromotedPlainTextToolCallBlockFactory = (
  block: PlainTextToolCallBlock,
  resolvedName: string,
) => Record<string, unknown>;

export type PlainTextToolCallPromotionOptions = {
  allowedStopReasons?: ReadonlySet<unknown>;
  allowedToolNames: Set<string>;
  createToolCallBlock: PromotedPlainTextToolCallBlockFactory;
  isRetainableNonTextBlock?: (block: Record<string, unknown>) => boolean;
  message: unknown;
  requireAssistantRole?: boolean;
  resolveToolName?: ToolCallRepairNameResolver;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function resolveExactToolName(rawName: string, allowedToolNames: Set<string>): string | null {
  return allowedToolNames.has(rawName) ? rawName : null;
}

function createPromotedToolCallBlocks(
  text: string,
  options: PlainTextToolCallPromotionOptions,
): Record<string, unknown>[] | undefined {
  const parsedBlocks = parseStandalonePlainTextToolCallBlocks(text);
  if (!parsedBlocks) {
    return undefined;
  }

  const resolveToolName = options.resolveToolName ?? resolveExactToolName;
  const toolCalls: Record<string, unknown>[] = [];
  for (const block of parsedBlocks) {
    const resolvedName = resolveToolName(block.name, options.allowedToolNames);
    if (!resolvedName) {
      return undefined;
    }
    toolCalls.push(options.createToolCallBlock(block, resolvedName));
  }
  return toolCalls;
}

function createPromotedToolCallBlocksFromTextParts(
  textParts: readonly string[],
  options: PlainTextToolCallPromotionOptions,
): Record<string, unknown>[] | undefined {
  const exactText = textParts.join("").trim();
  if (!exactText) {
    return [];
  }
  for (const text of createTextPartPromotionCandidates(textParts, exactText)) {
    const toolCalls = createPromotedToolCallBlocks(text, options);
    if (toolCalls) {
      return toolCalls;
    }
  }
  return undefined;
}

function createTextPartPromotionCandidates(
  textParts: readonly string[],
  exactText: string,
): string[] {
  const repairedText = joinTextPartsWithStructuralLineBreaks(textParts).trim();
  const newlineJoinedText = textParts.join("\n").trim();
  return [...new Set([repairedText, exactText, newlineJoinedText].filter(Boolean))];
}

function joinTextPartsWithStructuralLineBreaks(textParts: readonly string[]): string {
  let text = "";
  for (const part of textParts) {
    if (text && shouldInsertStructuralLineBreak(text, part)) {
      text += "\n";
    }
    text += part;
  }
  return text;
}

function shouldInsertStructuralLineBreak(left: string, right: string): boolean {
  if (!left || !right || /[\r\n]$/u.test(left) || /^\s/u.test(right)) {
    return false;
  }
  const trimmedLeft = left.trimEnd();
  return (
    /<parameter=[A-Za-z0-9_.:-]{1,120}>$/iu.test(trimmedLeft) ||
    /^\[[A-Za-z0-9_-]+\]$/u.test(trimmedLeft)
  );
}

function shouldPromoteMessage(options: PlainTextToolCallPromotionOptions): boolean {
  if (options.allowedToolNames.size === 0) {
    return false;
  }
  const messageRecord = asRecord(options.message);
  if (!messageRecord) {
    return false;
  }
  if (options.requireAssistantRole && messageRecord.role !== "assistant") {
    return false;
  }
  return !options.allowedStopReasons || options.allowedStopReasons.has(messageRecord.stopReason);
}

export function extractStandalonePlainTextToolCallText(params: {
  allowOtherNonTextBlocks?: boolean;
  allowedStopReasons?: ReadonlySet<unknown>;
  isRetainableNonTextBlock?: (block: Record<string, unknown>) => boolean;
  message: unknown;
  requireAssistantRole?: boolean;
}): string | undefined {
  const record = asRecord(params.message);
  if (!record) {
    return undefined;
  }
  if (params.requireAssistantRole && record.role !== "assistant") {
    return undefined;
  }
  if (params.allowedStopReasons && !params.allowedStopReasons.has(record.stopReason)) {
    return undefined;
  }

  const content = record.content;
  if (typeof content === "string") {
    const text = content.trim();
    return text || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts: string[] = [];
  for (const block of content) {
    const blockRecord = asRecord(block);
    if (!blockRecord) {
      return undefined;
    }
    if (blockRecord.type === "text") {
      if (typeof blockRecord.text !== "string") {
        return undefined;
      }
      if (blockRecord.text.trim()) {
        textParts.push(blockRecord.text);
      }
      continue;
    }
    if (params.isRetainableNonTextBlock?.(blockRecord) || params.allowOtherNonTextBlocks) {
      continue;
    }
    return undefined;
  }

  const text = textParts.join("").trim();
  return text || undefined;
}

export function promoteStandalonePlainTextToolCallMessage(
  options: PlainTextToolCallPromotionOptions,
): Record<string, unknown> | undefined {
  if (!shouldPromoteMessage(options)) {
    return undefined;
  }
  const messageRecord = asRecord(options.message);
  if (!messageRecord) {
    return undefined;
  }

  const originalContent = messageRecord.content;
  if (typeof originalContent === "string") {
    const text = originalContent.trim();
    if (!text) {
      return undefined;
    }
    const toolCalls = createPromotedToolCallBlocks(text, options);
    if (!toolCalls) {
      return undefined;
    }
    return {
      ...messageRecord,
      content: toolCalls,
      stopReason: "toolUse",
    };
  }

  if (!Array.isArray(originalContent)) {
    return undefined;
  }

  const content: Array<Record<string, unknown>> = [];
  let promotedTextBlock = false;
  let textParts: string[] = [];
  const flushTextParts = (): boolean | undefined => {
    if (textParts.length === 0) {
      return false;
    }
    const toolCalls = createPromotedToolCallBlocksFromTextParts(textParts, options);
    textParts = [];
    if (toolCalls?.length === 0) {
      return false;
    }
    if (!toolCalls) {
      return undefined;
    }
    content.push(...toolCalls);
    return true;
  };

  for (const block of originalContent) {
    const blockRecord = asRecord(block);
    if (!blockRecord) {
      return undefined;
    }
    if (blockRecord.type === "text") {
      if (typeof blockRecord.text !== "string") {
        return undefined;
      }
      if (blockRecord.text.trim()) {
        textParts.push(blockRecord.text);
      }
      continue;
    }
    const promotedTextRun = flushTextParts();
    if (promotedTextRun === undefined) {
      return undefined;
    }
    promotedTextBlock ||= promotedTextRun;
    if (options.isRetainableNonTextBlock?.(blockRecord)) {
      content.push(blockRecord);
      continue;
    }
    return undefined;
  }

  const promotedTrailingTextRun = flushTextParts();
  if (promotedTrailingTextRun === undefined) {
    return undefined;
  }
  promotedTextBlock ||= promotedTrailingTextRun;
  if (!promotedTextBlock) {
    return undefined;
  }

  return {
    ...messageRecord,
    content,
    stopReason: "toolUse",
  };
}
