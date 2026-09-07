/*
 * Vendored Carapace v0.6.2 subset: styles/tokens.css, styles/themes.css,
 * styles/themes/product.css, styles/typography.css, styles/components.css,
 * and styles/candidate/{data,feedback,embed}.css. Theme values include the
 * neutral application overrides. Use embed font stacks and the skill's square
 * surface/control/inset geometry; no external CSS or fonts under the nonce CSP.
 */
const LIGHT_THEME = `
  color-scheme: light;
  --oc-bg-page: oklch(0.985 0 0);
  --oc-bg-surface: oklch(0.97 0 0);
  --oc-bg-elevated: oklch(1 0 0);
  --oc-text-primary: oklch(0.205 0 0);
  --oc-text-secondary: oklch(0.269 0 0);
  --oc-text-muted: oklch(0.555 0 0);
  --oc-text-link: var(--oc-accent-primary);
  --oc-accent-primary: color-mix(in srgb, #c24028 60%, #9c3222 40%);
  --oc-accent-primary-hover: color-mix(in srgb, #c24028 30%, #9c3222 70%);
  --oc-accent-secondary: #14806e;
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
  --oc-text-primary: oklch(0.985 0 0);
  --oc-text-secondary: oklch(0.87 0 0);
  --oc-text-muted: oklch(0.716 0 0);
  --oc-text-link: var(--oc-accent-primary);
  --oc-accent-primary: #f5654a;
  --oc-accent-primary-hover: #e05540;
  --oc-accent-secondary: #4fc8ae;
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
  --oc-radius-surface: 0;
  --oc-radius-control: 0;
  --oc-radius-inset: 0;
  --oc-radius-round: 999px;
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

* { box-sizing: border-box; }
body { margin: 0; font: var(--oc-font-size-base)/1.6 var(--oc-font-body); }
::selection { background: var(--oc-selection-bg); }
a { color: var(--oc-text-link); overflow-wrap: anywhere; }
a:hover { color: var(--oc-accent-primary-hover); }
:where(a, summary, [tabindex]):focus-visible { outline: 2px solid var(--oc-focus-ring); outline-offset: 3px; }
h1, h2, h3, p { margin: 0; }
h3 { font-size: var(--oc-font-size-md); line-height: 1.4; }
p + p { margin-top: var(--oc-space-2); }
ul { padding-left: var(--oc-space-5); }
li { overflow-wrap: anywhere; }
small, .muted { color: var(--oc-text-muted); }
.details { color: var(--oc-text-secondary); font-size: var(--oc-font-size-sm); }
.oc-app-surface { min-width: 0; min-height: 100%; background: var(--oc-bg-page); color: var(--oc-text-primary); font-family: var(--oc-font-body); }
.report-toolbar { border-bottom: 1px solid var(--oc-border-subtle); background: var(--oc-bg-surface); }
.report-toolbar-inner, main, footer { max-width: 75rem; margin: auto; padding: var(--oc-space-5) var(--oc-space-6); }
.report-toolbar-inner { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--oc-space-2); padding-block: var(--oc-space-2); }
nav, .actions, .identity-line, .pills { display: flex; flex-wrap: wrap; align-items: center; gap: var(--oc-space-2); }
.brand { margin-right: var(--oc-space-4); color: var(--oc-text-primary); font-weight: 750; text-decoration: none; }
main { display: grid; gap: var(--oc-space-6); overflow-wrap: anywhere; }
footer { color: var(--oc-text-muted); font-size: var(--oc-font-size-xs); border-top: 1px solid var(--oc-border-subtle); }
.oc-section { width: 100%; min-width: 0; color: var(--oc-text-primary); }
.oc-section-header { display: flex; align-items: end; justify-content: space-between; gap: var(--oc-space-5); margin-bottom: var(--oc-space-4); }
.oc-section-header > * { min-width: 0; }
.oc-section-heading { display: grid; gap: var(--oc-space-2); }
.oc-eyebrow { color: var(--oc-accent-primary); font: 700 var(--oc-font-size-xs)/1.4 var(--oc-font-mono); text-transform: uppercase; }
.oc-section-title { color: var(--oc-text-primary); font-family: var(--oc-font-display); font-size: var(--oc-font-size-2xl); font-weight: 750; line-height: 1.2; overflow-wrap: anywhere; }
h2.oc-section-title { font-size: var(--oc-font-size-lg); }
.oc-section-copy { max-width: 60ch; color: var(--oc-text-secondary); overflow-wrap: anywhere; }
.oc-card { padding: var(--oc-space-4); border: 1px solid var(--oc-border-subtle); border-radius: var(--oc-radius-surface); background: var(--oc-surface-card); color: var(--oc-text-primary); }
.stats, .history-columns { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--oc-space-3); }
.stat-heading { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--oc-space-2); margin-bottom: var(--oc-space-2); }
.stat-value { display: block; font-size: var(--oc-font-size-2xl); font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.4; }
.stat-date { font: 650 var(--oc-font-size-xl)/1.5 var(--oc-font-mono); }
.oc-action { display: inline-flex; min-height: 2.5rem; align-items: center; justify-content: center; gap: var(--oc-space-2); padding: var(--oc-space-2) var(--oc-space-3); border: 1px solid transparent; border-radius: var(--oc-radius-control); font-size: var(--oc-font-size-base); font-weight: 650; line-height: 1.2; text-decoration: none; touch-action: manipulation; }
.oc-action-ghost { background: transparent; color: var(--oc-text-secondary); }
.oc-action-ghost:hover { background: var(--oc-surface-interactive-hover); color: var(--oc-text-primary); }
.oc-pill { display: inline-flex; max-width: 100%; min-width: 0; min-height: 1.75rem; align-items: center; padding: var(--oc-space-1) var(--oc-space-3); border: 1px solid var(--oc-border-subtle); border-radius: var(--oc-radius-control); background: var(--oc-surface-card); color: var(--oc-text-secondary); font-size: var(--oc-font-size-xs); font-weight: 650; line-height: 1.2; overflow-wrap: anywhere; }
.oc-badge { display: inline-flex; max-width: 100%; min-width: 0; min-height: 1.5rem; align-items: center; gap: var(--oc-space-2); padding: var(--oc-space-1) var(--oc-space-2); border: 1px solid var(--oc-border-subtle); border-radius: var(--oc-radius-control); color: var(--oc-text-secondary); background: var(--oc-bg-elevated); font-size: var(--oc-font-size-xs); font-weight: 650; line-height: 1; white-space: nowrap; vertical-align: middle; }
.oc-badge::before { width: 0.375rem; height: 0.375rem; flex: 0 0 auto; border-radius: var(--oc-radius-round); background: currentColor; content: ""; }
.oc-badge-neutral::before { display: none; }
.oc-badge-success { border-color: var(--oc-status-success-fg); background: var(--oc-status-success-bg); color: var(--oc-status-success-fg); }
.oc-badge-warning { border-color: var(--oc-status-warning-fg); background: var(--oc-status-warning-bg); color: var(--oc-status-warning-fg); }
.notices { display: grid; gap: var(--oc-space-3); }
.oc-banner { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: var(--oc-space-3); padding: var(--oc-space-4); border: 1px solid var(--oc-border-subtle); border-radius: var(--oc-radius-surface); background: var(--oc-surface-card-strong); color: var(--oc-text-secondary); font-size: var(--oc-font-size-sm); line-height: 1.45; }
.oc-banner-indicator { width: 0.375rem; height: 0.375rem; margin-top: 0.45em; border-radius: var(--oc-radius-round); background: var(--oc-text-muted); }
.oc-banner-warning .oc-banner-indicator { background: var(--oc-status-warning-fg); }
.oc-banner-info .oc-banner-indicator { background: var(--oc-status-info-fg); }
.oc-banner-content { display: grid; min-width: 0; gap: var(--oc-space-1); overflow-wrap: anywhere; }
.oc-banner-title { color: var(--oc-text-primary); font-size: inherit; font-weight: 650; }
.oc-banner ul { margin: 0; }
.oc-table-wrap { width: 100%; overflow-x: auto; border: 1px solid var(--oc-border-subtle); border-radius: var(--oc-radius-surface); overscroll-behavior-inline: contain; scrollbar-gutter: stable; }
.oc-table { width: 100%; min-width: 36rem; border-collapse: collapse; background: var(--oc-surface-card); color: var(--oc-text-secondary); font-size: var(--oc-font-size-sm); }
.oc-table :is(th, td) { padding: var(--oc-space-3) var(--oc-space-4); border-bottom: 1px solid var(--oc-border-subtle); text-align: left; }
.oc-table th { color: var(--oc-text-muted); font-family: var(--oc-font-mono); font-size: var(--oc-font-size-xs); font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
.oc-table tbody tr:last-child td { border-bottom: 0; }
.oc-table tbody tr:focus-within, .oc-table tbody tr:hover { background: var(--oc-surface-interactive); }
.oc-table td:first-child { color: var(--oc-text-primary); font-weight: 650; }
.oc-table .number { text-align: right; font-variant-numeric: tabular-nums; }
.oc-resource-list { width: 100%; margin: 0; padding: 0; overflow: hidden; border: 1px solid var(--oc-border-subtle); border-radius: var(--oc-radius-surface); background: var(--oc-surface-card); list-style: none; }
.oc-resource-list-item { margin: 0; }
.oc-resource-list-item + .oc-resource-list-item { border-top: 1px solid var(--oc-border-subtle); }
.oc-resource-list-link, .resource-row { display: flex; align-items: center; justify-content: space-between; gap: var(--oc-space-3); padding: var(--oc-space-2) var(--oc-space-3); }
.oc-resource-list-link { color: inherit; text-decoration: none; }
.oc-resource-list-link:hover { background: var(--oc-surface-interactive); color: var(--oc-text-primary); }
.oc-resource-list-link:focus-visible { outline-offset: -2px; }
.oc-resource-list-title { color: var(--oc-text-primary); font-size: var(--oc-font-size-sm); overflow-wrap: anywhere; }
.oc-resource-list-meta { color: var(--oc-text-muted); font-size: var(--oc-font-size-sm); }
.history-columns h3 { margin-bottom: var(--oc-space-3); }
.member-list { margin: 0; padding: 0; list-style: none; }
.member { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--oc-space-3); padding: var(--oc-space-4) 0; border-top: 1px solid var(--oc-border-subtle); }
.member-content { display: grid; gap: var(--oc-space-2); min-width: 0; overflow-wrap: anywhere; }
.member-content p { margin: 0; }
.member-items .resource-row { display: block; }
summary { width: fit-content; max-width: 100%; color: var(--oc-text-secondary); cursor: pointer; font-size: var(--oc-font-size-sm); }
details[open] > summary { margin-bottom: var(--oc-space-2); }
blockquote { border-left: 2px solid var(--oc-border-strong); padding: var(--oc-space-2) var(--oc-space-4); margin: var(--oc-space-2) 0; overflow-wrap: anywhere; }
.person-identity { display: flex; align-items: center; gap: var(--oc-space-3); min-width: 0; }
.person-heading { display: grid; gap: var(--oc-space-2); min-width: 0; }
.oc-avatar { position: relative; display: inline-grid; flex: 0 0 auto; place-items: center; overflow: hidden; border-radius: var(--oc-radius-round); background: var(--oc-surface-secondary-soft); color: var(--oc-accent-secondary); font-weight: 650; line-height: 1; }
.oc-avatar::before { content: attr(data-initials); }
/* Transparent failed images leave the CSS initials beneath them visible. */
.oc-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; color: transparent; font-size: 0; }
.oc-avatar-xs { width: 20px; height: 20px; font-size: var(--oc-font-size-xs); }
.oc-avatar-md { width: 40px; height: 40px; font-size: var(--oc-font-size-sm); }
.oc-avatar-xl { width: 72px; height: 72px; font-size: var(--oc-font-size-2xl); }
.chart { padding-block: var(--oc-space-3); border-block: 1px solid var(--oc-border-subtle); }
.chart .oc-sparkline { display: block; width: 100%; height: auto; }
.oc-sparkline-line { fill: none; stroke-width: 1.5; stroke-linecap: butt; stroke-linejoin: miter; vector-effect: non-scaling-stroke; }
.github-line { stroke: var(--oc-accent-primary); }
.discord-line { stroke: var(--oc-accent-secondary); }
.chart-axis { stroke: var(--oc-chart-line); stroke-width: 1; }
.chart-label { fill: var(--oc-text-muted); font: var(--oc-font-size-xs) var(--oc-font-mono); }
.legend { display: flex; flex-wrap: wrap; gap: var(--oc-space-4); font-size: var(--oc-font-size-xs); }
.github-key { color: var(--oc-accent-primary); background: var(--oc-surface-accent-soft); }
.discord-key { color: var(--oc-accent-secondary); background: var(--oc-surface-secondary-soft); }
.legend span { padding-inline: var(--oc-space-2); border-radius: var(--oc-radius-inset); }
.prose { overflow-wrap: anywhere; }
.prose h3 { margin-top: var(--oc-space-4); }
.prose .notices { margin-bottom: var(--oc-space-3); }
@media (max-width: 42rem) {
  .report-toolbar-inner, main, footer { padding-inline: var(--oc-space-4); }
  .report-toolbar-inner, .oc-section-header { align-items: start; flex-direction: column; }
  .stats, .history-columns { grid-template-columns: 1fr; }
  .oc-section-header { gap: var(--oc-space-3); }
  .brand { width: 100%; }
  .report-toolbar nav { gap: var(--oc-space-1); }
  .report-toolbar .oc-action { padding-inline: var(--oc-space-2); }
}
`;
