import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// Gateway live chat projector.
// Converts streaming assistant events into display-safe live chat text.
import { stripInternalRuntimeContext } from "../agents/internal-runtime-context.js";
import {
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
} from "../auto-reply/tokens.js";
import { resolveAssistantEventPhase } from "../shared/chat-message-content.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import {
  isSuppressedControlReplyLeadFragment,
  isSuppressedControlReplyText,
  stripSuppressedControlReplyToken,
} from "./control-reply-text.js";

const MAX_LIVE_CHAT_BUFFER_CHARS = 500_000;

/** Normalizes assistant event payloads that contain a snapshot, a delta, or both. */
export function resolveAssistantLiveChatInput(
  data: unknown,
): { text: string; delta: string; replace: boolean } | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const record = data as { text?: unknown; delta?: unknown; replace?: unknown };
  if (typeof record.text !== "string" && typeof record.delta !== "string") {
    return undefined;
  }
  return {
    text: typeof record.text === "string" ? record.text : "",
    delta: typeof record.delta === "string" ? record.delta : "",
    replace: record.replace === true,
  };
}

function capLiveAssistantBuffer(text: string): string {
  if (text.length <= MAX_LIVE_CHAT_BUFFER_CHARS) {
    return text;
  }
  return sliceUtf16Safe(text, -MAX_LIVE_CHAT_BUFFER_CHARS);
}

/** Merges assistant full-text and delta events into a capped live buffer. */
export function resolveMergedAssistantText(params: {
  previousText: string;
  nextText: string;
  nextDelta: string;
  replace?: boolean;
}): string {
  const { previousText, nextText, nextDelta, replace } = params;
  if (replace) {
    return capLiveAssistantBuffer(nextText);
  }
  if (nextText && previousText) {
    if (nextText.startsWith(previousText) && nextText.length > previousText.length) {
      return capLiveAssistantBuffer(nextText);
    }
    if (previousText.startsWith(nextText) && !nextDelta) {
      return capLiveAssistantBuffer(previousText);
    }
  }
  if (nextDelta) {
    return capLiveAssistantBuffer(previousText + nextDelta);
  }
  if (nextText) {
    return capLiveAssistantBuffer(nextText);
  }
  return capLiveAssistantBuffer(previousText);
}

/** Removes runtime-only context/directive tags from the merged live assistant buffer. */
export function normalizeLiveAssistantBufferedText(text: string): string {
  return stripInternalRuntimeContext(stripInlineDirectiveTagsForDisplay(text).text);
}

/** Projects buffered assistant text into display text or a suppressed/pending state. */
export function projectLiveAssistantBufferedText(
  rawText: string,
  options?: { suppressLeadFragments?: boolean },
): {
  text: string;
  suppress: boolean;
  pendingLeadFragment: boolean;
} {
  if (!rawText) {
    return { text: "", suppress: true, pendingLeadFragment: false };
  }
  if (isSuppressedControlReplyText(rawText)) {
    return { text: "", suppress: true, pendingLeadFragment: false };
  }
  if (options?.suppressLeadFragments !== false && isSuppressedControlReplyLeadFragment(rawText)) {
    return { text: rawText, suppress: true, pendingLeadFragment: true };
  }
  const withoutTrailingControlToken = stripSuppressedControlReplyToken(rawText);
  if (!withoutTrailingControlToken) {
    return { text: "", suppress: true, pendingLeadFragment: false };
  }
  const text = startsWithSilentToken(withoutTrailingControlToken, SILENT_REPLY_TOKEN)
    ? stripLeadingSilentToken(withoutTrailingControlToken, SILENT_REPLY_TOKEN)
    : withoutTrailingControlToken;
  if (!text || isSuppressedControlReplyText(text)) {
    return { text: "", suppress: true, pendingLeadFragment: false };
  }
  if (options?.suppressLeadFragments !== false && isSuppressedControlReplyLeadFragment(text)) {
    return { text, suppress: true, pendingLeadFragment: true };
  }
  return { text, suppress: false, pendingLeadFragment: false };
}

/** Returns true when an assistant event phase should not appear in live chat. */
export function shouldSuppressAssistantEventForLiveChat(data: unknown): boolean {
  return resolveAssistantEventPhase(data) === "commentary";
}
