// Control UI tool icon set, split from icons.ts to keep both under the max-lines cap.
import { html, svg, type SVGTemplateResult, type TemplateResult } from "lit";

// Shared Lucide icon shell. Inline presentation attributes keep icons visible
// inside shadow roots that global stylesheet icon rules cannot reach; CSS
// rules still override them where a surface wants a different stroke width.
// Bodies must be svg`` fragments: html`` would parse the shapes outside the
// SVG namespace and they would silently render as nothing.
export function strokeIcon(body: SVGTemplateResult): TemplateResult {
  return html`
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      ${body}
    </svg>
  `;
}

export const toolIcons = {
  shieldCheck: strokeIcon(
    svg`<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3zM9 12l2 2 4-4" />`,
  ),
  shieldX: strokeIcon(
    svg`<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3zM9.5 9.5l5 5m0-5-5 5" />`,
  ),
  cpu: strokeIcon(svg` <rect width="16" height="16" x="4" y="4" rx="2" />
    <rect width="6" height="6" x="9" y="9" rx="1" />
    <path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" />`),
  foldVertical: strokeIcon(
    svg`<path d="M12 22v-6M12 8V2M4 12H2M10 12H8M16 12h-2M22 12h-2M19 9l-3 3 3 3M5 15l3-3-3-3" />`,
  ),
  wrench: strokeIcon(svg` <path
    d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
  />`),
  fileCode: strokeIcon(svg` <path
      d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"
    />
    <polyline points="14 2 14 8 20 8" />
    <path d="M10 13l-2 2 2 2M14 17l2-2-2-2" />`),
  edit: strokeIcon(
    svg`<path
      d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"
    />`,
  ),
  home: strokeIcon(svg` <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <polyline points="9 22 9 12 15 12 15 22" />`),
  penLine: strokeIcon(
    svg`<path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />`,
  ),
  paperclip: strokeIcon(svg` <path
    d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"
  />`),
  globe: strokeIcon(svg` <circle cx="12" cy="12" r="10" />
    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
    <path d="M2 12h20" />`),
  image: strokeIcon(svg` <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />`),
  copyImage: strokeIcon(svg` <rect width="14" height="14" x="8" y="8" rx="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    <circle cx="13" cy="13" r="1" />
    <path d="m21 18-3-3-5 5" />`),
  camera: strokeIcon(svg` <path
      d="M14.5 4 16 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3l1.5-3z"
    />
    <circle cx="12" cy="13" r="3" />`),
  cameraOff: strokeIcon(
    svg`<path
      d="M14.564 14.558a3 3 0 1 1-4.122-4.121M2 2l20 20M20 20H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 .819-.175M9.695 4.024A2 2 0 0 1 10.004 4h3.993a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v7.344"
    />`,
  ),
  smartphone: strokeIcon(svg` <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
    <path d="M12 18h.01" />`),
  circleQuestionMark: strokeIcon(svg` <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" />`),
  plug: strokeIcon(
    svg`<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />`,
  ),
  circle: strokeIcon(svg`<circle cx="12" cy="12" r="10" />`),
  puzzle: strokeIcon(svg` <path
    d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.076.874.54 1.02 1.02a2.5 2.5 0 1 0 3.237-3.237c-.48-.146-.944-.505-1.02-1.02a.98.98 0 0 1 .303-.917l1.526-1.526A2.402 2.402 0 0 1 11.998 2c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.236 3.236c-.464.18-.894.527-.967 1.02Z"
  />`),
  panelLeft: strokeIcon(svg` <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 3v18" />`),
  panelLeftClose: strokeIcon(svg` <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 3v18M16 10l-3 2 3 2" />`),
  panelLeftOpen: strokeIcon(svg` <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 3v18M14 10l3 2-3 2" />`),
  chevronDown: strokeIcon(svg`<path d="M6 9l6 6 6-6" />`),
  chevronRight: strokeIcon(svg`<path d="M9 18l6-6-6-6" />`),
  chevronLeft: strokeIcon(svg`<path d="M15 18l-6-6 6-6" />`),
  externalLink: strokeIcon(
    svg`<path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />`,
  ),
  send: strokeIcon(svg`<path d="m22 2-7 20-4-9-9-4ZM22 2 11 13" />`),
  forward: strokeIcon(svg`<path d="m15 17 5-5-5-5M4 18v-2a4 4 0 0 1 4-4h12" />`),
  stop: strokeIcon(svg`<rect width="14" height="14" x="5" y="5" rx="1" />`),
  pin: strokeIcon(svg` <line x1="12" x2="12" y1="17" y2="22" />
    <path
      d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"
    />`),
  pinOff: strokeIcon(svg` <line x1="2" x2="22" y1="2" y2="22" />
    <line x1="12" x2="12" y1="17" y2="22" />
    <path
      d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0-.39.04"
    />`),
  download: strokeIcon(svg` <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" x2="12" y1="15" y2="3" />`),
  mic: strokeIcon(
    svg`<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />`,
  ),
  volume2: strokeIcon(svg` <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" />`),
  volumeX: strokeIcon(svg` <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="m22 9-6 6" />
    <path d="m16 9 6 6" />`),
  bookmark: strokeIcon(svg`<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />`),
  plus: strokeIcon(svg`<path d="M5 12h14M12 5v14" />`),
  gitBranch: strokeIcon(svg` <circle cx="6" cy="5" r="2" />
    <circle cx="18" cy="6" r="2" />
    <circle cx="6" cy="19" r="2" />
    <path d="M6 7v10M8 9h5a5 5 0 0 0 5-5" />`),
  gitFork: strokeIcon(svg` <circle cx="6" cy="6" r="3" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="12" cy="18" r="3" />
    <path d="M6 9a6 6 0 0 0 6 6M18 9a6 6 0 0 1-6 6" />`),
  gitPullRequest: strokeIcon(svg` <circle cx="6" cy="6" r="3" />
    <circle cx="18" cy="18" r="3" />
    <path d="M13 6h3a2 2 0 0 1 2 2v7M6 9v12" />`),
  gitPullRequestDraft: strokeIcon(svg` <circle cx="6" cy="6" r="3" />
    <circle cx="18" cy="18" r="3" />
    <path d="M6 9v12" />
    <path d="M18 6v.01" />
    <path d="M18 11v.01" />`),
  gitPullRequestClosed: strokeIcon(svg` <circle cx="6" cy="6" r="3" />
    <path d="M6 9v12" />
    <path d="m15 9 6 6" />
    <path d="m21 9-6 6" />`),
  gitMerge: strokeIcon(svg` <circle cx="6" cy="6" r="3" />
    <circle cx="18" cy="18" r="3" />
    <path d="M6 21V9a9 9 0 0 0 9 9" />`),
  terminal: strokeIcon(svg` <polyline points="4 17 10 11 4 5" />
    <line x1="12" x2="20" y1="19" y2="19" />`),
  squareTerminal: strokeIcon(svg` <path d="m7 11 2-2-2-2M11 13h4" />
    <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />`),
  listTree: strokeIcon(
    svg`<path d="M21 12h-8M21 6H8M21 18h-8M3 6v4c0 1.1.9 2 2 2h3M3 10v6c0 1.1.9 2 2 2h3" />`,
  ),
  claw: strokeIcon(svg` <path
      d="M8.2 10 A5.2 5.2 0 1 0 8.2 20.4 A5.2 5.2 0 0 0 8.2 10 Z M10.2 20 C14.5 20.8 19 18.6 22.3 13.2 C21 12.9 19.7 12.7 18.4 12.8 L17.5 14.6 L16 12.9 L14.3 14.5 L13.5 13 L11.5 14.2 Z"
    />
    <path
      class="claw-icon__jaw"
      d="M5.6 12.2 C5.2 5.6 10.4 1.4 15.6 2 C19.4 2.6 21.8 5.2 22.6 8.2 C20.9 7.7 19.2 7.6 17.6 7.9 L16.9 6.3 L15.2 8.5 C13.6 9.4 12.2 10.9 11.6 12.4 L6.8 13 Z"
    />`),
  spark: strokeIcon(svg` <path
    d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"
  />`),
  lobster: html`
    <svg viewBox="0 0 120 120" fill="none">
      <defs>
        <!-- Gradient stops read theme tokens (base.css --lobster-icon-*): the
             shipped hex pair sank into dark backgrounds, so dark mode brightens
             both stops while light mode keeps the original artwork. var() is
             only valid in style="", not presentation attributes. -->
        <linearGradient id="lob-g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color: var(--lobster-icon-body, #ff4d4d)" />
          <stop offset="100%" style="stop-color: var(--lobster-icon-shade, #991b1b)" />
        </linearGradient>
      </defs>
      <path
        d="M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110L55 110L55 100C55 100 60 102 65 100L65 110L75 110L75 100C90 95 105 75 105 55C105 35 90 10 60 10Z"
        fill="url(#lob-g)"
      />
      <path d="M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z" fill="url(#lob-g)" />
      <path
        d="M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z"
        fill="url(#lob-g)"
      />
      <path
        d="M45 15Q35 5 30 8"
        style="stroke: var(--lobster-icon-body, #ff4d4d)"
        stroke-width="3"
        stroke-linecap="round"
      />
      <path
        d="M75 15Q85 5 90 8"
        style="stroke: var(--lobster-icon-body, #ff4d4d)"
        stroke-width="3"
        stroke-linecap="round"
      />
      <circle cx="45" cy="35" r="6" style="fill: var(--lobster-icon-eye, #050810)" />
      <circle cx="75" cy="35" r="6" style="fill: var(--lobster-icon-eye, #050810)" />
      <circle cx="46" cy="34" r="2.5" fill="#00e5cc" />
      <circle cx="76" cy="34" r="2.5" fill="#00e5cc" />
    </svg>
  `,
  circleUser: strokeIcon(svg` <path d="M18 20a6 6 0 0 0-12 0" />
    <circle cx="12" cy="10" r="4" />
    <circle cx="12" cy="12" r="10" />`),
  bell: strokeIcon(
    svg`<path
      d="M10.268 21a2 2 0 0 0 3.464 0M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"
    />`,
  ),
  palette: strokeIcon(svg` <path
      d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"
    />
    <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
    <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
    <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
    <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />`),
  flaskConical: strokeIcon(
    svg`<path
      d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2M6.453 15h11.094M8.5 2h7"
    />`,
  ),
  badgeCheck: strokeIcon(svg` <path
      d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"
    />
    <path d="m9 12 2 2 4-4" />`),
  refresh: strokeIcon(
    svg`<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5" />`,
  ),
  rotateCcw: strokeIcon(
    svg`<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5" />`,
  ),
  trash: strokeIcon(
    svg`<path
      d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6"
    />`,
  ),
  eye: strokeIcon(svg` <path
      d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
    />
    <circle cx="12" cy="12" r="3" />`),
  eyeOff: strokeIcon(
    svg`<path
      d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49M14.084 14.158a3 3 0 0 1-4.242-4.242M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143M2 2l20 20"
    />`,
  ),
  arrowUpDown: strokeIcon(svg`<path d="M21 16l-4 4-4-4M17 20V4M3 8l4-4 4 4M7 4v16" />`),
  panelRightOpen: strokeIcon(svg` <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M15 3v18M10 10l-3 2 3 2" />`),
  panelRightClose: strokeIcon(svg` <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M15 3v18M8 10l3 2-3 2" />`),
  columns2: strokeIcon(svg` <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M12 3v18" />`),
  panelBottomOpen: strokeIcon(svg` <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 15h18M10 8l2 3 2-3" />`),
  panelBottomClose: strokeIcon(svg` <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 15h18M10 11l2-3 2 3" />`),
  maximize: strokeIcon(svg` <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" x2="14" y1="3" y2="10" />
    <line x1="3" x2="10" y1="21" y2="14" />`),
  minimize: strokeIcon(svg` <polyline points="4 14 10 14 10 20" />
    <polyline points="20 10 14 10 14 4" />
    <line x1="14" x2="21" y1="10" y2="3" />
    <line x1="3" x2="10" y1="21" y2="14" />`),
} as const;
