// QA Lab mock provider input and tool-output extraction.
import {
  type ResponsesInputItem,
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  QA_WHATSAPP_PENDING_HISTORY_TRIGGER_MARKER_RE,
  QA_WHATSAPP_BROADCAST_PROMPT_RE,
  QA_WHATSAPP_RUNTIME_AGENT_RE,
  QA_WHATSAPP_ACTIVATION_ALWAYS_MARKER_RE,
  QA_WHATSAPP_REPLY_TO_BOT_SEED_MARKER_RE,
  QA_WHATSAPP_REPLY_TO_BOT_TRIGGER_MARKER_RE,
  QA_WHATSAPP_BATCHED_FINAL_MARKER_RE,
} from "./mock-openai-contracts.js";
export function extractLastUserText(input: ResponsesInputItem[]) {
  for (const item of input.toReversed()) {
    if (item.role !== "user" || !Array.isArray(item.content)) {
      continue;
    }
    const text = extractInputText(item.content);
    if (text && !isInternalRuntimeContextCarrierText(text)) {
      return text;
    }
  }
  return "";
}

function findLastUserIndex(input: ResponsesInputItem[]) {
  return input.findLastIndex(
    (item) =>
      item.role === "user" &&
      Array.isArray(item.content) &&
      !isInternalRuntimeContextCarrierText(extractInputText(item.content)),
  );
}

function isInternalRuntimeContextCarrierText(text: string) {
  const trimmed = text.trim();
  return (
    trimmed.includes(INTERNAL_RUNTIME_CONTEXT_BEGIN) &&
    trimmed.endsWith(INTERNAL_RUNTIME_CONTEXT_END)
  );
}

function isToolOutputContinuationText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return (
    /^(?:continue|keep going|resume|retry|carry on)(?:[.!?])?$/i.test(trimmed) ||
    /\b(?:continue|continuation|compaction|post-compaction|retry|resume)\b/i.test(trimmed)
  );
}

function stringifyFunctionCallOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  if (Array.isArray(output)) {
    return output
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (!entry || typeof entry !== "object") {
          return "";
        }
        const record = entry as Record<string, unknown>;
        if (typeof record.text === "string") {
          return record.text;
        }
        if (typeof record.output_text === "string") {
          return record.output_text;
        }
        if (typeof record.content === "string") {
          return record.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.output_text === "string") {
      return record.output_text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
    try {
      return JSON.stringify(output);
    } catch {
      return "";
    }
  }
  return "";
}

function extractFunctionCallOutputText(item: ResponsesInputItem) {
  if (item.type !== "function_call_output") {
    return "";
  }
  return stringifyFunctionCallOutput(item.output);
}

function extractFunctionCallOutputCallId(item: ResponsesInputItem) {
  if (item.type !== "function_call_output") {
    return "";
  }
  const record = item as {
    call_id?: unknown;
    tool_call_id?: unknown;
    tool_use_id?: unknown;
  };
  return (
    [record.call_id, record.tool_call_id, record.tool_use_id].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    ) ?? ""
  );
}

function functionCallOutputIsStructuredError(item: ResponsesInputItem) {
  if (item.type !== "function_call_output") {
    return false;
  }
  return item.is_error === true || item.isError === true;
}

export function extractToolOutput(input: ResponsesInputItem[]) {
  const lastUserIndex = findLastUserIndex(input);
  for (const item of input.slice(lastUserIndex + 1).toReversed()) {
    const output = extractFunctionCallOutputText(item);
    if (output) {
      return output;
    }
  }
  for (const [candidateIndex, candidateItem] of Array.from(input.entries()).toReversed()) {
    const output = extractFunctionCallOutputText(candidateItem);
    if (output) {
      const laterUserTexts = input
        .slice(candidateIndex + 1)
        .filter((laterItem) => laterItem.role === "user" && Array.isArray(laterItem.content))
        .map((laterItem) => extractInputText(laterItem.content as unknown[]))
        .filter(Boolean);
      if (
        laterUserTexts.length > 0 &&
        laterUserTexts.every((text) => isToolOutputContinuationText(text))
      ) {
        return output;
      }
      continue;
    }
  }
  return "";
}

export function extractToolOutputStructuredError(input: ResponsesInputItem[]) {
  const lastUserIndex = findLastUserIndex(input);
  for (const item of input.slice(lastUserIndex + 1).toReversed()) {
    const output = extractFunctionCallOutputText(item);
    if (output) {
      return functionCallOutputIsStructuredError(item);
    }
  }
  for (const [candidateIndex, candidateItem] of Array.from(input.entries()).toReversed()) {
    const output = extractFunctionCallOutputText(candidateItem);
    if (output) {
      const laterUserTexts = input
        .slice(candidateIndex + 1)
        .filter((laterItem) => laterItem.role === "user" && Array.isArray(laterItem.content))
        .map((laterItem) => extractInputText(laterItem.content as unknown[]))
        .filter(Boolean);
      if (
        laterUserTexts.length > 0 &&
        laterUserTexts.every((text) => isToolOutputContinuationText(text))
      ) {
        return functionCallOutputIsStructuredError(candidateItem);
      }
    }
  }
  return false;
}

