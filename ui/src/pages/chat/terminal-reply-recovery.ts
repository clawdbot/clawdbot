import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isToolCallContentType,
  isToolResultContentType,
} from "../../../../src/chat/tool-content.js";
import { resolveAssistantMessagePhase } from "../../../../src/shared/chat-message-content.js";
import { extractText } from "../../lib/chat/message-extract.ts";
import {
  isHiddenAssistantStreamText,
  shouldHideAssistantChatMessage,
} from "../../lib/chat/message-visibility.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { transcriptRunId } from "./chat-thread-run-identity.ts";
import { safeNormalizeMessage } from "./chat-turn-boundary.ts";
import { getChatSessionProjection, readChatSessionProjectionScope } from "./history-merge.ts";

function terminalReplyDisplaySignature(message: unknown): string | null {
  if (shouldHideAssistantChatMessage(message)) {
    return null;
  }
  const record = asNullableRecord(message);
  const phase = resolveAssistantMessagePhase(message);
  const stopReason =
    typeof record?.stopReason === "string" ? record.stopReason.trim().toLowerCase() : "";
  const metadata = asNullableRecord(record?.["__openclaw"]);
  if (
    phase === "commentary" ||
    ((!stopReason || stopReason === "tooluse") && metadata?.runTerminal !== true)
  ) {
    return null;
  }
  const text = extractText(message);
  if (typeof text === "string" && isHiddenAssistantStreamText(text)) {
    return null;
  }
  const content = (safeNormalizeMessage(message)?.content ?? []).filter((block) => {
    if (block.type === "text") {
      return typeof block.text === "string" && block.text.trim().length > 0;
    }
    return !isToolCallContentType(block.type) && !isToolResultContentType(block.type);
  });
  if (content.length === 0) {
    return null;
  }
  try {
    return JSON.stringify(content) ?? null;
  } catch {
    return null;
  }
}

export function readTerminalReplyRecoveryState(
  state: ChatPageHost,
  runId: string,
): {
  acceptedFinal: boolean;
  terminalReplySignatures: ReadonlySet<string>;
} {
  const scope = readChatSessionProjectionScope(state);
  const projection = getChatSessionProjection(state, scope);
  const run = projection.runs[runId];
  const candidates: unknown[] = run?.message === undefined ? [] : [run.message];
  for (const message of projection.messages) {
    if (
      readSessionMessageIdentity(message)?.role === "assistant" &&
      transcriptRunId(message) === runId
    ) {
      candidates.push(message);
    }
  }
  const terminalReplySignatures = new Set<string>();
  for (const message of candidates) {
    const signature = terminalReplyDisplaySignature(message);
    if (signature) {
      terminalReplySignatures.add(signature);
    }
  }
  return {
    acceptedFinal: (run?.acceptedFinalMessageIdentities?.length ?? 0) > 0,
    terminalReplySignatures,
  };
}
