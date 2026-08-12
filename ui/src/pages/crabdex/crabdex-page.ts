import { html } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute } from "../../app-navigation.ts";
import { getCrabdexEntries } from "../../components/crab-dex.ts";
import type { CrabPetPaletteId } from "../../components/crab-pet-contract.ts";
import { CRAB_PET_PALETTES } from "../../components/crab-pet.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { renderCrabdex } from "./view.ts";

class CrabdexPage extends OpenClawLightDomElement {
  @state() private copiedPaletteId: CrabPetPaletteId | null = null;
  private copyResetTimer: number | null = null;

  override disconnectedCallback(): void {
    if (this.copyResetTimer !== null) {
      window.clearTimeout(this.copyResetTimer);
      this.copyResetTimer = null;
    }
    super.disconnectedCallback();
  }

  protected override firstUpdated(): void {
    const hashPrefix = "#crabdex-";
    if (!location.hash.startsWith(hashPrefix)) {
      return;
    }
    const palette = CRAB_PET_PALETTES.find(
      (entry) => entry.id === location.hash.slice(hashPrefix.length),
    );
    if (!palette) {
      return;
    }
    const card = this.querySelector<HTMLElement>(`#crabdex-${palette.id}`);
    if (!card) {
      return;
    }
    const clearHighlight = (event: AnimationEvent) => {
      // Palette animations bubble through the card too; only its own pulse
      // owns this transient deep-link marker.
      if (event.target !== card || event.animationName !== "crabdex-card-highlight") {
        return;
      }
      card.classList.remove("crabdex-page__card--highlight");
      card.removeEventListener("animationend", clearHighlight);
    };
    card.addEventListener("animationend", clearHighlight);
    card.classList.add("crabdex-page__card--highlight");
    // Double rAF: the workspace shell finishes layout after first render, and
    // scrolling immediately leaves the target beyond the settled viewport.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => card.scrollIntoView({ block: "center" }));
    });
  }

  private readonly copyLink = async (paletteId: CrabPetPaletteId): Promise<void> => {
    const url = `${location.origin}${location.pathname}#crabdex-${paletteId}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      return;
    }
    this.copiedPaletteId = paletteId;
    if (this.copyResetTimer !== null) {
      window.clearTimeout(this.copyResetTimer);
    }
    this.copyResetTimer = window.setTimeout(() => {
      this.copiedPaletteId = null;
      this.copyResetTimer = null;
    }, 1_500);
  };

  override render() {
    return html`
      <section class="content-header">
        <div class="page-title">${titleForRoute("crabdex")}</div>
      </section>
      ${renderSettingsWorkspace(
        renderCrabdex(getCrabdexEntries(), {
          copiedPaletteId: this.copiedPaletteId,
          onCopyLink: (paletteId) => void this.copyLink(paletteId),
        }),
      )}
    `;
  }
}

if (!customElements.get("openclaw-crabdex-page")) {
  customElements.define("openclaw-crabdex-page", CrabdexPage);
}
