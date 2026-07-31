import { OpenClawFilePreviewModal } from "./file-preview-modal.ts";

if (!customElements.get("openclaw-file-preview-modal")) {
  customElements.define("openclaw-file-preview-modal", OpenClawFilePreviewModal);
}
