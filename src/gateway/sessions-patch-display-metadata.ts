// Display-metadata mutations for sessions.patch: label, icon, color, category, boardFace.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import {
  normalizeSessionColorValue,
  normalizeSessionIconValue,
  SESSION_COLOR_IDS,
  SESSION_ICON_GLYPH_IDS,
} from "../../packages/gateway-protocol/src/session-agent-status.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { parseSessionLabel, SESSION_LABEL_MAX_LENGTH } from "../sessions/session-label.js";

/** Applies display-metadata patch fields onto the next entry; returns an error message on invalid input. */
export function applySessionsPatchDisplayMetadata(params: {
  patch: SessionsPatchParams;
  next: InternalSessionEntry;
  isLabelInUse: (label: string) => boolean;
}): string | undefined {
  const { patch, next } = params;

  if ("label" in patch) {
    const raw = patch.label;
    if (raw === null) {
      delete next.label;
    } else if (raw !== undefined) {
      const parsed = parseSessionLabel(raw);
      if (!parsed.ok) {
        return parsed.error;
      }
      if (params.isLabelInUse(parsed.label)) {
        return `label already in use: ${parsed.label}`;
      }
      next.label = parsed.label;
    }
  }

  if ("icon" in patch) {
    const raw = patch.icon;
    if (raw === null || raw === "") {
      delete next.icon;
    } else if (raw !== undefined) {
      const icon = normalizeSessionIconValue(raw);
      if (!icon) {
        return `icon must be a single emoji or one of: ${SESSION_ICON_GLYPH_IDS.join(", ")}`;
      }
      next.icon = icon;
    }
  }

  if ("color" in patch) {
    const raw = patch.color;
    if (raw === null || raw === "") {
      delete next.color;
    } else if (raw !== undefined) {
      const color = normalizeSessionColorValue(raw);
      if (!color) {
        return `color must be one of: ${SESSION_COLOR_IDS.join(", ")}`;
      }
      next.color = color;
    }
  }

  if ("category" in patch) {
    const raw = patch.category;
    if (raw === null) {
      delete next.category;
    } else if (raw !== undefined) {
      // Categories are shared organization buckets, so duplicates are expected (unlike labels).
      const trimmed = normalizeOptionalString(raw) ?? "";
      if (!trimmed) {
        return "invalid category: empty";
      }
      if (trimmed.length > SESSION_LABEL_MAX_LENGTH) {
        return `invalid category: too long (max ${SESSION_LABEL_MAX_LENGTH})`;
      }
      next.category = trimmed;
    }
  }

  if ("boardFace" in patch && patch.boardFace !== undefined) {
    next.boardFace = patch.boardFace;
  }

  return undefined;
}
