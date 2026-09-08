import { svg } from "lit";
import { strokeIcon } from "./icons-tools.ts";
import { icons } from "./icons.ts";

export const deviceIcons = {
  laptop: strokeIcon(svg`<path
      d="M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z"
    />
    <path d="M20.054 15.987H3.946" />`),
  pcCase: strokeIcon(svg`<rect width="14" height="20" x="5" y="2" rx="2" />
    <path d="M15 14h.01M9 6h6M9 10h6" />`),
  macMini: strokeIcon(svg`<path
      d="M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
    />
    <path d="M21.946 12.013H2.054M6 16h.01M10 16h.01" />`),
  allInOne: icons.monitor,
  tablet: strokeIcon(svg`<rect width="16" height="20" x="4" y="2" rx="2" ry="2" />
    <path d="M12 18h.01" />`),
  watch: strokeIcon(svg`<circle cx="12" cy="12" r="6" />
    <polyline points="12 10 12 12 13 13" />
    <path d="m16.13 7.66-.81-4.05a2 2 0 0 0-2-1.61h-2.68a2 2 0 0 0-2 1.61l-.78 4.05" />
    <path d="m7.88 16.36.8 4a2 2 0 0 0 2 1.61h2.72a2 2 0 0 0 2-1.61l.81-4.05" />`),
  smartphone: icons.smartphone,
  browser: icons.globe,
  terminal: icons.terminal,
  server: icons.server,
} as const;
