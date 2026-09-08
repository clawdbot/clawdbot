import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { stripInternalRuntimeContext } from "../agents/internal-runtime-context.js";
import { splitTrailingDirective } from "../auto-reply/reply/streaming-directives.js";
import {
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
} from "../auto-reply/tokens.js";
import { isRelativeAssistantMediaReference, splitMediaFromOutput } from "../media/parse.js";
import { resolveAssistantEventPhase } from "../shared/chat-message-content.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import type { AssistantTextSnapshot } from "./agent-event-assistant-text.js";
import { stripAssistantMediaDirectivesForDisplay } from "./chat-display-projection.helpers.js";
import {
  isSuppressedControlReplyLeadFragment,
  isSuppressedControlReplyText,
  stripSuppressedControlReplyToken,
} from "./control-reply-text.js";

const MAX_LIVE_CHAT_BUFFER_CHARS = 500_000;

/** Cap live display text without letting later snapshots resurrect the retired prefix. */
export function capLiveAssistantText(snapshot: AssistantTextSnapshot): string {
  const { text, scope } = snapshot;
  const capped =
    text.length > MAX_LIVE_CHAT_BUFFER_CHARS
      ? sliceUtf16Safe(text, -MAX_LIVE_CHAT_BUFFER_CHARS)
      : text;
  if (scope) {
    scope.prefix = sliceUtf16Safe(scope.prefix, text.length - capped.length);
  }
  return capped;
}

/** Removes runtime-only context/directive tags from the merged live assistant buffer. */
export function normalizeLiveAssistantBufferedText(
  text: string,
  options?: { final?: boolean; managedMediaUrls?: readonly string[] },
): string {
  const normalized = stripInternalRuntimeContext(stripInlineDirectiveTagsForDisplay(text).text);
  const trailing = options?.final
    ? { text: normalized, tail: "" }
    : splitTrailingDirective(normalized);
  const parsedTail = trailing.tail
    ? splitMediaFromOutput(trailing.tail, {
        extractAudioDirectives: false,
        extractMarkdownImages: false,
      })
    : undefined;
  // Hold an ambiguous final line until it is either a client-renderable legacy
  // reference or a relative pipeline directive that the display projection removes.
  const withoutPendingMediaTail =
    parsedTail?.mediaUrls?.length &&
    parsedTail.mediaUrls.every((url) => !isRelativeAssistantMediaReference(url))
      ? normalized
      : trailing.text;
  return stripAssistantMediaDirectivesForDisplay(
    withoutPendingMediaTail,
    options?.managedMediaUrls ?? [],
  );
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
