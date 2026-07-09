// Shared body wrapper for settings and settings-adjacent pages. Settings
// section navigation lives in the takeover sidebar (settings-sidebar.ts).
import { html } from "lit";

export function renderSettingsWorkspace(body: unknown, options: { fillHeight?: boolean } = {}) {
  const className = options.fillHeight
    ? "settings-workspace settings-workspace--fill-height"
    : "settings-workspace";
  return html`
    <section class=${className}>
      <div class="settings-workspace__body">${body}</div>
    </section>
  `;
}
