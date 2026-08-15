// Shared body wrapper for settings and settings-adjacent pages. Settings
// section navigation lives in the takeover sidebar (settings-sidebar.ts).
import { html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";

export function renderSettingsWorkspace(
  body: unknown,
  options: {
    fillHeight?: boolean;
    id?: string;
    role?: string;
    ariaLabel?: string;
  } = {},
) {
  const className = options.fillHeight
    ? "settings-workspace settings-workspace--fill-height"
    : "settings-workspace";
  return html`
    <section
      class=${className}
      id=${ifDefined(options.id)}
      role=${ifDefined(options.role)}
      aria-label=${ifDefined(options.ariaLabel)}
    >
      <div class="settings-workspace__body">${body}</div>
    </section>
  `;
}
