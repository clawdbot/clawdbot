import { t } from "../../i18n/index.ts";

export function setPreviewExpandButtonState(
  button: Element | null | undefined,
  isFullscreen: boolean,
) {
  if (!(button instanceof HTMLElement)) {
    return;
  }
  const label = isFullscreen ? t("agents.files.collapsePreview") : t("agents.files.expandPreview");
  button.classList.toggle("is-fullscreen", isFullscreen);
  button.setAttribute("aria-pressed", String(isFullscreen));
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
}

export function resetAgentFilePreview(modal: HTMLElement) {
  modal.querySelector(".md-preview-dialog__panel")?.classList.remove("fullscreen");
  setPreviewExpandButtonState(modal.querySelector(".md-preview-expand-btn"), false);
  modal.classList.remove("fullscreen");
}
