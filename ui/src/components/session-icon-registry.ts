import { html, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
// Module import, not the protocol barrel: the barrel pulls TypeBox schemas
// into the Control UI startup bundle and blows the perf budget.
import {
  normalizeSessionIconInput,
  parseSessionIcon,
  type SessionAgentAttentionIconId,
} from "../../../packages/gateway-protocol/src/session-icon.js";
import { icons } from "./icons.ts";

const SESSION_ICON_REGISTRY = {
  bot: icons.bot,
  claw: icons.claw,
  spark: icons.spark,
  bug: icons.bug,
  book: icons.book,
  bookmark: icons.bookmark,
  zap: icons.zap,
  brain: icons.brain,
  camera: icons.camera,
  globe: icons.globe,
  sun: icons.sun,
  moon: icons.moon,
  hand: icons.hand,
  key: icons.key,
  alert: icons.alertTriangle,
  flag: icons.flag,
  lock: icons.lock,
  hourglass: icons.hourglass,
} as const satisfies Record<string, TemplateResult>;

type CuratedSessionIconId = keyof typeof SESSION_ICON_REGISTRY;
export const CURATED_SESSION_ICON_IDS = Object.keys(
  SESSION_ICON_REGISTRY,
) as CuratedSessionIconId[];

function renderNamedIcon(icon: TemplateResult): TemplateResult {
  return html`<span class="session-icon__named">${icon}</span>`;
}

export function resolveSessionIcon(icon: string | undefined): TemplateResult {
  if (!icon) {
    return renderNamedIcon(icons.messageSquare);
  }
  const parsed = parseSessionIcon(icon);
  if (parsed?.kind === "named") {
    const namedIcon = Object.hasOwn(SESSION_ICON_REGISTRY, parsed.name)
      ? SESSION_ICON_REGISTRY[parsed.name as CuratedSessionIconId]
      : undefined;
    return renderNamedIcon(namedIcon ?? icons.messageSquare);
  }
  if (parsed?.kind === "emoji") {
    return html`<span class="session-icon__emoji">${parsed.emoji}</span>`;
  }
  if (parsed?.kind === "svg") {
    const normalized = normalizeSessionIconInput(icon);
    const sanitized = normalized.ok ? parseSessionIcon(normalized.value) : null;
    if (sanitized?.kind === "svg") {
      return html`<span class="session-icon__svg">${unsafeHTML(sanitized.svg)}</span>`;
    }
  }
  return renderNamedIcon(icons.messageSquare);
}

export function resolveSessionAttentionIcon(icon: SessionAgentAttentionIconId): TemplateResult {
  return SESSION_ICON_REGISTRY[icon];
}
