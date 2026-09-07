/*
 * Vendored Carapace v0.6.2 (MIT) primitives from styles/tokens.css,
 * themes.css, themes/product.css, components.css, and candidate/{controls,
 * feedback,data,application,embed}.css. Uses the neutral application palette,
 * product radii, shadows, and motion with embed system font stacks.
 * Page composition follows the maintainer report site's home/report/people
 * styles, scoped here so each self-contained page works under the nonce CSP.
 */
const LIGHT_THEME = `
  color-scheme: light;
  --oc-bg-page: oklch(0.985 0 0);
  --oc-bg-surface: oklch(0.97 0 0);
  --oc-bg-elevated: oklch(1 0 0);
  --oc-bg-recessed: color-mix(in oklch, var(--oc-bg-page) 94%, var(--oc-text-primary));
  --oc-text-primary: oklch(0.205 0 0);
  --oc-text-secondary: oklch(0.269 0 0);
  --oc-text-muted: oklch(0.555 0 0);
  --oc-text-link: var(--oc-accent-primary);
  --oc-accent-primary: color-mix(in srgb, #c24028 60%, #9c3222 40%);
  --oc-accent-primary-hover: color-mix(in srgb, #c24028 30%, #9c3222 70%);
  --oc-accent-primary-deep: #9c3222;
  --oc-accent-secondary: #14806e;
  --oc-accent-secondary-deep: #0f6355;
  --oc-text-on-accent: oklch(1 0 0);
  --oc-border-accent: rgb(216 74 49 / 0.42);
  --oc-status-error-bg: rgb(239 68 68 / 0.1);
  --oc-status-error-fg: #b91c1c;
  --oc-border-subtle: oklch(0.922 0 0);
  --oc-border-strong: color-mix(in oklch, var(--oc-text-primary) 28%, transparent);
  --oc-surface-card: oklch(1 0 0);
  --oc-surface-card-strong: oklch(1 0 0);
  --oc-surface-interactive: oklch(0.97 0 0);
  --oc-surface-interactive-hover: oklch(0.922 0 0);
  --oc-surface-accent-soft: rgb(216 74 49 / 0.12);
  --oc-surface-secondary-soft: rgb(20 128 110 / 0.13);
  --oc-chart-line: oklch(0.205 0 0 / 0.12);
  --oc-focus-ring: oklch(0.15 0 0 / 0.7);
  --oc-selection-bg: rgb(216 74 49 / 0.2);
  --oc-status-success-bg: rgb(34 197 94 / 0.1);
  --oc-status-success-fg: #146c37;
  --oc-status-warning-bg: rgb(245 158 11 / 0.1);
  --oc-status-warning-fg: #8f5100;
  --oc-status-info-bg: rgb(37 99 235 / 0.1);
  --oc-status-info-fg: #1d4ed8;
`;

