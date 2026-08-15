// Control UI module implements icons behavior.
import { svg, type TemplateResult } from "lit";
import { strokeIcon, toolIcons } from "./icons-tools.ts";

// Lucide-style SVG icons rendered through the shared strokeIcon() shell,
// which carries the stroke presentation attributes inline (see icons-tools.ts).

export const icons = {
  // Navigation icons
  messageSquare: strokeIcon(svg` <path
    d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
  />`),
  layoutGrid: strokeIcon(svg` <rect width="7" height="7" x="3" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="14" rx="1" />
    <rect width="7" height="7" x="3" y="14" rx="1" />`),
  barChart: strokeIcon(svg` <line x1="12" x2="12" y1="20" y2="10" />
    <line x1="18" x2="18" y1="20" y2="4" />
    <line x1="6" x2="6" y1="20" y2="16" />`),
  layoutDashboard: strokeIcon(svg` <rect width="7" height="9" x="3" y="3" rx="1" />
    <rect width="7" height="5" x="14" y="3" rx="1" />
    <rect width="7" height="9" x="14" y="12" rx="1" />
    <rect width="7" height="5" x="3" y="16" rx="1" />`),
  coins: strokeIcon(svg` <circle cx="8" cy="8" r="6" />
    <path d="M18.09 10.37A6 6 0 1 1 10.34 18" />
    <path d="M7 6h1v4" />
    <path d="m16.71 13.88.7.71-2.82 2.82" />`),
  activity: strokeIcon(svg` <path d="M22 12h-4l-3 9L9 3l-3 9H2" />`),
  clock: strokeIcon(svg` <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />`),
  link: strokeIcon(svg` <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />`),
  radio: strokeIcon(svg` <circle cx="12" cy="12" r="2" />
    <path
      d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"
    />`),
  fileText: strokeIcon(svg` <path
      d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"
    />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" x2="8" y1="13" y2="13" />
    <line x1="16" x2="8" y1="17" y2="17" />
    <line x1="10" x2="8" y1="9" y2="9" />`),
  file: strokeIcon(svg` <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />`),
  // Lucide file-diff. The outline keeps the cut corner but drops the fold line
  // the other file glyphs draw: at the header's 18px the fold collides with the
  // plus stroke and both marks turn to mush, and the missing fold is also what
  // separates this silhouette from fileText beside it in the same action row.
  fileDiff: strokeIcon(svg` <path
      d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.7.71l3.59 3.58A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"
    />
    <path d="M9 10h6" />
    <path d="M12 13V7" />
    <path d="M9 17h6" />`),
  diff: strokeIcon(svg` <path d="M12 3v14" />
    <path d="M5 10h14" />
    <path d="M5 21h14" />`),
  braces: strokeIcon(svg` <path
      d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"
    />
    <path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />`),
  mail: strokeIcon(svg` <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
    <polyline points="22,6 12,13 2,6" />`),
  star: strokeIcon(
    svg`<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />`,
  ),
  wandSparkles: strokeIcon(svg` <path d="M15 4V2" />
    <path d="M15 16v-2" />
    <path d="M8 9h2" />
    <path d="M20 9h2" />
    <path d="M17.8 11.8 19 13" />
    <path d="M15 9h0" />
    <path d="M17.8 6.2 19 5" />
    <path d="m3 21 9-9" />
    <path d="M12.2 6.2 11 5" />`),
  chrome: strokeIcon(svg` <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="4" />
    <line x1="21.17" y1="8" x2="12" y2="8" />
    <line x1="3.95" y1="6.06" x2="8.54" y2="14" />
    <line x1="10.88" y1="21.94" x2="15.46" y2="14" />`),
  panelsTopLeft: strokeIcon(svg` <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <line x1="3" y1="9" x2="21" y2="9" />
    <line x1="9" y1="21" x2="9" y2="9" />`),
  box: strokeIcon(svg` <path
      d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"
    />
    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
    <line x1="12" y1="22.08" x2="12" y2="12" />`),
  music: strokeIcon(svg` <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />`),
  asterisk: strokeIcon(svg` <path d="M12 2v6" />
    <path d="m4.93 10.93 4.24 4.24" />
    <path d="M2 12h6" />
    <path d="m4.93 13.07 4.24-4.24" />
    <path d="M12 22v-6" />
    <path d="m19.07 13.07-4.24-4.24" />
    <path d="M22 12h-6" />
    <path d="m19.07 10.93-4.24 4.24" />`),
  zap: strokeIcon(svg`<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />`),
  monitor: strokeIcon(svg` <rect width="20" height="14" x="2" y="3" rx="2" />
    <line x1="8" x2="16" y1="21" y2="21" />
    <line x1="12" x2="12" y1="17" y2="21" />`),
  monitorSmartphone: strokeIcon(svg` <path
      d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8"
    />
    <path d="M10 19v-3.96 3.15" />
    <path d="M7 19h5" />
    <rect width="6" height="10" x="16" y="12" rx="2" />`),
  server: strokeIcon(svg` <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
    <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
    <line x1="6" x2="6.01" y1="6" y2="6" />
    <line x1="6" x2="6.01" y1="18" y2="18" />`),
  sun: strokeIcon(svg` <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />`),
  moon: strokeIcon(svg` <path d="M12 3a6.5 6.5 0 0 0 9 9 9 9 0 1 1-9-9Z" />`),
  settings: strokeIcon(svg` <path
      d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
    />
    <circle cx="12" cy="12" r="3" />`),
  bug: strokeIcon(svg` <path d="m8 2 1.88 1.88" />
    <path d="M14.12 3.88 16 2" />
    <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
    <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
    <path d="M12 20v-9" />
    <path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
    <path d="M6 13H2" />
    <path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
    <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" />
    <path d="M22 13h-4" />
    <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />`),
  scrollText: strokeIcon(svg` <path
      d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4"
    />
    <path d="M19 17V5a2 2 0 0 0-2-2H4" />
    <path d="M15 8h-5" />
    <path d="M15 12h-5" />`),
  folder: strokeIcon(svg` <path
    d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
  />`),
  kanban: strokeIcon(svg` <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M8 7v7" />
    <path d="M12 7v4" />
    <path d="M16 7v9" />`),
  bot: strokeIcon(svg` <path d="M12 8V4H8" />
    <rect width="16" height="12" x="4" y="8" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M15 13v2" />
    <path d="M9 13v2" />`),
  users: strokeIcon(svg` <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />`),
  shieldCheck: strokeIcon(svg` <path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z" />
    <path d="m9 12 2 2 4-4" />`),

  // UI icons
  menu: strokeIcon(svg` <line x1="4" x2="20" y1="12" y2="12" />
    <line x1="4" x2="20" y1="6" y2="6" />
    <line x1="4" x2="20" y1="18" y2="18" />`),
  x: strokeIcon(svg` <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />`),
  check: strokeIcon(svg`<path d="M20 6 9 17l-5-5" />`),
  play: strokeIcon(svg`<polygon points="6 3 20 12 6 21 6 3" />`),
  pause: strokeIcon(svg` <rect x="14" y="4" width="4" height="16" rx="1" />
    <rect x="6" y="4" width="4" height="16" rx="1" />`),
  target: strokeIcon(svg` <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2" />`),
  switchCamera: strokeIcon(svg` <path d="M11 19H6.5a4.5 4.5 0 0 1 0-9H8" />
    <path d="m8 16 3 3-3 3" />
    <path d="M13 5h4.5a4.5 4.5 0 0 1 0 9H16" />
    <path d="m16 8-3-3 3-3" />`),
  archive: strokeIcon(svg` <rect width="20" height="5" x="2" y="3" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />`),
  archiveRestore: strokeIcon(svg` <rect width="20" height="5" x="2" y="3" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="m9 15 3-3 3 3" />
    <path d="M12 12v6" />`),
  alertTriangle: strokeIcon(svg` <path
      d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"
    />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />`),
  hand: strokeIcon(svg` <path d="M18 11V6a2 2 0 0 0-4 0v5" />
    <path d="M14 10V4a2 2 0 0 0-4 0v6" />
    <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
    <path d="M6 14v-2a2 2 0 0 0-4 0v4c0 4.4 3.6 8 8 8h2c4.4 0 8-3.6 8-8v-5a2 2 0 0 0-4 0v2" />`),
  key: strokeIcon(svg` <circle cx="7.5" cy="15.5" r="5.5" />
    <path d="m21 2-9.6 9.6" />
    <path d="m15.5 7.5 3 3L22 7l-3-3" />`),
  flag: strokeIcon(svg` <path d="M5 22V4" />
    <path d="M5 4c5-4 9 4 14 0v11c-5 4-9-4-14 0" />`),
  lock: strokeIcon(svg` <rect width="18" height="11" x="3" y="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />`),
  pencil: strokeIcon(svg` <path
      d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"
    />
    <path d="m15 5 4 4" />`),
  hourglass: strokeIcon(svg` <path d="M5 22h14" />
    <path d="M5 2h14" />
    <path d="M17 22v-4.2a4 4 0 0 0-1.2-2.8L12 11l-3.8 4A4 4 0 0 0 7 17.8V22" />
    <path d="M7 2v4.2A4 4 0 0 0 8.2 9l3.8 4 3.8-4A4 4 0 0 0 17 6.2V2" />`),
  layoutComfortable: strokeIcon(svg` <rect width="16" height="5" x="4" y="4" rx="1.5" />
    <rect width="16" height="5" x="4" y="15" rx="1.5" />
    <line x1="7" x2="16" y1="7" y2="7" />
    <line x1="7" x2="16" y1="18" y2="18" />`),
  layoutCompact: strokeIcon(svg` <rect width="16" height="3" x="4" y="4" rx="1" />
    <rect width="16" height="3" x="4" y="9" rx="1" />
    <rect width="16" height="3" x="4" y="14" rx="1" />
    <rect width="16" height="3" x="4" y="19" rx="1" />`),
  listFilter: strokeIcon(svg` <path d="M3 6h18" />
    <path d="M7 12h10" />
    <path d="M10 18h4" />`),
  // Filled dots: strokeIcon()'s shell sets fill="none", so each dot opts back in.
  gripVertical: strokeIcon(svg` <circle cx="9" cy="6" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="18" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="6" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="18" r="1.1" fill="currentColor" stroke="none" />`),
  arrowDown: strokeIcon(svg`<path d="M12 5v14m7-7-7 7-7-7" />`),
  arrowUp: strokeIcon(svg`<path d="M12 19V5m-7 7 7-7 7 7" />`),
  chevronUp: strokeIcon(svg`<path d="m18 15-6-6-6 6" />`),
  arrowLeft: strokeIcon(svg` <path d="m12 19-7-7 7-7" />
    <path d="M19 12H5" />`),
  cornerDownLeft: strokeIcon(svg` <polyline points="9 10 4 15 9 20" />
    <path d="M20 4v7a4 4 0 0 1-4 4H4" />`),
  cornerDownRight: strokeIcon(svg` <polyline points="15 10 20 15 15 20" />
    <path d="M4 4v7a4 4 0 0 0 4 4h12" />`),
  copy: strokeIcon(svg` <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />`),
  search: strokeIcon(svg` <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />`),
  brain: strokeIcon(svg` <path
      d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"
    />
    <path
      d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"
    />
    <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
    <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
    <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
    <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
    <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
    <path d="M6 18a4 4 0 0 1-1.967-.516" />
    <path d="M19.967 17.484A4 4 0 0 1 18 18" />`),
  book: strokeIcon(
    svg` <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />`,
  ),
  loader: strokeIcon(svg` <path d="M12 2v4" />
    <path d="m16.2 7.8 2.9-2.9" />
    <path d="M18 12h4" />
    <path d="m16.2 16.2 2.9 2.9" />
    <path d="M12 18v4" />
    <path d="m4.9 19.1 2.9-2.9" />
    <path d="M2 12h4" />
    <path d="m4.9 4.9 2.9 2.9" />`),
  calendarClock: strokeIcon(svg` <path
      d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"
    />
    <path d="M16 2v4" />
    <path d="M8 2v4" />
    <path d="M3 10h5" />
    <path d="M17.5 17.5 16 16.3V14" />
    <circle cx="16" cy="16" r="6" />`),
  listChecks: strokeIcon(svg` <path d="m3 17 2 2 4-4" />
    <path d="m3 7 2 2 4-4" />
    <path d="M13 6h8" />
    <path d="M13 12h8" />
    <path d="M13 18h8" />`),

  ...toolIcons,
} as const;

export type IconName = keyof typeof icons;

export function icon(name: IconName): TemplateResult {
  return icons[name];
}
