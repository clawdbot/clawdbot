import { html } from "lit";
import { titleForRoute } from "../../app-navigation.ts";
import { getLobsterdexEntries } from "../../components/lobster-dex.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { renderLobsterdex } from "./view.ts";

class LobsterdexPage extends OpenClawLightDomElement {
  override render() {
    return html`
      <section class="content-header">
        <div class="page-title">${titleForRoute("lobsterdex")}</div>
      </section>
      ${renderSettingsWorkspace(renderLobsterdex(getLobsterdexEntries()))}
    `;
  }
}

if (!customElements.get("openclaw-lobsterdex-page")) {
  customElements.define("openclaw-lobsterdex-page", LobsterdexPage);
}
