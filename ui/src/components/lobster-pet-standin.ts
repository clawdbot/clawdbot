import { html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { LobsterLogoVisitDetail } from "./lobster-pet-contract.ts";
import {
  LOBSTER_PET_BUILD_MULS,
  LOBSTER_PET_CLAW_MULS,
  renderLobsterSvg,
} from "./lobster-pet-look.ts";

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
      visit.phase === "leaving" ? "sidebar-brand__pet--leaving" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const style = [
      `--lob-shell:${look.palette.shell}`,
      `--lob-claw:${look.palette.claw}`,
      `--lob-blink-delay:${look.blinkDelayS}s`,
      `--lob-w:${LOBSTER_PET_BUILD_MULS[look.build].w}`,
      `--lob-h:${LOBSTER_PET_BUILD_MULS[look.build].h}`,
      `--lob-claw-scale:${LOBSTER_PET_CLAW_MULS[look.clawSize]}`,
    ].join(";");
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
