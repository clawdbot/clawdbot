import { html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { LobsterLogoVisitDetail } from "./lobster-pet-contract.ts";
import { lobsterLookStyleVars, renderLobsterSvg } from "./lobster-pet-look.ts";

class LobsterLogoStandIn extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) visit: LobsterLogoVisitDetail | null = null;

  override render() {
    const visit = this.visit;
    if (!visit?.look) {
      return nothing;
    }
    const look = visit.look;
    const classes = [
      "sidebar-brand__pet",
      `lobster-pet--palette-${look.palette.id}`,
      look.shiny ? "lobster-pet--shiny" : "",
      visit.phase === "leaving" ? "sidebar-brand__pet--leaving" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const style = lobsterLookStyleVars(look).join(";");
    return html`
      <span class=${classes} style=${style} title=${`${visit.name} · filling in for the logo`}
        >${renderLobsterSvg(look)}</span
      >
    `;
  }
}

if (!customElements.get("openclaw-lobster-logo-standin")) {
  customElements.define("openclaw-lobster-logo-standin", LobsterLogoStandIn);
}
