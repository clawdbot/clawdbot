import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";

const ESCAPE = String.fromCharCode(0x1b);
const OSC8_LINK_RE = new RegExp(
  `${ESCAPE}\\]8;;.*?${ESCAPE}\\\\|${ESCAPE}\\]8;;${ESCAPE}\\\\`,
  "g",
);
const SGR_RE = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");

/** Strip ANSI escape codes (SGR, OSC-8) for readable log display. */
function stripAnsi(text: string): string {
  return text.replace(OSC8_LINK_RE, "").replace(SGR_RE, "");
}

export type OverviewLogTailProps = {
  lines: string[];
  onRefreshLogs: () => void;
};

export function renderOverviewLogTail(props: OverviewLogTailProps) {
  if (props.lines.length === 0) {
    return nothing;
  }

  const displayLines = props.lines
    .slice(-50)
    .map((line) => stripAnsi(line))
    .join("\n");

  return html`
    <details class="card ov-log-tail" open>
      <summary class="ov-expandable-toggle">
        <span class="nav-item__icon">${icons.scrollText}</span>
        ${t("overview.logTail.title")}
        <span class="ov-count-badge">${props.lines.length}</span>
        <span
          class="ov-log-refresh"
          @click=${(e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            props.onRefreshLogs();
          }}
          >${icons.loader}</span
        >
      </summary>
      <pre class="ov-log-tail-content">${displayLines}</pre>
    </details>
  `;
}
