import { html } from "lit";
import { t } from "../i18n/index.ts";

export function renderCommandPaletteLoading(onClose: () => void) {
  const label = t("palette.placeholder");
  return html`<openclaw-modal-dialog
    class="cmd-palette-overlay palette"
    label=${label}
    style="--openclaw-modal-width: min(640px, calc(100vw - 32px));"
    @modal-cancel=${onClose}
  >
    <div class="cmd-palette" role="status" aria-label=${t("common.loading")}>
      <input class="cmd-palette__input" disabled placeholder=${label} />
      <div class="cmd-palette__empty">${t("common.loading")}</div>
    </div>
  </openclaw-modal-dialog>`;
}
