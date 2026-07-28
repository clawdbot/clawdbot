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

const MAX_INTERNAL_MEDIA_PATH_CHARS = 4_096;

/** Reads a completed image artifact only from a protected internal event. */
export function extractCompletedImageGenerationMediaPath(input: ResponsesInputItem[]) {
  const item = input.at(-1);
  if (!item || !Array.isArray(item.content)) {
    return "";
  }
  const text = extractInputText(item.content as unknown[]);
  if (
    !isInternalRuntimeContextCarrierText(text) ||
    !/(?:^|\n)source: image_generation(?:\r?$)/m.test(text) ||
    !/(?:^|\n)status: completed successfully(?:\r?$)/m.test(text)
  ) {
    return "";
  }
  const mediaPath = new RegExp(
    `(?:^|\\n)MEDIA:([^\\r\\n]{1,${MAX_INTERNAL_MEDIA_PATH_CHARS}})(?:\\r?$)`,
    "m",
  ).exec(text)?.[1];
  if (mediaPath?.trim()) {
    return mediaPath.trim();
  }
  return "";
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

function isResponsesToolCallOutput(item: ResponsesInputItem) {
  return item.type === "function_call_output" || item.type === "custom_tool_call_output";
}

function extractFunctionCallOutputText(item: ResponsesInputItem) {
  if (!isResponsesToolCallOutput(item)) {
    return "";
  }
  return stringifyFunctionCallOutput(item.output);
}

function extractFunctionCallOutputCallId(item: ResponsesInputItem) {
  if (!isResponsesToolCallOutput(item)) {
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
  if (!isResponsesToolCallOutput(item)) {
    return false;
  }
  return item.is_error === true || item.isError === true;
}

function normalizeToolPath(value: unknown) {
  return typeof value === "string"
    ? value
        .trim()
        .replaceAll("\\", "/")
        .replace(/^\.\/+/, "")
    : "";
}

function parseFunctionCallArguments(item: ResponsesInputItem) {
  if (item.type !== "function_call" || typeof item.arguments !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(item.arguments);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function functionCallPlansWrite(item: ResponsesInputItem, canonicalExpectedPath: string): boolean {
  if (item.type !== "function_call") {
    return false;
  }
  const args = parseFunctionCallArguments(item);
  if (item.name === "write") {
    return normalizeToolPath(args?.path) === canonicalExpectedPath;
  }
  if (item.name !== "exec") {
    return false;
  }
  const code =
    typeof args?.code === "string"
      ? args.code
      : typeof args?.command === "string"
        ? args.command
        : "";
  const writeCall =
    /\btools\.call(?:Value)?\s*\(\s*["'](?:openclaw:core:)?write["']\s*,\s*\{([\s\S]*?)\}\s*\)/u.exec(
      code,
    );
  const pathValue = /\bpath\s*:\s*(["'])(.*?)\1/su.exec(writeCall?.[1] ?? "")?.[2];
  return normalizeToolPath(pathValue) === canonicalExpectedPath;
}

function parseFunctionCallOutputObject(item: ResponsesInputItem): Record<string, unknown> | null {
  const output = extractFunctionCallOutputText(item).trim();
  if (!output) {
    return null;
  }
  try {
    const parsed = JSON.parse(output) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function codeModeWriteResultCompleted(
  input: ResponsesInputItem[],
  execCallIndex: number,
  execOutput: ResponsesInputItem,
): boolean {
  const state = parseFunctionCallOutputObject(execOutput);
  if (state?.status === "completed") {
    return true;
  }
  const runId = state?.status === "waiting" && typeof state.runId === "string" ? state.runId : "";
  if (!runId) {
    return false;
  }
  for (const [waitOffset, candidate] of input.slice(execCallIndex + 1).entries()) {
    if (
      candidate.type !== "function_call" ||
      candidate.name !== "wait" ||
      typeof candidate.call_id !== "string" ||
      parseFunctionCallArguments(candidate)?.runId !== runId
    ) {
      continue;
    }
    const waitOutput = input
      .slice(execCallIndex + waitOffset + 2)
      .find(
        (result) =>
          isResponsesToolCallOutput(result) &&
          extractFunctionCallOutputCallId(result) === candidate.call_id,
      );
    if (
      waitOutput &&
      !functionCallOutputIsStructuredError(waitOutput) &&
      parseFunctionCallOutputObject(waitOutput)?.status === "completed"
    ) {
      return true;
    }
  }
  return false;
}

function extractSuccessfulWriteOutputPath(item: ResponsesInputItem) {
  const output = extractFunctionCallOutputText(item).trim();
  const match = /^Successfully wrote \d+ bytes to (.+)$/u.exec(output);
  return normalizeToolPath(match?.[1]);
}

function parseJsonRecord(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseCanonicalCodeModeCall(item: ResponsesInputItem) {
  const code = parseFunctionCallArguments(item)?.code;
  if (typeof code !== "string") {
    return undefined;
  }
  const match = /^return await tools\.callValue\(("(?:[^"\\]|\\.)*"), (\{.*\})\);$/su.exec(
    code.trim(),
  );
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  try {
    const toolId = JSON.parse(match[1]);
    const args = JSON.parse(match[2]);
    return typeof toolId === "string" && args && typeof args === "object" && !Array.isArray(args)
      ? { toolId, args: args as Record<string, unknown> }
      : undefined;
  } catch {
    return undefined;
  }
}

function isSuccessfulCodeModeWriteOutput(item: ResponsesInputItem) {
  const payload = parseJsonRecord(extractFunctionCallOutputText(item));
  const value =
    payload?.value && typeof payload.value === "object" && !Array.isArray(payload.value)
      ? (payload.value as Record<string, unknown>)
      : undefined;
  return payload?.status === "completed" && value?.changed === true;
}

export function hasSuccessfulWriteToolOutput(input: ResponsesInputItem[], expectedPath: string) {
  const canonicalExpectedPath = normalizeToolPath(expectedPath);
  if (!canonicalExpectedPath) {
    return false;
  }
  for (const [callIndex, item] of input.entries()) {
    if (item.type !== "function_call" || typeof item.call_id !== "string" || !item.call_id.trim()) {
      continue;
    }
    const isDirectWrite = item.name === "write";
    const isCodeModeWrite = item.name === "exec";
    if (!isDirectWrite && !isCodeModeWrite) {
      continue;
    }
    const codeModeCall = isCodeModeWrite ? parseCanonicalCodeModeCall(item) : undefined;
    const callPath = isDirectWrite
      ? normalizeToolPath(parseFunctionCallArguments(item)?.path)
      : codeModeCall?.toolId === "openclaw:core:write"
        ? normalizeToolPath(codeModeCall.args.path)
        : "";
    if (callPath !== canonicalExpectedPath) {
      continue;
    }
    const matchingOutput = input
      .slice(callIndex + 1)
      .find(
        (candidate) =>
          isResponsesToolCallOutput(candidate) &&
          extractFunctionCallOutputCallId(candidate) === item.call_id,
      );
    const outputMatches = matchingOutput
      ? isDirectWrite
        ? extractSuccessfulWriteOutputPath(matchingOutput) === canonicalExpectedPath
        : isSuccessfulCodeModeWriteOutput(matchingOutput)
      : false;
    if (matchingOutput && !functionCallOutputIsStructuredError(matchingOutput) && outputMatches) {
      return true;
    }
  }
  return false;
}

export function hasCompletedWriteToolResult(input: ResponsesInputItem[], expectedPath: string) {
  const canonicalExpectedPath = normalizeToolPath(expectedPath);
  if (!canonicalExpectedPath) {
    return false;
  }
  for (const [callIndex, item] of input.entries()) {
    if (
      !functionCallPlansWrite(item, canonicalExpectedPath) ||
      typeof item.call_id !== "string" ||
      !item.call_id.trim()
    ) {
      continue;
    }
    const matchingOutput = input
      .slice(callIndex + 1)
      .find(
        (candidate) =>
          isResponsesToolCallOutput(candidate) &&
          extractFunctionCallOutputCallId(candidate) === item.call_id,
      );
    if (matchingOutput && !functionCallOutputIsStructuredError(matchingOutput)) {
      if (item.name !== "exec" || codeModeWriteResultCompleted(input, callIndex, matchingOutput)) {
        return true;
      }
    }
  }
  return false;
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
