import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import { countSessionToolOverrides } from "../../lib/sessions/tool-overrides.ts";
import {
  renderChatComposerPlusMenu,
  type ChatComposerPlusMenuView,
} from "../chat/components/chat-composer-plus-menu.ts";
import type { CapabilityMenuProps } from "../chat/components/chat-composer-types.ts";

type NewSessionComposerCapabilityOptions = {
  submitting: boolean;
  messageLocked?: boolean;
  capabilityMenu?: CapabilityMenuProps;
  toolOverrides?: SessionToolOverrides | null;
  textareaController: {
    capabilityMenuOpen: boolean;
    capabilityMenuView: ChatComposerPlusMenuView;
  };
  requestUpdate: () => void;
};

export function renderNewSessionPlusMenu(
  options: NewSessionComposerCapabilityOptions,
  attachments: Parameters<typeof renderChatComposerPlusMenu>[0]["attachments"],
) {
  const disabled = options.submitting || options.messageLocked === true;
  const controller = options.textareaController;
  return renderChatComposerPlusMenu({
    attachments,
    capabilityMenu: options.capabilityMenu,
    disabled,
    open: controller.capabilityMenuOpen,
    view: controller.capabilityMenuView,
    toolOverrides: options.toolOverrides,
    onOpenChange: (open) => {
      controller.capabilityMenuOpen = open;
      if (!open) {
        controller.capabilityMenuView = "root";
      }
      options.requestUpdate();
    },
    onViewChange: (view) => {
      controller.capabilityMenuView = view;
      options.requestUpdate();
    },
  });
}

export function renderNewSessionSelectionStatus(options: NewSessionComposerCapabilityOptions) {
  const overrideCount = countSessionToolOverrides(options.toolOverrides);
  if (overrideCount === 0) {
    return nothing;
  }
  const disabled = options.submitting || options.messageLocked === true;
  const openMenu = () => {
    options.textareaController.capabilityMenuView = "root";
    options.textareaController.capabilityMenuOpen = true;
    options.requestUpdate();
  };
  return html`
    <button
      type="button"
      class="new-session-page__selection-status"
      ?disabled=${disabled}
      @click=${openMenu}
    >
      ${t(
        overrideCount === 1 ? "chat.composer.overrides.countOne" : "chat.composer.overrides.count",
        { count: String(overrideCount) },
      )}
    </button>
  `;
}