export function extractToolOutputCallId(input: ResponsesInputItem[]) {
  const lastUserIndex = findLastUserIndex(input);
  for (const item of input.slice(lastUserIndex + 1).toReversed()) {
    const output = extractFunctionCallOutputText(item);
    if (output) {
      return extractFunctionCallOutputCallId(item);
    }
  }
  for (const [candidateIndex, candidateItem] of Array.from(input.entries()).toReversed()) {
    const output = extractFunctionCallOutputText(candidateItem);
    if (output) {
      const laterUserTexts = input
        .slice(candidateIndex + 1)
        .filter((laterItem) => laterItem.role === "user" && Array.isArray(laterItem.content))
        .map((laterItem) => extractInputText(laterItem.content as unknown[]))
        .filter(Boolean);
      if (
        laterUserTexts.length > 0 &&
        laterUserTexts.every((text) => isToolOutputContinuationText(text))
      ) {
        return extractFunctionCallOutputCallId(candidateItem);
      }
    }
  }
  return "";
}

export function extractLatestToolOutput(input: ResponsesInputItem[]) {
  for (const item of input.toReversed()) {
    const output = extractFunctionCallOutputText(item);
    if (output) {
      return output;
    }
  }
  return "";
}

export function extractAllToolOutputText(input: ResponsesInputItem[]) {
  return input
    .map((item) => extractFunctionCallOutputText(item))
    .filter(Boolean)
    .join("\n");
}

export function extractUserTextAfterLatestToolOutput(input: ResponsesInputItem[]) {
  const latestToolOutputIndex = input.findLastIndex((item) =>
    Boolean(extractFunctionCallOutputText(item)),
  );
  if (latestToolOutputIndex < 0) {
    return "";
  }
  return input
    .slice(latestToolOutputIndex + 1)
    .filter((item) => item.role === "user" && Array.isArray(item.content))
    .map((item) => extractInputText(item.content as unknown[]))
    .filter(Boolean)
    .join("\n");
}

function extractInputText(content: unknown[]): string {
  return content
    .filter(
      (entry): entry is { type: "input_text"; text: string } =>
        Boolean(entry) &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "input_text" &&
        typeof (entry as { text?: unknown }).text === "string",
    )
    .map((entry) => entry.text)
    .join("\n")
    .trim();
}

export function extractAllUserTexts(input: ResponsesInputItem[]) {
  const texts: string[] = [];
  for (const item of input) {
    if (item.role !== "user" || !Array.isArray(item.content)) {
      continue;
    }
    const text = extractInputText(item.content);
    if (text) {
      texts.push(text);
    }
  }
  return texts;
}

export function extractSystemInputText(input: ResponsesInputItem[]) {
  const texts: string[] = [];
  for (const item of input) {
    if (item.role !== "system") {
      continue;
    }
    if (typeof item.content === "string" && item.content.trim()) {
      texts.push(item.content.trim());
      continue;
    }
    if (!Array.isArray(item.content)) {
      continue;
    }
    const text = extractInputText(item.content);
    if (text) {
      texts.push(text);
    }
  }
  return texts.join("\n");
}

export function extractAllInputTexts(input: ResponsesInputItem[]) {
  const texts: string[] = [];
  for (const item of input) {
    if (typeof item.output === "string" && item.output.trim()) {
      texts.push(item.output.trim());
    }
    if (!Array.isArray(item.content)) {
      continue;
    }
    const text = extractInputText(item.content);
    if (text) {
      texts.push(text);
    }
  }
  return texts.join("\n");
}

export function extractInstructionsText(body: Record<string, unknown>) {
  return typeof body.instructions === "string" ? body.instructions.trim() : "";
}

export function extractAllRequestTexts(input: ResponsesInputItem[], body: Record<string, unknown>) {
  const texts: string[] = [];
  const instructions = extractInstructionsText(body);
  if (instructions) {
    texts.push(instructions);
  }
  const inputText = extractAllInputTexts(input);
  if (inputText) {
    texts.push(inputText);
  }
  return texts.join("\n");
}

