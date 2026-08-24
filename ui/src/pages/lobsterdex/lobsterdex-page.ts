import { html } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute } from "../../app-navigation.ts";
import { getLobsterdexEntries } from "../../components/lobster-dex.ts";
import type { LobsterPetPaletteId } from "../../components/lobster-pet-contract.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { renderLobsterdex, type LobsterdexCopyFeedback } from "./view.ts";

class LobsterdexPage extends OpenClawLightDomElement {
  @state() private copyFeedback: LobsterdexCopyFeedback | null = null;
  private copyAttempt = 0;
  private copyResetTimer: number | null = null;

  override disconnectedCallback(): void {
    this.copyAttempt += 1;
    this.copyFeedback = null;
    if (this.copyResetTimer !== null) {
      window.clearTimeout(this.copyResetTimer);
      this.copyResetTimer = null;
    }
    super.disconnectedCallback();
  }

  protected override firstUpdated(): void {
    const hashPrefix = "#lobsterdex-";
    if (!location.hash.startsWith(hashPrefix)) {
      return;
    }
    const palette = LOBSTER_PET_PALETTES.find(
      (entry) => entry.id === location.hash.slice(hashPrefix.length),
    );
    if (!palette) {
      return;
    }
    const card = this.querySelector<HTMLElement>(`#lobsterdex-${palette.id}`);
    if (!card) {
      return;
    }
    const clearHighlight = (event: AnimationEvent) => {
      // Palette animations bubble through the card too; only its own pulse
      // owns this transient deep-link marker.
      if (event.target !== card || event.animationName !== "lobsterdex-card-highlight") {
        return;
      }
      card.classList.remove("lobsterdex-page__card--highlight");
      card.removeEventListener("animationend", clearHighlight);
    };
    card.addEventListener("animationend", clearHighlight);
    card.classList.add("lobsterdex-page__card--highlight");
    // Double rAF: the workspace shell finishes layout after first render, and
    // scrolling immediately leaves the target beyond the settled viewport.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => card.scrollIntoView({ block: "center" }));
    });
  }

  private readonly copyLink = async (paletteId: LobsterPetPaletteId): Promise<void> => {
    const attempt = ++this.copyAttempt;
    this.copyFeedback = null;
    if (this.copyResetTimer !== null) {
      window.clearTimeout(this.copyResetTimer);
      this.copyResetTimer = null;
    }
    const url = `${location.origin}${location.pathname}#lobsterdex-${paletteId}`;
    const copied = await copyToClipboard(
      url,
      () => this.isConnected && attempt === this.copyAttempt,
    );
    if (!this.isConnected || attempt !== this.copyAttempt) {
      return;
    }
    this.copyFeedback = { paletteId, status: copied ? "copied" : "error" };
    this.copyResetTimer = window.setTimeout(() => {
      this.copyFeedback = null;
      this.copyResetTimer = null;
    }, 1_500);
  };

  override render() {
    return html`
      <section class="content-header">
        <div class="page-title">${titleForRoute("lobsterdex")}</div>
      </section>
      ${renderSettingsWorkspace(
        renderLobsterdex(getLobsterdexEntries(), {
          copyFeedback: this.copyFeedback,
          onCopyLink: (paletteId) => void this.copyLink(paletteId),
        }),
      )}
    `;
  }
}

if (!customElements.get("openclaw-lobsterdex-page")) {
  customElements.define("openclaw-lobsterdex-page", LobsterdexPage);
}
