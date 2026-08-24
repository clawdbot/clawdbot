import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TranscriptEvent } from "../config/sessions/session-accessor.sqlite-contract.js";
import { applyAssistantDeliveryDirectives } from "../config/sessions/transcript-assistant-delivery.js";
import { replaceOutsideCodeRegions } from "../utils/directive-tags.js";

// Historical reaction directives were transient actions, not durable delivery facts.
const LEGACY_REACTION_DIRECTIVE_RE =
  /\[\[\s*(?:react|react_to_current)\s*:\s*([^\]\n]+?)\s*\]\]/giu;

function stripLegacyReactionDirectives(message: Record<string, unknown>): void {
  if (!Array.isArray(message.content)) {
    return;
  }
  for (const part of message.content) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
      continue;
    }
    let changed = false;
    const stripped = replaceOutsideCodeRegions(part.text, LEGACY_REACTION_DIRECTIVE_RE, () => {
      changed = true;
      return "";
    });
    if (changed) {
      part.text = stripped.trimStart();
    }
  }
}

export function transformHistoricalTranscriptEvent(event: TranscriptEvent): {
  changed: boolean;
  event: TranscriptEvent;
} {
  if (
    !isRecord(event) ||
    event.type !== "message" ||
    !isRecord(event.message) ||
    event.message.role !== "assistant" ||
    !Array.isArray(event.message.content)
  ) {
    return { changed: false, event };
  }
  const before = JSON.stringify(event.message);
  stripLegacyReactionDirectives(event.message);
  applyAssistantDeliveryDirectives(event.message);
  return { changed: JSON.stringify(event.message) !== before, event };
}