export function buildWhatsAppPendingHistoryReply(prompt: string, input: ResponsesInputItem[]) {
  const triggerMatch = QA_WHATSAPP_PENDING_HISTORY_TRIGGER_MARKER_RE.exec(prompt);
  if (!triggerMatch?.[1]) {
    return undefined;
  }
  const suffix = triggerMatch[1];
  // Pending history is injected as an internal runtime carrier, separate from the current prompt.
  // Restricting proof to those carriers prevents current-message marker text from satisfying QA.
  const priorGroupContext = extractWhatsAppPendingHistoryRuntimeContext(input);
  const quietMarkerPattern = new RegExp(`\\bWHATSAPP_QA_PENDING_HISTORY_QUIET_${suffix}\\b`, "u");
  const contextSentinelPattern = new RegExp(
    `\\bWHATSAPP_QA_PENDING_HISTORY_CONTEXT_ONLY_${suffix}\\b`,
    "u",
  );
  if (
    !quietMarkerPattern.test(priorGroupContext) ||
    !contextSentinelPattern.test(priorGroupContext)
  ) {
    return "WHATSAPP_QA_PENDING_HISTORY_MISSING_CONTEXT";
  }
  return `WHATSAPP_QA_PENDING_HISTORY_OK_${suffix}`;
}

function extractWhatsAppPendingHistoryRuntimeContext(input: ResponsesInputItem[]) {
  return input
    .filter((item) => item.role === "user" && Array.isArray(item.content))
    .map((item) => {
      const text = extractInputText(item.content as unknown[]);
      return isInternalRuntimeContextCarrierText(text) ? text : undefined;
    })
    .filter((block): block is string => Boolean(block))
    .join("\n");
}

export function buildWhatsAppBroadcastReply(allInputText: string) {
  const promptMatch = QA_WHATSAPP_BROADCAST_PROMPT_RE.exec(allInputText);
  const token = promptMatch?.[1];
  if (!token) {
    return undefined;
  }
  const agentId = QA_WHATSAPP_RUNTIME_AGENT_RE.exec(allInputText)?.[1];
  if (agentId === "main") {
    return `${token}_MAIN`;
  }
  if (agentId === "qa-second") {
    return `${token}_SECOND`;
  }
  return "WHATSAPP_QA_BROADCAST_AGENT_CONTEXT_MISSING";
}

export function buildWhatsAppGroupDispatchReply(allInputText: string) {
  const activationMatch = QA_WHATSAPP_ACTIVATION_ALWAYS_MARKER_RE.exec(allInputText);
  if (activationMatch?.[1]) {
    return `WHATSAPP_QA_ACTIVATION_ALWAYS_${activationMatch[1]}`;
  }
  const triggerMatch = QA_WHATSAPP_REPLY_TO_BOT_TRIGGER_MARKER_RE.exec(allInputText);
  if (triggerMatch?.[0]) {
    return triggerMatch[0];
  }
  return QA_WHATSAPP_REPLY_TO_BOT_SEED_MARKER_RE.exec(allInputText)?.[0];
}

export function buildWhatsAppBatchedReply(allInputText: string) {
  const finalMatch = QA_WHATSAPP_BATCHED_FINAL_MARKER_RE.exec(allInputText);
  const suffix = finalMatch?.[1];
  if (!suffix) {
    return undefined;
  }
  const firstMarker = `WHATSAPP_QA_BATCHED_FIRST_${suffix}`;
  if (!allInputText.includes(firstMarker)) {
    return `WHATSAPP_QA_BATCHED_MISSING_CONTEXT_${suffix}`;
  }
  return finalMatch[0];
}

export function countImageInputs(value: unknown): number {
  const seen = new WeakSet<object>();
  const stack = [value];
  let count = 0;
  let visited = 0;
  while (stack.length > 0 && visited < 50_000) {
    visited += 1;
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const entry of current) {
        stack.push(entry);
      }
      continue;
    }
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    const record = current as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "input_image" || type === "image" || type === "image_url" || type === "media") {
      count += 1;
    }
    stack.push(record.content, record.image_url, record.source);
  }
  return count;
}

export function extractLatestImageUserTurn(input: ResponsesInputItem[]) {
  const latestUserIndex = findLastUserIndex(input);
  if (latestUserIndex < 0) {
    return { text: "", imageInputCount: 0 };
  }

  const latestUserItem = input[latestUserIndex];
  if (!latestUserItem) {
    return { text: "", imageInputCount: 0 };
  }

  const imageTurnItems = [latestUserItem];
  const imageInputCount = countImageInputs(imageTurnItems.map((item) => item.content));
  if (imageInputCount === 0) {
    return { text: "", imageInputCount: 0 };
  }
  return {
    text: imageTurnItems
      .map((item) => extractInputText(item.content as unknown[]))
      .filter(Boolean)
      .join("\n"),
    imageInputCount,
  };
}

export function parseToolOutputJson(toolOutput: string): Record<string, unknown> | null {
  if (!toolOutput.trim()) {
    return null;
  }
  try {
    return JSON.parse(toolOutput) as Record<string, unknown>;
  } catch {
    return null;
  }
}
