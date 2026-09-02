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
  return extractLastMatchingUserTurn(input)?.text ?? "";
}

export function extractLastMatchingUserTurn(input: ResponsesInputItem[], pattern?: RegExp) {
  const matcher = pattern && new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item?.role !== "user") {
      continue;
    }
    const text = extractInputText(item.content);
    if (text && !isInternalRuntimeContextCarrierText(text) && (!matcher || matcher.test(text))) {
      return { index, text };
    }
  }
  return null;
}

export function splitMockConversationContext(text: string) {
  // The Codex harness projects history and the new request into one user item.
  // Quoted history must not dispatch a task or completion as the current request.
  const projection =
    /<conversation_context>\n([\s\S]*)\n<\/conversation_context>\n\nCurrent user request:\n([\s\S]*)$/.exec(
      text,
    );
  return { current: projection?.[2] ?? text, history: projection?.[1] ?? "" };
}

export function extractMockSubagentContext(input: ResponsesInputItem[]) {
  const turn = extractLastMatchingUserTurn(input, /[\s\S]/);
  if (!turn) {
    return undefined;
  }
  const { current, history } = splitMockConversationContext(turn.text);
  const task =
    /\[Subagent Context\] You are running as a subagent\b[\s\S]*?\[Subagent Task\]\s+([\s\S]*?)\s+Begin\. Execute the assigned task to completion\.$/.exec(
      current,
    )?.[1];
  if (!task) {
    return undefined;
  }
  const inheritedUserTexts = extractAllUserTexts(input.slice(0, turn.index)).filter(
    (text) => !isInternalRuntimeContextCarrierText(text),
  );
  for (const match of history.matchAll(
    /(?:^|\n\n)\[user\]\n([\s\S]*?)(?=\n\n\[[a-zA-Z]+\]\n|$)/g,
  )) {
    if (match[1]) {
      inheritedUserTexts.push(match[1]);
    }
  }
  return { task, inheritedUserTexts };
}

function isUserTurn(item: ResponsesInputItem) {
  // Empty user messages still fence old tool output; runtime carriers do not.
  return (
    item.role === "user" &&
    (typeof item.content === "string" || Array.isArray(item.content)) &&
    !isInternalRuntimeContextCarrierText(extractInputText(item.content))
  );
}

function isInternalRuntimeContextCarrierText(text: string) {
  const trimmed = text.trim();
  return (
    trimmed.includes(INTERNAL_RUNTIME_CONTEXT_BEGIN) &&
    trimmed.endsWith(INTERNAL_RUNTIME_CONTEXT_END)
  );
}

function isContinuationUserText(text: string) {
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

function findCurrentToolOutput(input: ResponsesInputItem[]): ResponsesInputItem | undefined {
  const lastUserIndex = input.findLastIndex(isUserTurn);
  for (const item of input.slice(lastUserIndex + 1).toReversed()) {
    if (isResponsesToolCallOutput(item)) {
      return item;
    }
  }
  for (const [candidateIndex, candidateItem] of Array.from(input.entries()).toReversed()) {
    if (!isResponsesToolCallOutput(candidateItem)) {
      continue;
    }
    const laterUserTexts = input
      .slice(candidateIndex + 1)
      .filter(isUserTurn)
      .map((laterItem) => extractInputText(laterItem.content));
    if (laterUserTexts.length > 0 && laterUserTexts.every(isContinuationUserText)) {
      return candidateItem;
    }
  }
  return undefined;
}

export function hasToolOutput(input: ResponsesInputItem[]) {
  return findCurrentToolOutput(input) !== undefined;
}

export function extractToolOutput(input: ResponsesInputItem[]) {
  const item = findCurrentToolOutput(input);
  return item ? stringifyFunctionCallOutput(item.output) : "";
}

export const extractToolOutputValue = (input: ResponsesInputItem[]) =>
  findCurrentToolOutput(input)?.output;

export function extractToolOutputStructuredError(input: ResponsesInputItem[]) {
  const item = findCurrentToolOutput(input);
  // Explicit success overrides error-shaped content; absent status permits text evidence.
  return [item?.is_error, item?.isError].find(
    (value): value is boolean => typeof value === "boolean",
  );
}

export function extractToolOutputCallId(input: ResponsesInputItem[]) {
  const item = findCurrentToolOutput(input);
  return (
    [item?.call_id, item?.tool_call_id, item?.tool_use_id].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    ) ?? ""
  );
}

