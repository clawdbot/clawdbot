import { html, nothing } from "lit";
import { icons } from "../icons.ts";
import type { GatewaySessionRow } from "../types.ts";

const CONTEXT_NOTICE_RATIO = 0.85;
const CONTEXT_COMPACT_RATIO = 0.9;

export type ContextNoticeOptions = {
  compactBusy?: boolean;
  compactDisabled?: boolean;
  onCompact?: () => void | Promise<void>;
};

/** Parse a 6-digit CSS hex color string to [r, g, b] integer components. */
function parseHexRgb(hex: string): [number, number, number] | null {
  const h = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    return null;
  }
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

let cachedThemeNoticeColors: {
  warnHex: string;
  dangerHex: string;
  warnRgb: [number, number, number];
  dangerRgb: [number, number, number];
} | null = null;

function getThemeNoticeColors() {
  if (cachedThemeNoticeColors) {
    return cachedThemeNoticeColors;
  }
  const rootStyle = getComputedStyle(document.documentElement);
  const warnHex = rootStyle.getPropertyValue("--warn").trim() || "#f59e0b";
  const dangerHex = rootStyle.getPropertyValue("--danger").trim() || "#ef4444";
  cachedThemeNoticeColors = {
    warnHex,
    dangerHex,
    warnRgb: parseHexRgb(warnHex) ?? [245, 158, 11],
    dangerRgb: parseHexRgb(dangerHex) ?? [239, 68, 68],
  };
  return cachedThemeNoticeColors;
}

export function resetContextNoticeThemeCacheForTest(): void {
  cachedThemeNoticeColors = null;
}

export function getContextNoticeViewModel(
  session: GatewaySessionRow | undefined,
  defaultContextTokens: number | null,
): {
  pct: number;
  detail: string;
  color: string;
  bg: string;
  warning: boolean;
  compactRecommended: boolean;
} | null {
  if (session?.totalTokensFresh === false) {
    return null;
  }
  const used = session?.totalTokens;
  const limit = session?.contextTokens ?? defaultContextTokens ?? 0;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || !limit) {
    return null;
  }
  const ratio = used / limit;
  const pct = Math.min(Math.round(ratio * 100), 100);
  const warning = ratio >= CONTEXT_NOTICE_RATIO;
  if (!warning) {
    return {
      pct,
      detail: `${formatTokensCompact(used)} / ${formatTokensCompact(limit)}`,
      color: "var(--muted)",
      bg: "color-mix(in srgb, var(--muted) 8%, transparent)",
      warning,
      compactRecommended: false,
    };
  }
  // Read theme semantic tokens so color tracks the active theme (Dash, dark, light ...).
  const { warnRgb, dangerRgb } = getThemeNoticeColors();
  const [wr, wg, wb] = warnRgb;
  const [dr, dg, db] = dangerRgb;
  const t = Math.min(Math.max((ratio - 0.85) / 0.1, 0), 1);
  const r = Math.round(wr + (dr - wr) * t);
  const g = Math.round(wg + (dg - wg) * t);
  const b = Math.round(wb + (db - wb) * t);
  const color = `rgb(${r}, ${g}, ${b})`;
  const bgOpacity = 0.08 + 0.08 * t;
  const bg = `rgba(${r}, ${g}, ${b}, ${bgOpacity})`;
  return {
    pct,
    detail: `${formatTokensCompact(used)} / ${formatTokensCompact(limit)}`,
    color,
    bg,
    warning,
    compactRecommended: ratio >= CONTEXT_COMPACT_RATIO,
  };
}

export function renderContextNotice(
  session: GatewaySessionRow | undefined,
  defaultContextTokens: number | null,
  options: ContextNoticeOptions = {},
) {
  const model = getContextNoticeViewModel(session, defaultContextTokens);
  if (!model) {
    return nothing;
  }
  const canRenderCompact = model.compactRecommended && options.onCompact;
  const compactDisabled = options.compactDisabled === true || options.compactBusy === true;
  return html`
    <div
      class="context-notice ${model.warning ? "context-notice--warning" : "context-notice--usage"}"
      role="status"
      style="--ctx-color:${model.color};--ctx-bg:${model.bg}"
      title=${`Session context usage: ${model.detail} (${model.pct}%)`}
    >
      ${model.warning
        ? html`
            <svg
              class="context-notice__icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          `
        : html`
            <span class="context-notice__meter" aria-hidden="true">
              <span class="context-notice__meter-fill" style="width:${model.pct}%"></span>
            </span>
          `}
      <span>${model.pct}% context used</span>
      <span class="context-notice__detail">${model.detail}</span>
      ${canRenderCompact
        ? html`
            <button
              class="context-notice__action ${options.compactBusy
                ? "context-notice__action--busy"
                : ""}"
              type="button"
              title="Compact session context"
              aria-label="Compact recommended session context"
              ?disabled=${compactDisabled}
              @click=${(event: Event) => {
                event.preventDefault();
                event.stopPropagation();
                if (compactDisabled) {
                  return;
                }
                void options.onCompact?.();
              }}
            >
              ${options.compactBusy ? icons.loader : icons.minimize}
              <span>${options.compactBusy ? "Compacting" : "Compact"}</span>
            </button>
          `
        : nothing}
    </div>
  `;
}

/** Format token count compactly (e.g. 128000 -> "128k"). */
function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(n);
}
