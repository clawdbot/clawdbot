import { html, nothing } from "lit";
import type { CrabPetPaletteId } from "../../components/crab-pet-contract.ts";
import { CRAB_PALETTE_LORE } from "../../components/crab-pet-lore.ts";
import {
  CRAB_PET_PALETTES,
  canonicalCrabLook,
  crabLookStyle,
  crabPaletteName,
  renderCrabSvg,
} from "../../components/crab-pet.ts";
import { icons } from "../../components/icons.ts";
import { i18n, t } from "../../i18n/index.ts";
import "../../styles/crab-pet.css";

type CrabdexViewEntry = {
  firstSeenAt: number | null;
  name: string | null;
  shinySeenAt: number | null;
};

type CrabdexViewEntries = ReadonlyMap<string, CrabdexViewEntry>;

type CrabdexViewProps = {
  copiedPaletteId?: CrabPetPaletteId | null;
  onCopyLink?: (paletteId: CrabPetPaletteId) => void;
};

function formatCrabdexDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(i18n.getLocale());
}

export function renderCrabdex(entries: CrabdexViewEntries, props: CrabdexViewProps = {}) {
  const seenCount = CRAB_PET_PALETTES.filter((palette) => entries.has(palette.id)).length;
  const complete = seenCount === CRAB_PET_PALETTES.length;
  const countLabel = t("quickSettings.appearance.crabdexSeen", {
    seen: String(seenCount),
    total: String(CRAB_PET_PALETTES.length),
  });
  return html`
    <section class="crabdex-page">
      <header class="crabdex-page__header ${complete ? "crabdex-page__header--complete" : ""}">
        <div>
          <h2>${t("tabs.crabdex")}</h2>
          <p>${t("subtitles.crabdex")}</p>
        </div>
        <span class="crabdex-page__count">${countLabel}</span>
      </header>
      <div class="crabdex-page__grid" aria-label=${countLabel}>
        ${CRAB_PET_PALETTES.map((palette) => {
          const look = canonicalCrabLook(palette);
          const entry = entries.get(palette.id);
          const seen = entry !== undefined;
          const name = seen ? (entry.name ?? crabPaletteName(palette.id)) : "?";
          const lore = CRAB_PALETTE_LORE[palette.id];
          const firstSeen =
            seen && entry.firstSeenAt !== null
              ? t("quickSettings.appearance.crabdexCardFirstVisited", {
                  date: formatCrabdexDate(entry.firstSeenAt),
                })
              : null;
          const shinySeen =
            entry?.shinySeenAt != null
              ? t("quickSettings.appearance.crabdexCardShinySeen", {
                  date: formatCrabdexDate(entry.shinySeenAt),
                })
              : null;
          return html`
            <article
              id="crabdex-${palette.id}"
              class="crabdex-page__card ${seen ? "" : "crabdex-page__card--unseen"}"
            >
              <button
                type="button"
                class="crabdex-page__copy-link"
                aria-label=${t("quickSettings.appearance.crabdexCardCopyLink")}
                @click=${() => props.onCopyLink?.(palette.id)}
              >
                <span aria-hidden="true"
                  >${props.copiedPaletteId === palette.id ? icons.check : icons.link}</span
                >
              </button>
              <div
                class="crabdex-page__sprite crab-pet crab-pet--palette-${palette.id} ${seen
                  ? ""
                  : "crabdex__mini--unseen"}"
                style=${crabLookStyle(look)}
              >
                ${renderCrabSvg(look, { standalone: true })}
                ${entry?.shinySeenAt != null
                  ? html`<span class="crabdex__mini-star crabdex-page__star" aria-hidden="true"
                      >✦</span
                    >`
                  : nothing}
              </div>
              <h3>${name}</h3>
              <p class="crabdex-page__lore">${seen ? lore.flavor : lore.hint}</p>
              <div class="crabdex-page__dates">
                ${firstSeen
                  ? html`<p class="crabdex-page__date"><time>${firstSeen}</time></p>`
                  : nothing}
                ${shinySeen
                  ? html`<p class="crabdex-page__date"><time>${shinySeen}</time></p>`
                  : nothing}
              </div>
            </article>
          `;
        })}
      </div>
    </section>
  `;
}