export function extractLatestToolOutput(input: ResponsesInputItem[]) {
  for (const item of input.toReversed()) {
    if (isResponsesToolCallOutput(item)) {
      return stringifyFunctionCallOutput(item.output);
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
  const latestToolOutputIndex = input.findLastIndex(isResponsesToolCallOutput);
  if (latestToolOutputIndex < 0) {
    return "";
  }
  return input
    .slice(latestToolOutputIndex + 1)
    .filter((item) => item.role === "user")
    .map((item) => extractInputText(item.content))
    .filter(Boolean)
    .join("\n");
}

function extractInputText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
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
  return input
    .filter((item) => item.role === "user")
    .map((item) => extractInputText(item.content))
    .filter(Boolean);
}

export function extractSlackMpimRetainedBotNonce(
  prompt: string,
  botReplyPrefix: string,
): string | undefined {
  const historyHeader = "[Thread history - for context]\n";
  const historyStart = prompt.indexOf(historyHeader);
  if (historyStart < 0) {
    return undefined;
  }
  const historyBodyStart = historyStart + historyHeader.length;
  const currentTurnStart = prompt.lastIndexOf("Slack MPIM assistant-history recall check.");
  if (currentTurnStart < historyBodyStart) {
    return undefined;
  }
  for (const line of prompt.slice(historyBodyStart, currentTurnStart).split(/\r?\n/u)) {
    const headerEnd = line.indexOf("] ");
    if (headerEnd < 0) {
      continue;
    }
    const header = line.slice(0, headerEnd);
    if (!header.startsWith("[Slack ") || !header.includes(" (this assistant) (assistant) ")) {
      continue;
    }
    const reply = line.slice(headerEnd + 2);
    if (!reply.startsWith(botReplyPrefix)) {
      continue;
    }
    const nonce = reply.slice(botReplyPrefix.length);
    if (/^[A-Z0-9]{8,32}$/u.test(nonce)) {
      return nonce;
    }
  }
  return undefined;
}

function extractAllInputTexts(input: ResponsesInputItem[]) {
  return input
    .flatMap((item) => [
      typeof item.output === "string" ? item.output.trim() : "",
      extractInputText(item.content),
    ])
    .filter(Boolean)
    .join("\n");
}

export function extractInstructionsText(body: Record<string, unknown>) {
  return typeof body.instructions === "string" ? body.instructions.trim() : "";
}

export function extractAllRequestTexts(input: ResponsesInputItem[], body: Record<string, unknown>) {
  return [extractInstructionsText(body), extractAllInputTexts(input)].filter(Boolean).join("\n");
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
    .filter((item) => item.role === "user")
    .map((item) => {
      const text = extractInputText(item.content);
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

function extractLatestImageUserTurn(input: ResponsesInputItem[]) {
  const latestUserIndex = input.findLastIndex(isUserTurn);
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
      .map((item) => extractInputText(item.content))
      .filter(Boolean)
      .join("\n"),
    imageInputCount,
  };
}

export function extractCurrentImageRequest(
  input: ResponsesInputItem[],
  body: Record<string, unknown>,
) {
  // Match only the current request. Historical image prompts must not override
  // a later non-image turn just because they remain in transcript context.
  const imageUserTurn = extractLatestImageUserTurn(input);
  if (imageUserTurn.imageInputCount === 0) {
    return imageUserTurn;
  }
  const developerInstructions = input
    .filter((item) => item.role === "developer")
    .map((item) => extractInputText(item.content))
    .filter(Boolean);
  return {
    text: [extractInstructionsText(body), ...developerInstructions, imageUserTurn.text]
      .filter(Boolean)
      .join("\n"),
    imageInputCount: imageUserTurn.imageInputCount,
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
