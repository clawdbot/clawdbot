/**
 * Hides in-flight and completed continuation markers from assistant display streams.
 */
import { CONTINUE_WORK_TOKEN } from "../auto-reply/continuation/signal.js";
import {
  buildAssistantStreamData,
  resolveTextAppendDelta,
  stripContinuationSignalFromDisplayText,
} from "./embedded-agent-subscribe.handlers.messages.stream.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";

type PendingContinuationSignal = {
  start: number;
  sensitive: boolean;
};

const CONTINUATION_MARKER_CONFIDENCE_PREFIX = "CONTINUE_";
const CONTINUATION_DELEGATE_MARKER = "CONTINUE_DELEGATE:";

function findPendingBracketContinuationSignal(text: string): PendingContinuationSignal | undefined {
  let pendingSignal: PendingContinuationSignal | undefined;
  for (let bracketStart = text.lastIndexOf("[["); bracketStart >= 0;) {
    const markerText = text.slice(bracketStart + 2).trimStart();
    const sensitive = markerText.startsWith(CONTINUATION_MARKER_CONFIDENCE_PREFIX);
    if (
      !markerText ||
      CONTINUE_WORK_TOKEN.startsWith(markerText) ||
      CONTINUATION_DELEGATE_MARKER.startsWith(markerText)
    ) {
      pendingSignal = { start: bracketStart, sensitive };
    } else if (markerText.startsWith(CONTINUE_WORK_TOKEN)) {
      const tail = markerText.slice(CONTINUE_WORK_TOKEN.length);
      if (/^(?::\d+)?\s*\]\]\s*$/.test(tail)) {
        return undefined;
      }
      if (/^(?::\d*)?\s*\]?\]?\s*$/.test(tail)) {
        pendingSignal = { start: bracketStart, sensitive: true };
      }
    } else if (
      markerText.startsWith(CONTINUATION_DELEGATE_MARKER) &&
      !markerText.slice(CONTINUATION_DELEGATE_MARKER.length).includes("]]")
    ) {
      pendingSignal = { start: bracketStart, sensitive: true };
    }
    if (bracketStart === 0) {
      break;
    }
    bracketStart = text.lastIndexOf("[[", bracketStart - 1);
  }
  if (pendingSignal) {
    return pendingSignal;
  }
  if (text.endsWith("[")) {
    return { start: text.length - 1, sensitive: false };
  }
  return undefined;
}

function findPendingContinuationSignal(text: string): PendingContinuationSignal | undefined {
  const bracketSignal = findPendingBracketContinuationSignal(text);
  if (bracketSignal) {
    return bracketSignal;
  }

  const delayMatch = text.match(/\bCONTINUE_WORK:\d*$/);
  if (delayMatch?.index !== undefined) {
    return { start: delayMatch.index, sensitive: true };
  }
  const maxPrefixLength = Math.min(CONTINUE_WORK_TOKEN.length - 1, text.length);
  for (let length = maxPrefixLength; length > 0; length -= 1) {
    const start = text.length - length;
    const suffix = text.slice(start);
    if (
      CONTINUE_WORK_TOKEN.startsWith(suffix) &&
      (start === 0 || !/[A-Za-z0-9_]/.test(text[start - 1] ?? ""))
    ) {
      return {
        start,
        sensitive: suffix.startsWith(CONTINUATION_MARKER_CONFIDENCE_PREFIX),
      };
    }
  }
  return undefined;
}

/** Strips pending or completed continuation markers before display emission. */
export function resolveCommentaryDisplayText(text: string, options?: { final?: boolean }): string {
  const pendingSignal = findPendingContinuationSignal(text);
  if (pendingSignal) {
    if (options?.final && !pendingSignal.sensitive) {
      return text;
    }
    return text.slice(0, pendingSignal.start);
  }
  return stripContinuationSignalFromDisplayText(text);
}

/** Emits only the newly revealed commentary text after continuation stripping. */
export function emitCommentaryDisplayTransition(
  ctx: EmbeddedAgentSubscribeContext,
  rawText: string,
  params: {
    final?: boolean;
    itemId?: string;
    preferReplace?: boolean;
  },
): void {
  const previousText = ctx.state.lastStreamedCommentary ?? "";
  const nextText = resolveCommentaryDisplayText(rawText, { final: params.final });
  ctx.state.lastStreamedCommentary = nextText;
  if (nextText === previousText) {
    return;
  }
  const appendDelta = resolveTextAppendDelta(previousText, nextText);
  const useDelta = !params.preferReplace && appendDelta && nextText.startsWith(previousText);
  const data = useDelta
    ? buildAssistantStreamData({
        text: nextText,
        delta: appendDelta,
        phase: "commentary",
        itemId: params.itemId,
      })
    : buildAssistantStreamData({
        text: nextText,
        replace: true,
        phase: "commentary",
        itemId: params.itemId,
      });
  if (useDelta) {
    ctx.state.commentaryStreamedWithDelta = true;
  }
  ctx.emitAssistantStreamData(data);
}

/**
 * Routes every commentary display emit through continuation stripping. When the
 * provider phase was still undecided, the text already streamed on the assistant
 * lane, so the transition is emitted as an append plus authoritative replace.
 */
export function emitResolvedCommentaryDisplay(
  ctx: EmbeddedAgentSubscribeContext,
  rawText: string,
  params: {
    final?: boolean;
    itemId?: string;
    preferReplace?: boolean;
  },
): void {
  if (!ctx.state.assistantDisplayPhasePending) {
    emitCommentaryDisplayTransition(ctx, rawText, params);
    return;
  }
  const text = resolveCommentaryDisplayText(rawText, { final: params.final });
  const previousAssistantText = ctx.state.lastStreamedAssistantCleaned ?? "";
  const canAppendToAssistantDisplay =
    ctx.state.emittedAssistantUpdate && text.startsWith(previousAssistantText);
  const delta = canAppendToAssistantDisplay
    ? resolveTextAppendDelta(previousAssistantText, text)
    : "";
  ctx.state.assistantDisplayPhasePending = false;
  ctx.state.lastStreamedCommentary = text;
  ctx.state.commentaryStreamedWithDelta = canAppendToAssistantDisplay;
  if (delta) {
    ctx.emitAssistantStreamData(
      buildAssistantStreamData({
        delta,
        phase: "commentary",
        itemId: params.itemId,
      }),
    );
  }
  ctx.emitAssistantStreamData(
    buildAssistantStreamData({
      text,
      replace: true,
      phase: "commentary",
      itemId: params.itemId,
    }),
  );
}
