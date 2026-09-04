import { html, svg, type SVGTemplateResult } from "lit";
function strokeIcon(body: SVGTemplateResult) {
  return html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    ${body}
  </svg>`;
}
export const icons = {
  alertTriangle: strokeIcon(svg` <path
      d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"
    />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />`),
  archive: strokeIcon(svg` <rect width="20" height="5" x="2" y="3" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />`),
  archiveRestore: strokeIcon(svg` <rect width="20" height="5" x="2" y="3" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="m9 15 3-3 3 3" />
    <path d="M12 12v6" />`),
  bot: strokeIcon(svg` <path d="M12 8V4H8" />
    <rect width="16" height="12" x="4" y="8" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M15 13v2" />
    <path d="M9 13v2" />`),
  calendarClock: strokeIcon(svg` <path
      d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"
    />
    <path d="M16 2v4" />
    <path d="M8 2v4" />
    <path d="M3 10h5" />
    <path d="M17.5 17.5 16 16.3V14" />
    <circle cx="16" cy="16" r="6" />`),
  clock: strokeIcon(svg` <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />`),
  cornerDownRight: strokeIcon(svg` <polyline points="15 10 20 15 15 20" />
    <path d="M4 4v7a4 4 0 0 0 4 4h12" />`),
  edit: strokeIcon(
    svg`<path
      d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"
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
  kanban: strokeIcon(svg` <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M8 7v7" />
    <path d="M12 7v4" />
    <path d="M16 7v9" />`),
  layoutComfortable: strokeIcon(svg` <rect width="16" height="5" x="4" y="4" rx="1.5" />
    <rect width="16" height="5" x="4" y="15" rx="1.5" />
    <line x1="7" x2="16" y1="7" y2="7" />
    <line x1="7" x2="16" y1="18" y2="18" />`),
  layoutCompact: strokeIcon(svg` <rect width="16" height="3" x="4" y="4" rx="1" />
    <rect width="16" height="3" x="4" y="9" rx="1" />
    <rect width="16" height="3" x="4" y="14" rx="1" />
    <rect width="16" height="3" x="4" y="19" rx="1" />`),
  messageSquare: strokeIcon(svg` <path
    d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
  />`),
  panelBottomClose: strokeIcon(svg` <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 15h18M10 11l2-3 2 3" />`),
  panelBottomOpen: strokeIcon(svg` <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 15h18M10 8l2 3 2-3" />`),
  panelRightClose: strokeIcon(svg` <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M15 3v18M8 10l3 2-3 2" />`),
  panelRightOpen: strokeIcon(svg` <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M15 3v18M10 10l-3 2 3 2" />`),
  penLine: strokeIcon(
    svg`<path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />`,
  ),
  play: strokeIcon(svg`<polygon points="6 3 20 12 6 21 6 3" />`),
  plus: strokeIcon(svg`<path d="M5 12h14M12 5v14" />`),
  stop: strokeIcon(svg`<rect width="14" height="14" x="5" y="5" rx="1" />`),
  trash: strokeIcon(
    svg`<path
      d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6"
    />`,
  ),
  users: strokeIcon(svg` <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />`),
  x: strokeIcon(svg` <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />`),
  zap: strokeIcon(svg`<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />`),
};