export const REPORT_STYLES = `
:root {
  color-scheme: dark;
  --oc-bg-page: oklch(0.135 0 0);
  --oc-bg-surface: oklch(0.178 0 0);
  --oc-bg-elevated: oklch(0.205 0 0);
  --oc-bg-recessed: color-mix(in oklch, var(--oc-bg-page) 86%, oklch(0 0 0));
  --oc-text-primary: oklch(0.985 0 0);
  --oc-text-secondary: oklch(0.87 0 0);
  --oc-text-muted: oklch(0.716 0 0);
  --oc-text-link: var(--oc-accent-primary);
  --oc-accent-primary: #f5654a;
  --oc-accent-primary-hover: #e05540;
  --oc-accent-primary-deep: #b23a28;
  --oc-accent-secondary: #4fc8ae;
  --oc-accent-secondary-deep: #2fa48d;
  --oc-text-on-accent: oklch(0.135 0 0);
  --oc-border-accent: rgb(245 101 74 / 0.4);
  --oc-status-error-bg: rgb(239 68 68 / 0.12);
  --oc-status-error-fg: #f87171;
  --oc-border-subtle: oklch(0.269 0 0);
  --oc-border-strong: color-mix(in oklch, var(--oc-text-primary) 32%, transparent);
  --oc-surface-card: oklch(0.178 0 0 / 0.82);
  --oc-surface-card-strong: oklch(0.205 0 0 / 0.96);
  --oc-surface-interactive: oklch(0.178 0 0);
  --oc-surface-interactive-hover: oklch(0.239 0 0);
  --oc-surface-accent-soft: rgb(245 101 74 / 0.14);
  --oc-surface-secondary-soft: rgb(79 200 174 / 0.14);
  --oc-chart-line: oklch(1 0 0 / 0.1);
  --oc-focus-ring: oklch(0.935 0 0 / 0.72);
  --oc-selection-bg: rgb(245 101 74 / 0.28);
  --oc-status-success-bg: rgb(34 197 94 / 0.12);
  --oc-status-success-fg: #22c55e;
  --oc-status-warning-bg: rgb(251 191 36 / 0.12);
  --oc-status-warning-fg: #fbbf24;
  --oc-status-info-bg: rgb(59 130 246 / 0.14);
  --oc-status-info-fg: #60a5fa;
  --oc-space-1: 0.25rem;
  --oc-space-2: 0.5rem;
  --oc-space-3: 0.75rem;
  --oc-space-4: 1rem;
  --oc-space-5: 1.5rem;
  --oc-space-6: 2rem;
  --oc-space-7: 3rem;
  --oc-space-8: 4rem;
  --oc-font-size-xs: 0.75rem;
  --oc-font-size-sm: 0.8125rem;
  --oc-font-size-base: 0.875rem;
  --oc-font-size-md: 0.9375rem;
  --oc-font-size-lg: 1.0625rem;
  --oc-font-size-xl: 1.25rem;
  --oc-font-size-2xl: 1.5rem;
  --oc-font-size-3xl: 2rem;
  --oc-radius-surface: 0.5rem;
  --oc-radius-control: 0.5rem;
  --oc-radius-inset: 0.25rem;
  --oc-radius-round: 999px;
  --oc-radius-full: 999px;
  --oc-shadow-sm: 0 1px 2px rgb(0 0 0 / 0.12);
  --oc-shadow-md: 0 8px 24px -6px rgb(0 0 0 / 0.28);
  --oc-shadow-lg: 0 24px 48px -12px rgb(0 0 0 / 0.42);
  --oc-duration-fast: 160ms;
  --oc-duration-ui: 200ms;
  --oc-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --oc-control-min-height: 2.75rem;
  --oc-content-max: 75rem;
  --oc-input-bg: var(--oc-bg-elevated);
  --oc-input-border: var(--oc-border-subtle);
  --oc-font-embed-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
  --oc-font-embed-mono: ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --oc-font-body: var(--oc-font-embed-sans);
  --oc-font-display: var(--oc-font-embed-sans);
  --oc-font-mono: var(--oc-font-embed-mono);
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {${LIGHT_THEME}}
}
html[data-theme="light"] {${LIGHT_THEME}}



.oc-app-surface { --oc-component-surface: var(--oc-surface-card); --oc-component-surface-strong: var(--oc-surface-card-strong); --oc-component-surface-hover: var(--oc-surface-interactive); --oc-component-border: var(--oc-border-subtle); --oc-component-border-hover: color-mix( in srgb, var(--oc-text-primary) 28%, var(--oc-border-subtle) ); --oc-component-shadow: var(--oc-shadow-sm); --oc-component-shadow-hover: var(--oc-shadow-md); min-width: 0; min-height: 100%; background: var(--oc-bg-page); color: var(--oc-text-primary); font-family: var(--oc-font-body); }
.oc-section { width: 100%; color: var(--oc-text-primary); }
.oc-section-header { display: flex; align-items: end; justify-content: space-between; gap: var(--oc-space-5); }
.oc-section-header > * { min-width: 0; }
.oc-eyebrow { margin: 0; color: var(--oc-accent-primary); font-family: var(--oc-font-mono); font-size: var(--oc-font-size-xs); font-weight: 700; line-height: 1.4; letter-spacing: 0; text-transform: uppercase; }
.oc-card { border: 1px solid var(--oc-component-border); border-radius: var(--oc-radius-surface); background: var(--oc-component-surface); color: var(--oc-text-primary); box-shadow: var(--oc-component-shadow); }
.oc-card-interactive { transition: background var(--oc-duration-ui) var(--oc-ease-out), border-color var(--oc-duration-ui) var(--oc-ease-out), box-shadow var(--oc-duration-ui) var(--oc-ease-out), transform var(--oc-duration-ui) var(--oc-ease-out); }
.oc-card-interactive:hover, .oc-card-interactive:focus-visible { border-color: var(--oc-component-border-hover); background: var(--oc-component-surface-hover); box-shadow: var(--oc-component-shadow-hover); transform: translateY(-1px); }
.oc-card-interactive:focus-visible { outline: 2px solid var(--oc-focus-ring); outline-offset: 3px; }
.oc-card-interactive:active { transform: translateY(0) scale(0.995); }
.oc-action { display: inline-flex; min-height: 2.5rem; align-items: center; justify-content: center; gap: var(--oc-space-2); padding: var(--oc-space-2) var(--oc-space-4); border: 1px solid transparent; border-radius: var(--oc-radius-control); font: inherit; font-size: var(--oc-font-size-base); font-weight: 700; line-height: 1.2; text-decoration: none; touch-action: manipulation; cursor: pointer; transition: background var(--oc-duration-fast) var(--oc-ease-out), border-color var(--oc-duration-fast) var(--oc-ease-out), color var(--oc-duration-fast) var(--oc-ease-out), transform var(--oc-duration-fast) var(--oc-ease-out); }
.oc-action:hover { text-decoration: none; }
.oc-action:focus-visible { outline: 2px solid var(--oc-focus-ring); outline-offset: 3px; }
.oc-action:active:not(:disabled):not([aria-disabled="true"]) { transform: scale(0.98); }
.oc-action:disabled, .oc-action[aria-disabled="true"] { cursor: not-allowed; opacity: 0.5; }
.oc-action[aria-disabled="true"] { pointer-events: none; }
.oc-action-ghost { border-color: transparent; background: transparent; color: var(--oc-text-secondary); }
.oc-action-ghost:hover { background: var(--oc-surface-interactive); color: var(--oc-text-primary); }
.oc-action-icon { width: 2.5rem; padding: 0; }
.oc-segmented { display: inline-flex; max-width: 100%; align-items: center; gap: var(--oc-space-1); overflow-x: auto; padding: var(--oc-space-1); border: 1px solid var(--oc-border-subtle); border-radius: var(--oc-radius-control); background: var(--oc-surface-card); }
.oc-segmented-item { display: inline-flex; min-height: 2rem; align-items: center; justify-content: center; gap: var(--oc-space-2); padding: var(--oc-space-1) var(--oc-space-3); border: 0; border-radius: var(--oc-radius-inset); background: transparent; color: var(--oc-text-secondary); font: inherit; font-size: var(--oc-font-size-base); font-weight: 650; line-height: 1; white-space: nowrap; touch-action: manipulation; cursor: pointer; transition: background var(--oc-duration-fast) var(--oc-ease-out), color var(--oc-duration-fast) var(--oc-ease-out), transform var(--oc-duration-fast) var(--oc-ease-out); }
.oc-segmented-item:active:not(:disabled) { transform: scale(0.98); }
.oc-segmented-item:disabled { cursor: not-allowed; opacity: 0.5; }
.oc-segmented-item:hover { color: var(--oc-text-primary); }
.oc-segmented-item[aria-selected="true"], .oc-segmented-item[aria-pressed="true"], .oc-segmented-item.is-active { background: var(--oc-surface-interactive-hover); color: var(--oc-text-primary); }
.oc-segmented-item:focus-visible { outline: 2px solid var(--oc-focus-ring); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
.oc-card-interactive { transition: none; }
.oc-card-interactive:hover, .oc-card-interactive:focus-visible, .oc-card-interactive:active { transform: none; }
}
@media (max-width: 42rem) {
.oc-section-header { align-items: start; flex-direction: column; }
}
.oc-badge { display: inline-flex; box-sizing: border-box; max-width: 100%; min-width: 0; min-height: 1.5rem; align-items: center; gap: var(--oc-space-2); padding: var(--oc-space-1) var(--oc-space-2); border: 1px solid var(--oc-border-subtle); border-radius: var(--oc-radius-round); background: var(--oc-surface-secondary-soft); color: var(--oc-text-secondary); font-size: var(--oc-font-size-xs); font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-badge::before { width: 0.375rem; height: 0.375rem; flex: 0 0 auto; border-radius: var(--oc-radius-round); background: currentColor; content: ""; }
.oc-badge-neutral::before { display: none; }
.oc-badge-success { border-color: var(--oc-status-success-fg); background: var(--oc-status-success-bg); color: var(--oc-status-success-fg); }
.oc-badge-warning { border-color: var(--oc-status-warning-fg); background: var(--oc-status-warning-bg); color: var(--oc-status-warning-fg); }
.oc-badge-info { border-color: var(--oc-status-info-fg); background: var(--oc-status-info-bg); color: var(--oc-status-info-fg); }
.oc-banner { display: grid; box-sizing: border-box; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: var(--oc-space-3); padding: var(--oc-space-4); border: 1px solid var(--oc-border-subtle); border-radius: var(--oc-radius-surface); background: var(--oc-surface-card-strong); color: var(--oc-text-secondary); font-size: var(--oc-font-size-sm); line-height: 1.45; }
.oc-banner-indicator { width: 0.375rem; height: 0.375rem; margin-top: 0.45em; border-radius: var(--oc-radius-round); background: var(--oc-text-muted); }
.oc-banner-content { display: grid; min-width: 0; gap: var(--oc-space-1); }
.oc-banner-title { color: var(--oc-text-primary); font-weight: 650; }
.oc-banner p { margin: 0; overflow-wrap: anywhere; }
.oc-banner-warning .oc-banner-indicator { background: var(--oc-status-warning-fg); }
.oc-banner-info .oc-banner-indicator { background: var(--oc-status-info-fg); }
.oc-empty { display: grid; box-sizing: border-box; min-height: 12rem; place-items: center; padding: var(--oc-space-5); text-align: center; }
.oc-empty-description { max-width: 42ch; margin: 0; color: var(--oc-text-secondary); font-size: var(--oc-font-size-sm); line-height: 1.5; overflow-wrap: anywhere; text-wrap: pretty; }
@media (max-width: 42rem) {
.oc-banner, .oc-banner:has(.oc-banner-action):has(.oc-banner-dismiss) { grid-template-columns: auto minmax(0, 1fr) auto; }
.oc-banner > :is(button, a):not(.oc-banner-dismiss) { grid-column: 2 / -1; grid-row: 2; justify-self: start; margin-left: 0; }
}
.oc-sparkline { display: block; width: 100%; max-width: 8.5rem; height: 1.5rem; }
.oc-sparkline-line { fill: none; stroke: var(--oc-text-muted); stroke-width: 1.5; stroke-linecap: butt; stroke-linejoin: miter; vector-effect: non-scaling-stroke; }
.oc-sparkline[data-tone="accent"] .oc-sparkline-line { stroke: var(--oc-accent-primary); }
.oc-sparkline-endpoint { fill: var(--oc-accent-primary); stroke: none; }
.oc-delta { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--oc-text-muted); font-size: var(--oc-font-size-xs); font-variant-numeric: tabular-nums; white-space: nowrap; }
.oc-delta-arrow { font-size: 0.625rem; line-height: 1; }
.oc-delta[data-tone="positive"] { color: var(--oc-status-success-fg); }
.oc-delta[data-tone="negative"] { color: var(--oc-status-error-fg); }
.oc-delta:not([data-tone])[data-direction="up"] .oc-delta-arrow { color: var(--oc-status-success-fg); }
.oc-delta:not([data-tone])[data-direction="down"] .oc-delta-arrow { color: var(--oc-status-error-fg); }
.oc-sparkline[data-size="lg"] { max-width: none; height: 3rem; }
.oc-split { display: block; overflow: hidden; width: 100%; height: 0.5rem; border-radius: 2px; }
.oc-split-segment { fill: var(--oc-chart-color, var(--oc-accent-primary)); }
.oc-split-secondary { --oc-chart-color: var(--oc-accent-secondary); }
.oc-split-error { --oc-chart-color: var(--oc-status-error-fg); }
.oc-split-muted { --oc-chart-color: var(--oc-border-strong); }
.oc-split-legend { display: flex; flex-wrap: wrap; gap: var(--oc-space-1) var(--oc-space-3); margin: 0; padding: 0; color: var(--oc-text-muted); font-size: var(--oc-font-size-xs); list-style: none; }
.oc-split-legend li { display: inline-flex; align-items: center; gap: var(--oc-space-1); }
.oc-split-key { width: 0.5rem; height: 0.5rem; border-radius: 2px; background: var(--oc-chart-color, var(--oc-accent-primary)); }
.oc-switch { position: relative; box-sizing: border-box; width: 2.25rem; height: 1.25rem; flex: 0 0 auto; appearance: none; border: 1px solid var(--oc-input-border); border-radius: var(--oc-radius-round); margin: 0; background: var(--oc-input-bg); cursor: inherit; touch-action: manipulation; transition: background var(--oc-duration-fast) var(--oc-ease-out), border-color var(--oc-duration-fast) var(--oc-ease-out); }
.oc-switch::before { position: absolute; top: 0.1875rem; left: 0.1875rem; width: 0.75rem; height: 0.75rem; border-radius: var(--oc-radius-round); background: var(--oc-text-muted); content: ""; transition: background var(--oc-duration-fast) var(--oc-ease-out), transform var(--oc-duration-fast) var(--oc-ease-out); }
.oc-switch:hover:not(:disabled) { border-color: var(--oc-border-strong); }
.oc-switch:checked { border-color: var(--oc-accent-primary); background: var(--oc-accent-primary); }
.oc-switch:checked::before { background: var(--oc-text-on-accent); transform: translateX(1rem); }
.oc-switch:focus-visible { outline: 2px solid var(--oc-focus-ring); outline-offset: 2px; }
@media (forced-colors: active) {
.oc-switch { appearance: auto; forced-color-adjust: auto; }
.oc-switch::before { display: none; }
}
.oc-summary-strip { display: grid; gap: 1px; border: 1px solid var(--oc-border-subtle); border-radius: var(--oc-radius-surface); background: var(--oc-border-subtle); grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); overflow: hidden; }
.oc-summary-metric { display: flex; align-items: center; gap: var(--oc-space-2); padding: var(--oc-space-2) var(--oc-space-3); background: var(--oc-bg-surface); }
.oc-summary-metric-copy { display: grid; min-width: 0; line-height: 1.3; }
.oc-summary-metric-copy strong { font-size: var(--oc-font-size-md); font-variant-numeric: tabular-nums; }
.oc-summary-metric-copy small { overflow: hidden; color: var(--oc-text-muted); font-size: var(--oc-font-size-xs); text-overflow: ellipsis; white-space: nowrap; }
.oc-brand-banner { position: relative; display: grid; min-height: 16rem; align-content: end; overflow: hidden; padding: var(--oc-space-6); border: 1px solid var(--oc-border-subtle); border-radius: var(--oc-radius-surface); background: var(--oc-bg-surface); }
.oc-brand-banner-art { position: absolute; z-index: 0; inset: 0; overflow: hidden; pointer-events: none; }
.oc-brand-banner-art img { position: absolute; inset: 0; width: 100%; height: 100%; max-width: none; object-fit: cover; opacity: 0.82; }
.oc-brand-banner[data-anchor="top"] .oc-brand-banner-art img { object-position: 50% 0%; }
.oc-brand-banner[data-effect="fade"][data-anchor="top"] .oc-brand-banner-art img { -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 36%, transparent 78%); mask-image: linear-gradient(to bottom, #000 0%, #000 36%, transparent 78%); }
.oc-brand-banner-content { position: relative; z-index: 1; display: grid; max-width: 36rem; gap: var(--oc-space-2); }
.oc-brand-banner-content h3 { margin: 0; font-size: var(--oc-font-size-2xl); }
.oc-brand-banner-content p { margin: 0; color: var(--oc-text-secondary); }

* { box-sizing: border-box; }
body { margin: 0; color: var(--oc-text-secondary); background: var(--oc-bg-page); -webkit-font-smoothing: antialiased; }
main { width: min(var(--oc-content-max), calc(100vw - 36px)); margin: 0 auto; padding: var(--oc-space-6) 0 var(--oc-space-8); }
a { color: inherit; text-decoration: none; }
a:hover { color: var(--oc-text-primary); text-decoration: underline; text-underline-offset: 3px; }
@media (max-width: 760px) {
main { width: min(100vw - 24px, var(--oc-content-max)); padding-top: var(--oc-space-5); }
}

:root { --activity-0-bg: var(--oc-bg-elevated); --activity-0-border: var(--oc-border-subtle); --activity-1-bg: color-mix(in srgb, var(--oc-accent-primary) 16%, var(--oc-bg-elevated)); --activity-1-border: color-mix(in srgb, var(--oc-accent-primary) 30%, var(--oc-border-subtle)); --activity-2-bg: color-mix(in srgb, var(--oc-accent-primary) 34%, var(--oc-bg-elevated)); --activity-2-border: color-mix(in srgb, var(--oc-accent-primary) 50%, var(--oc-border-subtle)); --activity-3-bg: color-mix(in srgb, var(--oc-accent-primary) 68%, var(--oc-bg-elevated)); --activity-3-border: var(--oc-accent-primary-hover); --activity-4-bg: var(--oc-accent-primary); --activity-4-border: var(--oc-accent-primary-deep); --activity-3-text: var(--oc-text-primary); --activity-4-text: var(--oc-text-on-accent); font-family: var(--oc-font-body); }
.open-period-status { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; color: var(--oc-text-muted); font-family: var(--oc-font-mono); font-size: 0.75rem; line-height: 1.4; }
.open-period-status time { color: inherit; }
.open-period-status [data-day-countdown] { color: var(--oc-text-secondary); }
.partial-report-badge { min-height: 1.25rem; padding: 0.2rem 0.4rem; font-family: var(--oc-font-body); font-size: 0.6875rem; }

.site-nav { position: sticky; top: 0; z-index: 20; border-bottom: 1px solid var(--oc-border-subtle); background: var(--oc-bg-page); }
.site-nav[data-scrolled="true"] { box-shadow: var(--oc-shadow-md, 0 6px 16px rgb(0 0 0 / 0.28)); }
.site-nav-inner { width: min(var(--oc-content-max), calc(100vw - 36px)); min-height: 58px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: var(--oc-space-5); }
.site-brand { display: inline-flex; align-items: center; gap: var(--oc-space-3); color: var(--oc-text-primary); font: 750 15px/1 var(--oc-font-display); }
.site-brand:hover { text-decoration: none; color: var(--oc-text-primary); }
.brand-mark { display: grid; place-items: center; width: 26px; height: 26px; flex: 0 0 26px; }
.brand-mark img { display: block; width: 100%; height: 100%; object-fit: contain; }
.site-links { display: flex; align-items: center; justify-content: flex-end; gap: var(--oc-space-1); overflow-x: auto; white-space: nowrap; }
.site-links a { min-height: 32px; padding: var(--oc-space-2) var(--oc-space-3); color: var(--oc-text-muted); font: 650 13px/1 var(--oc-font-body); }
.site-links a:hover { color: var(--oc-text-primary); text-decoration: none; }
.site-links a.is-active { color: var(--oc-text-primary); background: var(--oc-surface-interactive-hover); }
.theme-toggle { flex: 0 0 auto; width: 34px; min-height: 34px; height: 34px; padding: 0; color: var(--oc-text-primary); cursor: pointer; }
.theme-toggle svg { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; display: block; }
@media (max-width: 760px) {
.site-nav-inner { width: min(100vw - 24px, var(--oc-content-max)); height: auto; min-height: 58px; padding: var(--oc-space-3) 0; align-items: flex-start; flex-direction: column; }
.site-links { width: 100%; justify-content: flex-start; padding-bottom: 2px; }
}


body { font: var(--oc-font-size-base)/1.5 var(--oc-font-body); }
::selection { background: var(--oc-selection-bg); }
:where(a, button, input, summary, [tabindex]):focus-visible { outline: 2px solid var(--oc-focus-ring); outline-offset: 3px; }
[hidden] { display: none !important; }
:root:not([data-js]) .js-only, :root:not([data-js]) [data-toggle], :root:not([data-js]) [data-theme-toggle] { display: none !important; }
:root:not([data-js]) [data-extra][hidden] { display: grid !important; }
:root[data-people-hide-inactive="true"] [data-inactive="true"] { display: none !important; }
.theme-toggle .theme-moon { display: none; }
:root[data-theme="light"] .theme-toggle .theme-sun { display: none; }
:root[data-theme="light"] .theme-toggle .theme-moon { display: block; }
h1, h2, h3, p { margin: 0; }
h3 { color: var(--oc-text-primary); font-size: var(--oc-font-size-lg); line-height: 1.4; }
a, li, p { overflow-wrap: anywhere; }
small, .muted { color: var(--oc-text-muted); }
.details { color: var(--oc-text-secondary); font-size: var(--oc-font-size-sm); }
.actions, .identity-line, .pills { display: flex; flex-wrap: wrap; align-items: center; gap: var(--oc-space-2); }
.person-identity { display: flex; align-items: center; gap: var(--oc-space-3); min-width: 0; }
.oc-banner-content { overflow-wrap: anywhere; }
.oc-banner-content > .oc-badge { justify-self: start; }
.oc-banner ul { margin: 0; padding-left: var(--oc-space-5); }
.oc-section { min-width: 0; }
.oc-section-header { margin-bottom: var(--oc-space-4); }
main > .oc-section { margin-block: var(--oc-space-7); }
main > .oc-section:first-child { margin-top: 0; }
footer { width: min(var(--oc-content-max), calc(100vw - 36px)); margin: 28px auto 0; padding: 14px 0 var(--oc-space-5); color: var(--oc-text-muted); font-size: 12px; line-height: 1.5; border-top: 1px solid var(--oc-border-strong); }
.oc-action-icon svg { display: block; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
summary { width: fit-content; max-width: 100%; color: var(--oc-text-secondary); cursor: pointer; font-size: var(--oc-font-size-sm); }
details[open] > summary { margin-bottom: var(--oc-space-2); }
blockquote { border-left: 2px solid var(--oc-border-strong); padding: var(--oc-space-2) var(--oc-space-4); margin: var(--oc-space-2) 0; overflow-wrap: anywhere; }
.oc-table :is(th, td) { padding: var(--oc-space-3) var(--oc-space-4); border-bottom: 1px solid var(--oc-border-subtle); text-align: left; }
.oc-resource-list { width: 100%; margin: 0; padding: 0; overflow: hidden; border: 1px solid var(--oc-border-subtle); border-radius: var(--oc-radius-surface); background: var(--oc-surface-card); list-style: none; }
.oc-resource-list-item + .oc-resource-list-item { border-top: 1px solid var(--oc-border-subtle); }
.oc-resource-list-link, .resource-row { display: flex; align-items: center; justify-content: space-between; gap: var(--oc-space-3); padding: var(--oc-space-2) var(--oc-space-3); }
.oc-avatar { position: relative; display: inline-grid; flex: 0 0 auto; place-items: center; overflow: hidden; border: 1px solid var(--oc-border-subtle); border-radius: var(--oc-radius-surface); background: var(--oc-surface-secondary-soft); color: var(--oc-accent-secondary); font-weight: 650; line-height: 1; }
.oc-avatar::before { content: attr(data-initials); }
/* Transparent failed images leave the CSS initials beneath them visible. */
.oc-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; color: transparent; font-size: 0; }
.oc-avatar-xs { width: 20px; height: 20px; font-size: var(--oc-font-size-xs); }
.oc-avatar-md { width: 40px; height: 40px; font-size: var(--oc-font-size-sm); }
.oc-avatar-sm { width: 36px; height: 36px; font-size: var(--oc-font-size-sm); }
.oc-avatar-xl { width: 72px; height: 72px; font-size: var(--oc-font-size-2xl); }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } }
@media (max-width: 760px) { footer { width: calc(100vw - 24px); } }


body[data-report-page="home"] main { width:min(var(--oc-content-max),calc(100vw - 36px)); margin:0 auto; padding:var(--oc-space-6) 0 var(--oc-space-8); }
body[data-report-page="home"] header { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--oc-space-6); align-items:end; border-bottom:1px solid var(--oc-border-subtle); padding-bottom:var(--oc-space-5); margin-bottom:var(--oc-space-4); }
body[data-report-page="home"] h1 { margin:0; color:var(--oc-text-primary); font:740 34px/1.05 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:0; }
body[data-report-page="home"] h2 { margin:4px 0 16px; color:var(--oc-text-primary); font:740 22px/1.2 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:0; }
body[data-report-page="home"] .subtitle, body[data-report-page="home"] .meta { color:var(--oc-text-muted); line-height:1.45; }
body[data-report-page="home"] .grid { display:grid; gap:var(--oc-space-7); }
body[data-report-page="home"] .quick-card { display:grid; align-content:start; gap:var(--oc-space-1); min-height:104px; padding:var(--oc-space-4); }
body[data-report-page="home"] .quick-card.partial { border-color:var(--oc-border-accent); }
body[data-report-page="home"] .quick-card:hover { text-decoration:none; border-color:var(--oc-component-border-hover); background:var(--oc-surface-interactive); }
body[data-report-page="home"] .quick-title { display:block; margin-top:4px; font-size:20px; font-weight:800; line-height:1.15; }
body[data-report-page="home"] .quick-meta { display:block; margin-top:2px; text-wrap:balance; color:var(--oc-text-muted); font-size:13px; line-height:1.35; }
body[data-report-page="home"] .panel { padding:0; }
body[data-report-page="home"] .toggle { appearance:none; border-radius:var(--oc-radius-control); font-family:var(--oc-font-mono); cursor:pointer; }
body[data-report-page="home"] .toggle:hover { background:var(--oc-surface-accent-soft); }
body[data-report-page="home"] .row { display:grid; grid-template-columns:minmax(0,1fr) auto 15.5rem; gap:16px; align-items:center; padding:12px 0; border-top:1px solid var(--oc-border-subtle); }
body[data-report-page="home"] .row-trend { display:block; }
body[data-report-page="home"] .row-trend .oc-sparkline { width:6.5rem; }
body[data-report-page="home"] .row:first-child { border-top:0; }
body[data-report-page="home"] .row[hidden] { display:none; }
body[data-report-page="home"] .title { color:var(--oc-text-primary); font-size:17px; font-weight:800; }
body[data-report-page="home"] .date { color:var(--oc-text-muted); font-size:14px; line-height:1.35; }
body[data-report-page="home"] .row-title-line { display:inline-flex; flex-wrap:wrap; align-items:center; gap:var(--oc-space-2); }
body[data-report-page="home"] .stats { color:var(--oc-text-muted); font-size:13px; text-align:right; }
body[data-report-page="home"] .stats strong { color:var(--oc-text-primary); }
body[data-report-page="home"] .home-banner { margin: 0; }
body[data-report-page="home"] .home-banner .oc-brand-banner-content h1 { margin: 0; color: var(--oc-text-primary); font: 740 34px/1.05 var(--oc-font-display); }
body[data-report-page="home"] .home-banner .oc-brand-banner-content p:last-child { color: var(--oc-text-secondary); }
body[data-report-page="home"] .home-banner-stamp { position: absolute; top: var(--oc-space-4); right: var(--oc-space-4); z-index: 1; padding: var(--oc-space-1) var(--oc-space-3); border: 1px solid var(--oc-border-subtle); border-radius: var(--oc-radius-full, 999px); background: color-mix(in srgb, var(--oc-bg-page) 72%, transparent); backdrop-filter: blur(6px); color: var(--oc-text-muted); font-family: var(--oc-font-mono); font-size: 11px; line-height: 1.6; text-transform: lowercase; letter-spacing: 0.02em; }
body[data-report-page="home"] .home-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 1px; margin-bottom: var(--oc-space-7); overflow: hidden; border: 1px solid var(--oc-border-subtle); border-radius: var(--oc-radius-surface); background: var(--oc-border-subtle); }
body[data-report-page="home"] .home-grid > * { border: 0; border-radius: 0; background: var(--oc-bg-surface); }
body[data-report-page="home"] .home-grid > .home-banner { grid-column: 1 / -1; }
body[data-report-page="home"] .home-grid > .oc-banner { grid-column: 1 / -1; }
body[data-report-page="home"] .home-grid > .quick-card { grid-column: span 2; min-height: 0; }
body[data-report-page="home"] .home-grid > .home-card { grid-column: span 3; }
body[data-report-page="home"] .home-grid .oc-summary-strip { background: transparent; }
body[data-report-page="home"] .home-grid .oc-summary-strip { grid-template-columns: repeat(auto-fit, minmax(6rem, 1fr)); }
body[data-report-page="home"] .home-grid .oc-summary-strip { border: 0; border-radius: 0; margin-top: auto; }
body[data-report-page="home"] .home-grid .oc-summary-metric { padding-inline: 0; }
body[data-report-page="home"] .home-grid .oc-summary-metric-copy small:last-child { overflow: visible; white-space: normal; }
body[data-report-page="home"] .home-grid > .home-card { display: flex; flex-direction: column; gap: var(--oc-space-3); padding: var(--oc-space-4); }
body[data-report-page="home"] .panel-link { min-height: 2rem; padding: var(--oc-space-1) var(--oc-space-3); border-color: var(--oc-border-subtle); color: var(--oc-text-secondary); font-size: var(--oc-font-size-xs); font-weight: 600; }
body[data-report-page="home"] .panel-link:hover { border-color: var(--oc-border-strong); background: var(--oc-surface-interactive-hover); color: var(--oc-text-primary); text-decoration: none; }
body[data-report-page="home"] .panel-link span { transition: transform var(--oc-duration-fast, 140ms) var(--oc-ease-out, ease); }
body[data-report-page="home"] .panel-link:hover span { transform: translateX(2px); }
body[data-report-page="home"] .home-dateline { display: grid; grid-column: 1 / -1; gap: var(--oc-space-2); padding: var(--oc-space-4); }
body[data-report-page="home"] .home-dateline-scale { display: flex; justify-content: space-between; color: var(--oc-text-muted); font-family: var(--oc-font-mono); font-size: 11px; }
body[data-report-page="home"] .quick-trend { display: grid; gap: var(--oc-space-1); margin-top: var(--oc-space-2); }
body[data-report-page="home"] .quick-trend .oc-sparkline { max-width: none; }
body[data-report-page="home"] .home-card-top { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; }
body[data-report-page="home"] .home-card-top h2 { margin:4px 0 0; font-size:18px; }
body[data-report-page="home"] .home-card-top p { margin:4px 0 0; color:var(--oc-text-muted); font-size:13px; line-height:1.45; }
body[data-report-page="home"] .home-actions-row { flex:0 0 auto; display:flex; justify-content:flex-end; }
@media (max-width: 860px) {
body[data-report-page="home"] .home-grid { grid-template-columns: minmax(0, 1fr); }
body[data-report-page="home"] .home-grid > .quick-card, body[data-report-page="home"] .home-grid > .home-card { grid-column: 1 / -1; }
}
@media (max-width: 760px) {
body[data-report-page="home"] main { width:min(100vw - 24px,1120px); padding-top:24px; }
body[data-report-page="home"] h1 { font-size:30px; }
body[data-report-page="home"] header { grid-template-columns:1fr; }
body[data-report-page="home"] .quick { grid-template-columns:1fr; }
body[data-report-page="home"] .home-banner-stamp { position: static; margin-bottom: var(--oc-space-3); width: fit-content; }
body[data-report-page="home"] .home-banner .oc-brand-banner-content h1 { font-size: 28px; }
body[data-report-page="home"] .home-card-top { flex-direction:column; }
body[data-report-page="home"] .home-actions-row { justify-content:flex-start; }
body[data-report-page="home"] .row { grid-template-columns:1fr; gap:6px; }
body[data-report-page="home"] .row-trend { display:none; }
body[data-report-page="home"] .stats { text-align:left; }
}

body[data-report-page="report"] .oc-summary-strip .oc-summary-metric { align-items: flex-start; }
body[data-report-page="report"] .oc-summary-strip .oc-summary-metric-copy small { overflow: visible; white-space: normal; }
body[data-report-page="report"] .mix-split { display: grid; gap: var(--oc-space-2); margin-top: var(--oc-space-3); }
body[data-report-page="report"] .maintainer-distribution { display:grid; gap:var(--oc-space-3); margin-top:var(--oc-space-5); padding-top:var(--oc-space-5); border-top:1px solid var(--oc-border-subtle); }
body[data-report-page="report"] .distribution-heading { display:flex; align-items:end; justify-content:space-between; gap:var(--oc-space-4); }
body[data-report-page="report"] .distribution-heading h3 { margin:var(--oc-space-1) 0 0; color:var(--oc-text-primary); font:740 18px/1.2 var(--oc-font-display); }
body[data-report-page="report"] .ranked-distribution-list { display:grid; gap:var(--oc-space-1); margin:0; padding:0; list-style:none; counter-reset:distribution-rank; }
body[data-report-page="report"] .distribution-more .ranked-distribution-list { margin-top:var(--oc-space-2); }
body[data-report-page="report"] .ranked-distribution-list li { counter-increment:distribution-rank; }
body[data-report-page="report"] .ranked-distribution-list li > a, body[data-report-page="report"] .ranked-distribution-list li > span { display:grid; grid-template-columns:minmax(8rem, 14rem) minmax(5rem, 1fr) 5rem 3rem; align-items:center; gap:var(--oc-space-3); min-height:2rem; color:var(--oc-text-secondary); }
body[data-report-page="report"] .ranked-distribution-list li > a:hover { color:var(--oc-text-primary); text-decoration:none; }
body[data-report-page="report"] .distribution-label { display:grid; min-width:0; overflow:hidden; align-content:center; gap:1px; }
body[data-report-page="report"] .distribution-label-primary, body[data-report-page="report"] .distribution-label-detail { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
body[data-report-page="report"] .distribution-label-primary { color:var(--oc-text-primary); font-weight:650; }
body[data-report-page="report"] .distribution-label-detail { color:var(--oc-text-muted); font-size:var(--oc-font-size-xs); font-weight:500; line-height:1.2; }
body[data-report-page="report"] .distribution-track { height:0.55rem; overflow:hidden; border-radius:var(--oc-radius-round); background:var(--oc-surface-secondary-soft); }
body[data-report-page="report"] .distribution-segment { display:block; min-width:1px; height:100%; background:var(--oc-chart-color,var(--oc-accent-primary)); }
body[data-report-page="report"] .oc-split-tertiary { --oc-chart-color:color-mix(in srgb,var(--oc-accent-primary) 48%,var(--oc-accent-secondary)); }
body[data-report-page="report"] .oc-split-quaternary { --oc-chart-color:var(--oc-accent-secondary-deep); }
body[data-report-page="report"] .oc-split-neutral { --oc-chart-color:color-mix(in srgb,var(--oc-border-strong) 58%,var(--oc-text-muted)); }
body[data-report-page="report"] .distribution-total { color:var(--oc-text-primary); font-variant-numeric:tabular-nums; text-align:right; }
body[data-report-page="report"] .distribution-share { color:var(--oc-text-muted); font-family:var(--oc-font-mono); font-size:var(--oc-font-size-xs); text-align:right; }
body[data-report-page="report"] .distribution-breakdown { grid-column:2 / -1; display:flex; flex-wrap:wrap; gap:var(--oc-space-1) var(--oc-space-3); color:var(--oc-text-muted); font-size:var(--oc-font-size-xs); line-height:1.25; }
body[data-report-page="report"] .distribution-breakdown-item { display:inline-flex; align-items:center; gap:var(--oc-space-1); white-space:nowrap; }
body[data-report-page="report"] .distribution-breakdown-key { width:0.45rem; height:0.45rem; flex:0 0 auto; border-radius:2px; background:var(--oc-chart-color,var(--oc-accent-primary)); }
body[data-report-page="report"] .distribution-more { border-top:1px solid var(--oc-border-subtle); padding-top:var(--oc-space-2); }
body[data-report-page="report"] .distribution-more summary { width:fit-content; color:var(--oc-text-secondary); font-size:var(--oc-font-size-sm); cursor:pointer; }
body[data-report-page="report"] { margin: 0; background: var(--oc-bg-page); color: var(--oc-text-secondary); -webkit-font-smoothing: antialiased; }
body[data-report-page="report"] .shell { width: min(var(--oc-content-max), calc(100vw - 36px)); margin: 0 auto; padding: var(--oc-space-6) 0 var(--oc-space-8); }
body[data-report-page="report"] header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--oc-space-6); align-items: end; padding: 0 0 var(--oc-space-5); border-bottom: 1px solid var(--oc-border-subtle); }
body[data-report-page="report"] h1 { margin: 0; color: var(--oc-text-primary); font: 740 34px/1.05 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0; }
body[data-report-page="report"] .subtitle { margin: 12px 0 0; color: var(--oc-text-muted); font-size: 14px; line-height: 1.5; max-width: 760px; }
body[data-report-page="report"] .stamp .label, body[data-report-page="report"] .metric .label, body[data-report-page="report"] .section-kicker, body[data-report-page="report"] .person-meta, body[data-report-page="report"] .small { color: var(--oc-text-muted); font-family: var(--oc-font-mono); font-size: 12px; line-height: 1.35; text-transform: uppercase; }
body[data-report-page="report"] .panel { margin: var(--oc-space-7) 0; padding: 0; }
body[data-report-page="report"] .collection-section { padding: 0; border: 0; background: transparent; box-shadow: none; }
body[data-report-page="report"] .people-head { align-items: start; }
body[data-report-page="report"] .people-tools { width: min(390px, 100%); display: grid; gap: 8px; }
body[data-report-page="report"] .person-filter { width: 100%; min-height: 42px; padding: 9px 12px; border: 1px solid var(--oc-border-subtle); border-radius: var(--oc-radius-control); background: var(--oc-surface-card-strong); color: var(--oc-text-primary); font: 740 14px/1.2 var(--oc-font-mono); outline: none; box-shadow: inset 0 0 0 1px rgba(24, 23, 20, 0); }
body[data-report-page="report"] .person-filter:focus { box-shadow: inset 0 0 0 1px var(--oc-accent-primary), 0 0 0 3px color-mix(in srgb, var(--oc-accent-primary) 18%, transparent); }
body[data-report-page="report"] .filter-status { min-height: 17px; color: var(--oc-text-muted); font-size: 12px; line-height: 1.35; text-transform: uppercase; }
body[data-report-page="report"] h2 { margin: 0; color: var(--oc-text-primary); font: 740 20px/1.2 var(--oc-font-display); letter-spacing: 0; }
body[data-report-page="report"] .shell > .oc-section { margin: var(--oc-space-7) 0; }
body[data-report-page="report"] .shell > .oc-section:first-of-type { margin-top: var(--oc-space-5); }
body[data-report-page="report"] .oc-section-header { margin-bottom: var(--oc-space-4); }
body[data-report-page="report"] .section-note { max-width: 46ch; margin: 0; color: var(--oc-text-muted); font-size: var(--oc-font-size-xs); line-height: 1.45; text-align: right; }
body[data-report-page="report"] .summary-markdown { color: var(--oc-text-primary); font-size: 15px; line-height: 1.48; }
body[data-report-page="report"] .summary-markdown p { margin: 0 0 12px; }
body[data-report-page="report"] .summary-markdown p:last-child { margin-bottom: 0; }
body[data-report-page="report"] .summary-markdown ul { display: grid; gap: 8px; margin: 14px 0 0; padding: 0; list-style: none; }
body[data-report-page="report"] .summary-markdown li { position: relative; padding-left: 18px; }
body[data-report-page="report"] .summary-markdown li::before { content: ""; position: absolute; left: 0; top: 0.72em; width: 7px; height: 7px; border-radius: 999px; background: var(--oc-status-error-fg); }
body[data-report-page="report"] .summary-markdown strong { font-weight: 800; }
body[data-report-page="report"] .summary-markdown code { padding: 1px 5px; border: 1px solid var(--oc-border-subtle); border-radius: 5px; background: color-mix(in srgb, var(--oc-surface-card) 84%, transparent); font: 0.92em ui-monospace, SFMono-Regular, Menlo, monospace; }
body[data-report-page="report"] .summary-markdown a { color: inherit; text-decoration-color: var(--oc-border-strong); text-underline-offset: 3px; }
body[data-report-page="report"] .people { display: grid; gap: 12px; }
body[data-report-page="report"] .person { display: grid; grid-template-columns: 198px minmax(0, 1fr) 150px; gap: 16px; padding: 14px; }
body[data-report-page="report"] .person:hover { border-color: color-mix(in srgb, var(--oc-accent-primary) 42%, var(--oc-border-strong)); background: color-mix(in srgb, var(--oc-surface-card) 82%, var(--oc-accent-primary) 8%); }
body[data-report-page="report"] .person[hidden] { display: none; }
body[data-report-page="report"] .quiet-maintainers { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--oc-border-subtle); }
body[data-report-page="report"] .quiet-title { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 14px; margin-bottom: 10px; }
body[data-report-page="report"] .quiet-title h3 { margin: 0; font-size: 15px; line-height: 1.25; letter-spacing: 0; }
body[data-report-page="report"] .quiet-list { display: flex; flex-wrap: wrap; gap: 7px; margin: 0; padding: 0; list-style: none; }
body[data-report-page="report"] .quiet-list li { max-width: 100%; padding: 4px 8px; border: 1px solid var(--oc-border-strong); border-radius: 999px; background: color-mix(in srgb, var(--oc-surface-accent-soft) 72%, transparent); color: var(--oc-text-muted); font-size: 12px; line-height: 1.25; overflow-wrap: anywhere; }
body[data-report-page="report"] .person-title { min-width: 0; }
body[data-report-page="report"] .person-heading { display: flex; align-items: center; gap: 10px; min-width: 0; }
body[data-report-page="report"] .person-heading > div { min-width: 0; }
body[data-report-page="report"] .handle { color: var(--oc-text-primary); font: 800 17px/1.15 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow-wrap: anywhere; }
body[data-report-page="report"] .person-name { margin-top: 3px; color: var(--oc-text-muted); font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
body[data-report-page="report"] .affiliation { margin-top: 7px; display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 4px 8px; border: 1px solid var(--oc-border-strong); border-radius: 999px; background: color-mix(in srgb, var(--oc-status-success-fg) 14%, var(--oc-surface-card-strong)); color: var(--oc-status-success-fg); font-size: 12px; font-weight: 700; line-height: 1.2; overflow-wrap: anywhere; }
body[data-report-page="report"] .affiliation.is-na { border-color: var(--oc-border-strong); background: color-mix(in srgb, var(--oc-bg-elevated) 82%, var(--oc-surface-card-strong)); color: var(--oc-text-muted); }
body[data-report-page="report"] .affiliation.is-readonly { border-color: color-mix(in srgb, var(--oc-status-info-fg) 46%, var(--oc-border-strong)); background: color-mix(in srgb, var(--oc-status-info-fg) 13%, var(--oc-surface-card-strong)); color: color-mix(in srgb, var(--oc-status-info-fg) 76%, var(--oc-text-primary)); }
body[data-report-page="report"] .affiliation.is-independent { border-color: color-mix(in srgb, var(--oc-status-warning-fg) 46%, var(--oc-border-strong)); background: color-mix(in srgb, var(--oc-status-warning-fg) 16%, var(--oc-surface-card-strong)); color: color-mix(in srgb, var(--oc-status-warning-fg) 88%, var(--oc-text-primary)); }
body[data-report-page="report"] .role-line { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
body[data-report-page="report"] .person-body { min-width: 0; display: grid; gap: 10px; }
body[data-report-page="report"] .chips { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 7px; }
body[data-report-page="report"] .theme { margin: 0; color: var(--oc-text-primary); font-size: 13px; line-height: 1.42; }
body[data-report-page="report"] .theme + .theme { color: var(--oc-text-muted); }
body[data-report-page="report"] .focus { margin: 0; color: var(--oc-text-primary); font-size: 14px; line-height: 1.48; }
body[data-report-page="report"] .person-numbers { display: grid; gap: 8px; align-content: start; }
body[data-report-page="report"] .number-line { display: flex; justify-content: space-between; gap: 8px; color: var(--oc-text-muted); font-size: 13px; border-bottom: 1px solid var(--oc-border-subtle); padding-bottom: 5px; }
body[data-report-page="report"] .number-line strong { color: var(--oc-text-primary); }
body[data-report-page="report"] footer { margin-top: 28px; color: var(--oc-text-muted); font-size: 12px; line-height: 1.5; border-top: 1px solid var(--oc-border-strong); padding-top: 14px; }
@media (max-width: 980px) {
body[data-report-page="report"] header, body[data-report-page="report"] .mix { grid-template-columns: 1fr; }
body[data-report-page="report"] .person { grid-template-columns: 1fr; }
body[data-report-page="report"] .people-head { align-items: stretch; }
}
@media (max-width: 640px) {
body[data-report-page="report"] .shell { width: min(100vw - 24px, 1180px); padding-top: 20px; }
body[data-report-page="report"] h1 { font-size: 28px; }
body[data-report-page="report"] .distribution-heading { align-items:start; flex-direction:column; }
body[data-report-page="report"] .distribution-heading .section-note { text-align:left; }
body[data-report-page="report"] .ranked-distribution-list li > a, body[data-report-page="report"] .ranked-distribution-list li > span { grid-template-columns:minmax(7rem,1fr) 5rem 2.5rem; gap:var(--oc-space-2); }
body[data-report-page="report"] .distribution-track { grid-column:1 / -1; grid-row:2; }
body[data-report-page="report"] .distribution-breakdown { grid-column:1 / -1; grid-row:3; }
}

body[data-report-page="people"] .people-header, body[data-report-page="person"] .people-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--oc-space-6); align-items: end; padding-bottom: var(--oc-space-5); margin-bottom: var(--oc-space-5); border-bottom: 1px solid var(--oc-border-subtle); }
body[data-report-page="people"] h1, body[data-report-page="person"] h1 { margin: 0; color: var(--oc-text-primary); font: 740 34px/1.05 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body[data-report-page="people"] h2, body[data-report-page="person"] h2 { margin: 4px 0 0; color: var(--oc-text-primary); font: 740 22px/1.2 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body[data-report-page="people"] p, body[data-report-page="person"] p { margin: 10px 0 0; color: var(--oc-text-muted); }
body[data-report-page="people"] .people-grid, body[data-report-page="person"] .people-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(330px, 100%), 1fr)); gap: 12px; }
body[data-report-page="people"] .people-break, body[data-report-page="person"] .people-break { grid-column: 1 / -1; display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 6px 0 -2px; padding: 12px 2px 2px; border-top: 1px solid var(--oc-border-subtle); color: var(--oc-text-muted); font-size: 12px; line-height: 1.35; text-transform: uppercase; }
body[data-report-page="people"] .people-break span:first-child, body[data-report-page="person"] .people-break span:first-child { color: var(--oc-text-primary); font: 800 13px/1.2 ui-sans-serif, system-ui, sans-serif; text-transform: none; }
body[data-report-page="people"] .person-card, body[data-report-page="person"] .person-card { display: grid; gap: 10px; padding: 14px; }
body[data-report-page="people"] .person-card:hover, body[data-report-page="person"] .person-card:hover { border-color: var(--oc-accent-primary); background: color-mix(in srgb, var(--oc-surface-card) 82%, var(--oc-accent-primary) 8%); }
body[data-report-page="people"] .person-card.is-inactive, body[data-report-page="person"] .person-card.is-inactive { background: color-mix(in srgb, var(--oc-surface-card) 78%, var(--oc-bg-elevated)); }
body[data-report-page="people"] .person-card-head, body[data-report-page="person"] .person-card-head, body[data-report-page="people"] .person-hero, body[data-report-page="person"] .person-hero { display: flex; align-items: center; gap: 10px; min-width: 0; }
body[data-report-page="people"] .person-card-head > span, body[data-report-page="person"] .person-card-head > span, body[data-report-page="people"] .person-hero > div, body[data-report-page="person"] .person-hero > div { min-width: 0; }
body[data-report-page="people"] .person-card-identity, body[data-report-page="person"] .person-card-identity { display: grid; gap: 2px; min-width: 0; }
body[data-report-page="people"] .person-card strong, body[data-report-page="person"] .person-card strong { display: block; color: var(--oc-text-primary); font: 760 17px/1.2 ui-sans-serif, system-ui, sans-serif; overflow-wrap: anywhere; }
body[data-report-page="people"] .person-handle, body[data-report-page="person"] .person-handle, body[data-report-page="people"] .person-card-meta, body[data-report-page="person"] .person-card-meta { color: var(--oc-text-muted); font-size: 12px; line-height: 1.35; overflow-wrap: anywhere; }
body[data-report-page="people"] .person-company, body[data-report-page="person"] .person-company, body[data-report-page="people"] .person-company-line, body[data-report-page="person"] .person-company-line { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; min-width: 0; color: var(--oc-text-secondary); font-size: 13px; line-height: 1.35; }
body[data-report-page="people"] .person-company span, body[data-report-page="person"] .person-company span, body[data-report-page="people"] .person-company-line span, body[data-report-page="person"] .person-company-line span { min-width: 0; overflow-wrap: anywhere; }
body[data-report-page="people"] .person-card-meta, body[data-report-page="person"] .person-card-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
body[data-report-page="people"] .mini-strip, body[data-report-page="person"] .mini-strip { display: grid; grid-template-columns: repeat(28, minmax(0, 1fr)); gap: 3px; align-items: center; }
body[data-report-page="people"] .legend, body[data-report-page="person"] .legend { display: flex; gap: 4px; align-items: center; }
body[data-report-page="people"] .day-dot, body[data-report-page="person"] .day-dot, body[data-report-page="people"] .legend span, body[data-report-page="person"] .legend span { min-width: 0; height: 10px; border: 1px solid var(--activity-0-border); border-radius: 3px; background: var(--activity-0-bg); }
body[data-report-page="people"] .legend span, body[data-report-page="person"] .legend span { width: 13px; height: 13px; }
body[data-report-page="people"] .archive-panel, body[data-report-page="person"] .archive-panel { padding: 0; margin: 32px 0; }
body[data-report-page="people"] .month-row, body[data-report-page="person"] .month-row { display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: 18px; align-items: start; padding: 14px 0; border-top: 1px solid var(--oc-border-subtle); }
body[data-report-page="people"] .month-row:first-child, body[data-report-page="person"] .month-row:first-child { border-top: 0; }
body[data-report-page="people"] .month-label, body[data-report-page="person"] .month-label { color: var(--oc-text-primary); font-weight: 760; padding-top: 26px; }
body[data-report-page="people"] .calendar, body[data-report-page="person"] .calendar { width: min(100%, 268px); --calendar-gap: 5px; }
body[data-report-page="people"] .weekday-row, body[data-report-page="person"] .weekday-row, body[data-report-page="people"] .day-grid, body[data-report-page="person"] .day-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: var(--calendar-gap); width: 100%; }
body[data-report-page="people"] .weekday-row, body[data-report-page="person"] .weekday-row { margin-bottom: 6px; color: var(--oc-text-muted); font-size: 10px; text-align: center; text-transform: uppercase; }
body[data-report-page="people"] .day-grid, body[data-report-page="person"] .day-grid { align-items: center; }
body[data-report-page="people"] .day-spacer, body[data-report-page="person"] .day-spacer, body[data-report-page="people"] .day-cell, body[data-report-page="person"] .day-cell { width: 100%; aspect-ratio: 1; min-width: 0; }
body[data-report-page="people"] .day-cell, body[data-report-page="person"] .day-cell { display: grid; place-items: center; min-height: 24px; border: 1px solid var(--activity-0-border); border-radius: 6px; color: var(--oc-text-muted); font-size: 11px; font-weight: 760; }
body[data-report-page="people"] .day-cell:hover, body[data-report-page="person"] .day-cell:hover { border-color: var(--oc-accent-primary); color: var(--oc-text-primary); outline: 2px solid color-mix(in srgb, var(--oc-accent-primary) 24%, transparent); outline-offset: 1px; }
body[data-report-page="people"] .level-0, body[data-report-page="person"] .level-0 { background: var(--activity-0-bg); border-color: var(--activity-0-border); }
body[data-report-page="people"] .level-1, body[data-report-page="person"] .level-1, body[data-report-page="person"] .legend .level-1 { background: var(--activity-1-bg); border-color: var(--activity-1-border); color: var(--oc-text-primary); }
body[data-report-page="people"] .level-2, body[data-report-page="person"] .level-2, body[data-report-page="person"] .legend .level-2 { background: var(--activity-2-bg); border-color: var(--activity-2-border); color: var(--oc-text-primary); }
body[data-report-page="people"] .level-3, body[data-report-page="person"] .level-3, body[data-report-page="person"] .legend .level-3 { background: var(--activity-3-bg); border-color: var(--activity-3-border); color: var(--activity-3-text); }
body[data-report-page="people"] .level-4, body[data-report-page="person"] .level-4, body[data-report-page="person"] .legend .level-4 { background: var(--activity-4-bg); border-color: var(--activity-4-border); color: var(--activity-4-text); }
body[data-report-page="people"] .activity-list, body[data-report-page="person"] .activity-list { display: grid; gap: 10px; }
body[data-report-page="people"] .activity-row, body[data-report-page="person"] .activity-row { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 16px; padding: 14px; border: 1px solid var(--oc-border-subtle); border-radius: var(--oc-radius-surface); background: var(--oc-bg-elevated); }
body[data-report-page="people"] .activity-row:hover, body[data-report-page="person"] .activity-row:hover { border-color: var(--oc-accent-primary); }
body[data-report-page="people"] .activity-date, body[data-report-page="person"] .activity-date { color: var(--oc-text-primary); font-weight: 760; }
body[data-report-page="people"] .activity-row strong, body[data-report-page="person"] .activity-row strong, body[data-report-page="people"] .activity-row span span, body[data-report-page="person"] .activity-row span span { display: block; }
body[data-report-page="people"] .activity-row strong, body[data-report-page="person"] .activity-row strong { color: var(--oc-text-primary); }
body[data-report-page="people"] .activity-row span span, body[data-report-page="person"] .activity-row span span { color: var(--oc-text-muted); font-size: 13px; line-height: 1.45; }
body[data-report-page="people"] .activity-row p, body[data-report-page="person"] .activity-row p { margin-top: 6px; color: var(--oc-text-secondary); font-size: 13px; }
body[data-report-page="people"] .person-activity-panel, body[data-report-page="person"] .person-activity-panel { min-width: 0; }
body[data-report-page="people"] .person-activity-legend, body[data-report-page="person"] .person-activity-legend { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px 16px; margin: 4px 0 0; padding: 0; color: var(--oc-text-muted); font-size: 12px; line-height: 1.35; list-style: none; }
body[data-report-page="people"] .person-activity-legend li, body[data-report-page="person"] .person-activity-legend li { display: inline-flex; align-items: center; gap: 7px; }
body[data-report-page="people"] .person-activity-swatch, body[data-report-page="person"] .person-activity-swatch { width: 18px; height: 3px; flex: 0 0 auto; border-radius: 2px; }
body[data-report-page="people"] .person-activity-swatch.is-github, body[data-report-page="person"] .person-activity-swatch.is-github { background: var(--oc-status-success-fg); }
body[data-report-page="people"] .person-activity-swatch.is-discord, body[data-report-page="person"] .person-activity-swatch.is-discord { background: var(--oc-status-info-fg); }
body[data-report-page="people"] .person-activity-chart, body[data-report-page="person"] .person-activity-chart { min-width: 0; margin-top: 16px; border: 1px solid var(--oc-border-subtle); border-radius: var(--oc-radius-surface); background: var(--oc-bg-elevated); touch-action: pan-y; }
body[data-report-page="people"] .person-activity-chart:focus-visible, body[data-report-page="person"] .person-activity-chart:focus-visible { outline: 2px solid var(--oc-accent-primary); outline-offset: 2px; }
body[data-report-page="people"] .person-activity-svg, body[data-report-page="person"] .person-activity-svg { display: block; width: 100%; height: clamp(250px, 36vw, 390px); overflow: visible; }
body[data-report-page="people"] .person-activity-axis, body[data-report-page="person"] .person-activity-axis, body[data-report-page="people"] .person-activity-gridline, body[data-report-page="person"] .person-activity-gridline, body[data-report-page="people"] .person-activity-line, body[data-report-page="person"] .person-activity-line { vector-effect: non-scaling-stroke; }
body[data-report-page="people"] .person-activity-axis, body[data-report-page="person"] .person-activity-axis { fill: none; stroke: var(--oc-border-strong); stroke-width: 1; }
body[data-report-page="people"] .person-activity-gridline, body[data-report-page="person"] .person-activity-gridline { stroke: var(--oc-border-subtle); stroke-width: 1; }
body[data-report-page="people"] .person-activity-axis-tick, body[data-report-page="person"] .person-activity-axis-tick { fill: var(--oc-text-muted); font: 11px/1 var(--oc-font-mono); }
body[data-report-page="people"] .person-activity-axis-tick-left, body[data-report-page="person"] .person-activity-axis-tick-left { text-anchor: end; }
body[data-report-page="people"] .person-activity-axis-tick-right, body[data-report-page="person"] .person-activity-axis-tick-right { text-anchor: start; }
body[data-report-page="people"] .person-activity-axis-title, body[data-report-page="person"] .person-activity-axis-title { font: 800 12px/1 var(--oc-font-mono); }
body[data-report-page="people"] .person-activity-axis-title-github, body[data-report-page="person"] .person-activity-axis-title-github { fill: var(--oc-status-success-fg); }
body[data-report-page="people"] .person-activity-axis-title-discord, body[data-report-page="person"] .person-activity-axis-title-discord { fill: var(--oc-status-info-fg); }
body[data-report-page="people"] .person-activity-line, body[data-report-page="person"] .person-activity-line { fill: none; stroke-width: 2.25; stroke-linecap: round; stroke-linejoin: round; }
body[data-report-page="people"] .person-activity-line-github, body[data-report-page="person"] .person-activity-line-github { stroke: var(--oc-status-success-fg); }
body[data-report-page="people"] .person-activity-line-discord, body[data-report-page="person"] .person-activity-line-discord { stroke: var(--oc-status-info-fg); }
body[data-report-page="people"] .person-activity-point, body[data-report-page="person"] .person-activity-point { stroke: var(--oc-bg-elevated); stroke-width: 1; vector-effect: non-scaling-stroke; }
body[data-report-page="people"] .person-activity-point-github, body[data-report-page="person"] .person-activity-point-github { fill: var(--oc-status-success-fg); }
body[data-report-page="people"] .person-activity-point-discord, body[data-report-page="person"] .person-activity-point-discord { fill: var(--oc-status-info-fg); }
body[data-report-page="people"] .person-activity-quality-note, body[data-report-page="person"] .person-activity-quality-note { margin-top: 10px; font-size: 12px; line-height: 1.45; }
body[data-report-page="people"] .person-activity-values, body[data-report-page="person"] .person-activity-values { margin-top: 12px; border-top: 1px solid var(--oc-border-subtle); }
body[data-report-page="people"] .person-activity-values summary, body[data-report-page="person"] .person-activity-values summary { padding: 12px 0 4px; color: var(--oc-text-primary); font-weight: 760; cursor: pointer; }
body[data-report-page="people"] .person-activity-table-wrap, body[data-report-page="person"] .person-activity-table-wrap { max-width: 100%; overflow-x: auto; }
body[data-report-page="people"] .person-activity-table, body[data-report-page="person"] .person-activity-table { width: 100%; min-width: 700px; border-collapse: collapse; margin-top: 8px; }
body[data-report-page="people"] .person-activity-table th, body[data-report-page="person"] .person-activity-table th, body[data-report-page="people"] .person-activity-table td, body[data-report-page="person"] .person-activity-table td { padding: 9px 10px; border-bottom: 1px solid var(--oc-border-subtle); text-align: left; vertical-align: top; }
body[data-report-page="people"] .person-activity-table thead th, body[data-report-page="person"] .person-activity-table thead th { color: var(--oc-text-muted); font-size: 11px; text-transform: uppercase; }
body[data-report-page="people"] .person-activity-table tbody th, body[data-report-page="person"] .person-activity-table tbody th { color: var(--oc-text-primary); font: 760 12px/1.35 var(--oc-font-mono); }
body[data-report-page="people"] .person-activity-table td, body[data-report-page="person"] .person-activity-table td { color: var(--oc-text-secondary); font-size: 12px; line-height: 1.4; }
body[data-report-page="people"] .breadcrumbs, body[data-report-page="person"] .breadcrumbs { display: flex; gap: 8px; color: var(--oc-text-muted); font-size: 12px; margin-bottom: 12px; }
body[data-report-page="people"] .breadcrumbs a, body[data-report-page="person"] .breadcrumbs a { color: var(--oc-accent-primary); }
@media (max-width: 760px) {
body[data-report-page="people"] .people-header, body[data-report-page="person"] .people-header, body[data-report-page="people"] .month-row, body[data-report-page="person"] .month-row, body[data-report-page="people"] .activity-row, body[data-report-page="person"] .activity-row { grid-template-columns: 1fr; }
body[data-report-page="people"] .month-label, body[data-report-page="person"] .month-label { padding-top: 0; }
body[data-report-page="people"] .archive-panel, body[data-report-page="person"] .archive-panel { padding: 16px; }
body[data-report-page="people"] .calendar, body[data-report-page="person"] .calendar { width: 100%; }
body[data-report-page="people"] .day-cell, body[data-report-page="person"] .day-cell { font-size: 10px; }
body[data-report-page="people"] .person-activity-legend, body[data-report-page="person"] .person-activity-legend { justify-content: flex-start; }
body[data-report-page="people"] .person-activity-svg, body[data-report-page="person"] .person-activity-svg { height: auto; aspect-ratio: 8 / 3; }
body[data-report-page="people"] .person-activity-axis-tick, body[data-report-page="person"] .person-activity-axis-tick { font-size: 24px; }
body[data-report-page="people"] .person-activity-axis-title, body[data-report-page="person"] .person-activity-axis-title { display: none; }
}
@media print {
body[data-report-page="people"] .person-activity-chart, body[data-report-page="person"] .person-activity-chart { break-inside: avoid; }
body[data-report-page="people"] .person-activity-svg, body[data-report-page="person"] .person-activity-svg { height: 300px; }
body[data-report-page="people"] .person-activity-values, body[data-report-page="person"] .person-activity-values { break-inside: avoid; }
}


body[data-report-page="home"] .home-grid > .quick-card { box-shadow: none; }
body[data-report-page="home"] .home-card h2 { margin: 4px 0 0; font-size: 18px; }
body[data-report-page="home"] .home-card > p:not(.oc-eyebrow) { color: var(--oc-text-muted); font-size: 13px; line-height: 1.45; }
body[data-report-page="home"] .home-card > .panel-link { align-self: flex-start; }
body[data-report-page="home"] .home-grid .oc-summary-metric { min-width: 0; }
body[data-report-page="home"] .home-grid .oc-summary-metric + .oc-summary-metric { padding-left: var(--oc-space-3); border-left: 1px solid var(--oc-border-subtle); }
body[data-report-page="home"] .home-grid .oc-summary-metric-copy { gap: var(--oc-space-1); }
body[data-report-page="home"] .home-grid .oc-summary-metric-copy small { overflow: visible; white-space: normal; }
body[data-report-page="report"] .distribution-track { width: 100%; }
body[data-report-page="report"] .distribution-segment { fill: var(--oc-chart-color, var(--oc-accent-primary)); }
body[data-report-page="report"] header .oc-summary-metric { max-width: 27rem; }
body[data-report-page="report"] header .oc-summary-metric-copy small { white-space: normal; }
body[data-report-page="report"] .oc-banner-title { font-size: inherit; line-height: inherit; font-weight: 650; }
body[data-report-page="report"] main > .oc-banner { margin-block: var(--oc-space-3); }
body[data-report-page="report"] main > .oc-summary-strip { margin-top: var(--oc-space-5); }
body[data-report-page="report"] .alias-line, body[data-report-page="report"] .theme-kind { color: var(--oc-text-muted); font-size: var(--oc-font-size-xs); }
body[data-report-page="report"] .person-body details { min-width: 0; }
body[data-report-page="people"] .people-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; margin: -4px 0 18px; padding: 10px 12px; }
body[data-report-page="people"] .source-key { display: inline-flex; align-items: center; gap: 12px; margin-left: auto; color: var(--oc-text-muted); font-size: 12px; }
body[data-report-page="people"] .source-key span { display: inline-flex; align-items: center; gap: 5px; }
body[data-report-page="people"] .source-swatch { width: 10px; height: 10px; border-radius: 3px; border: 1px solid var(--oc-border-strong); }
body[data-report-page="people"] .source-swatch.github { background: var(--oc-status-success-fg); }
body[data-report-page="people"] .source-swatch.discord { background: var(--oc-status-info-fg); }
body[data-report-page="people"] .people-break.is-archived { margin-top: 18px; }
body[data-report-page="people"] .person-card.is-archived { border-style: dashed; opacity: .82; }
body[data-report-page="people"] .person-card-head .oc-avatar { width: 36px; height: 36px; }
body[data-report-page="people"] .person-card-days { flex-basis: 100%; }
body[data-report-page="people"] .person-card:hover { text-decoration: none; }
body[data-report-page="person"] .person-hero .oc-avatar { width: 72px; height: 72px; }
body[data-report-page="person"] .person-lifecycle, body[data-report-page="person"] .person-lifecycle-line { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; min-width: 0; color: var(--oc-status-warning-fg); font-size: 12px; font-weight: 800; line-height: 1.35; }
body[data-report-page="person"] .oc-summary-strip { margin-block: var(--oc-space-4) var(--oc-space-7); }
@media (max-width: 760px) {
  body[data-report-page="people"] .people-toolbar { align-items: flex-start; flex-direction: column; }
  body[data-report-page="people"] .source-key { margin-left: 0; }
}


`;
