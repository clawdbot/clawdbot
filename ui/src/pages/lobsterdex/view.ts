import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import type { LobsterPetPaletteId } from "../../components/lobster-pet-contract.ts";
import { LOBSTER_PALETTE_LORE } from "../../components/lobster-pet-lore.ts";
import {
  LOBSTER_PET_PALETTES,
  canonicalLobsterLook,
  lobsterLookStyle,
  lobsterPaletteName,
  renderLobsterSvg,
} from "../../components/lobster-pet.ts";
import { i18n, t } from "../../i18n/index.ts";
import "../../styles/lobster-pet.css";

type LobsterdexViewEntry = {
  firstSeenAt: number | null;
  name: string | null;
  shinySeenAt: number | null;
};

type LobsterdexViewEntries = ReadonlyMap<string, LobsterdexViewEntry>;

type LobsterdexViewProps = {
  copiedPaletteId?: LobsterPetPaletteId | null;
  onCopyLink?: (paletteId: LobsterPetPaletteId) => void;
};

function formatLobsterdexDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(i18n.getLocale());
}

export function renderLobsterdex(entries: LobsterdexViewEntries, props: LobsterdexViewProps = {}) {
  const seenCount = LOBSTER_PET_PALETTES.filter((palette) => entries.has(palette.id)).length;
  const complete = seenCount === LOBSTER_PET_PALETTES.length;
  const countLabel = t("quickSettings.appearance.lobsterdexSeen", {
    seen: String(seenCount),
    total: String(LOBSTER_PET_PALETTES.length),
  });
  return html`
    <section class="lobsterdex-page">
      <header
        class="lobsterdex-page__header ${complete ? "lobsterdex-page__header--complete" : ""}"
      >
        <div>
          <h2>${t("tabs.lobsterdex")}</h2>
          <p>${t("subtitles.lobsterdex")}</p>
        </div>
        <span class="lobsterdex-page__count">${countLabel}</span>
      </header>
      <div class="lobsterdex-page__grid" aria-label=${countLabel}>
        ${LOBSTER_PET_PALETTES.map((palette) => {
          const look = canonicalLobsterLook(palette);
          const entry = entries.get(palette.id);
          const seen = entry !== undefined;
          const name = seen ? (entry.name ?? lobsterPaletteName(palette.id)) : "?";
          const lore = LOBSTER_PALETTE_LORE[palette.id];
          const firstSeen =
            seen && entry.firstSeenAt !== null
              ? t("quickSettings.appearance.lobsterdexCardFirstVisited", {
                  date: formatLobsterdexDate(entry.firstSeenAt),
                })
              : null;
          const shinySeen =
            entry?.shinySeenAt != null
              ? t("quickSettings.appearance.lobsterdexCardShinySeen", {
                  date: formatLobsterdexDate(entry.shinySeenAt),
                })
              : null;
          return html`
            <article
              id="lobsterdex-${palette.id}"
              class="lobsterdex-page__card ${seen ? "" : "lobsterdex-page__card--unseen"}"
            >
              <button
                type="button"
                class="lobsterdex-page__copy-link"
                aria-label=${t("quickSettings.appearance.lobsterdexCardCopyLink")}
                @click=${() => props.onCopyLink?.(palette.id)}
              >
                <span aria-hidden="true"
                  >${props.copiedPaletteId === palette.id ? icons.check : icons.link}</span
                >
              </button>
              <div
                class="lobsterdex-page__sprite lobster-pet lobster-pet--palette-${palette.id} ${seen
                  ? ""
                  : "lobsterdex__mini--unseen"}"
                style=${lobsterLookStyle(look)}
              >
                ${renderLobsterSvg(look, { standalone: true })}
                ${entry?.shinySeenAt != null
                  ? html`<span
                      class="lobsterdex__mini-star lobsterdex-page__star"
                      aria-hidden="true"
                      >✦</span
                    >`
                  : nothing}
              </div>
              <h3>${name}</h3>
              <p class="lobsterdex-page__lore">${seen ? lore.flavor : lore.hint}</p>
              <div class="lobsterdex-page__dates">
                ${firstSeen
                  ? html`<p class="lobsterdex-page__date"><time>${firstSeen}</time></p>`
                  : nothing}
                ${shinySeen
                  ? html`<p class="lobsterdex-page__date"><time>${shinySeen}</time></p>`
                  : nothing}
              </div>
            </article>
          `;
        })}
      </div>
    </section>
  `;
}
