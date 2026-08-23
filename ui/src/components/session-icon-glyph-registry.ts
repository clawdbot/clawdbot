import type { TemplateResult } from "lit";
import {
  SESSION_ICON_GLYPH_IDS,
  type SessionIconGlyphId,
} from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { icons } from "./icons.ts";

const SESSION_ICON_GLYPH_REGISTRY = {
  braces: icons.braces,
  book: icons.book,
  monitor: icons.monitor,
  bot: icons.bot,
  kanban: icons.kanban,
  coins: icons.coins,
} as const satisfies Record<SessionIconGlyphId, TemplateResult>;

function isSessionIconGlyphId(icon: string): icon is SessionIconGlyphId {
  return SESSION_ICON_GLYPH_IDS.some((id) => id === icon);
}

export function resolveSessionIconGlyph(icon: string): TemplateResult | null {
  return isSessionIconGlyphId(icon) ? SESSION_ICON_GLYPH_REGISTRY[icon] : null;
}
