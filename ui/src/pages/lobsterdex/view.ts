import { html, nothing } from "lit";
import { LOBSTER_PALETTE_LORE } from "../../components/lobster-pet-lore.ts";
import {
  LOBSTER_PET_PALETTES,
  canonicalLobsterLook,
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

export function renderLobsterdex(entries: LobsterdexViewEntries) {
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
          const entry = entries.get(palette.id);
          const seen = entry !== undefined;
          const name = seen ? (entry.name ?? lobsterPaletteName(palette.id)) : "?";
          const lore = LOBSTER_PALETTE_LORE[palette.id];
          const firstSeen =
            seen && entry.firstSeenAt !== null
              ? t("quickSettings.appearance.lobsterdexCardFirstVisited", {
                  date: new Date(entry.firstSeenAt).toLocaleDateString(i18n.getLocale()),
                })
              : null;
          return html`
            <article class="lobsterdex-page__card ${seen ? "" : "lobsterdex-page__card--unseen"}">
              <div
                class="lobsterdex-page__sprite lobster-pet lobster-pet--palette-${palette.id} ${seen
                  ? ""
                  : "lobsterdex__mini--unseen"}"
                style="--lob-shell:${palette.shell};--lob-claw:${palette.claw}"
              >
                ${renderLobsterSvg(canonicalLobsterLook(palette), { standalone: true })}
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
              ${firstSeen
                ? html`<p class="lobsterdex-page__date"><time>${firstSeen}</time></p>`
                : nothing}
            </article>
          `;
        })}
      </div>
    </section>
  `;
}
