import { html } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";

export function renderVoiceAttachmentMenuOptions() {
  return [
    {
      value: "camera",
      icon: icons.camera,
      label: t("chat.composer.cameraInput"),
      detail: t("chat.composer.takePhotoHint"),
    },
    {
      value: "photo",
      icon: icons.image,
      label: t("chat.composer.photoLibrary"),
      detail: t("chat.composer.attachPhotoHint"),
    },
    {
      value: "file",
      icon: icons.paperclip,
      label: t("chat.composer.fileBrowser"),
      detail: t("chat.composer.attachFileHint"),
    },
  ].map(
    (option) => html`
      <wa-dropdown-item class="agent-chat__attach-menu-option" value=${option.value}>
        <span slot="icon" aria-hidden="true">${option.icon}</span>
        <span class="agent-chat__attach-menu-copy">
          <span>${option.label}</span>
          <span class="agent-chat__attach-menu-detail">
            <span>${option.detail}</span>
            <span class="agent-chat__attach-menu-chevron" aria-hidden="true"
              >${icons.chevronRight}</span
            >
          </span>
        </span>
      </wa-dropdown-item>
    `,
  );
}
