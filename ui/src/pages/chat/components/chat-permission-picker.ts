import { html, nothing } from "lit";
import type { SessionPermissionMode } from "../../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../../lib/external-link.ts";
import { restorePointerOpenedChatComposerTrigger } from "./chat-picker-overlay.ts";

const PERMISSION_MODES_DOCS_URL = "https://docs.openclaw.ai/gateway/permission-modes";
const PERMISSION_MODES = ["read-only", "guarded", "workspace", "full"] as const;
const DEFAULT_PERMISSION_VALUE = "default";
const PERMISSION_OPTIONS = [null, ...PERMISSION_MODES] as const;

type PermissionSelection = SessionPermissionMode | null;

export type ChatPermissionPickerProps = {
  canSelectFull: boolean;
  disabled?: boolean;
  disabledReason?: string;
  mode?: SessionPermissionMode;
  onSelect: (mode: PermissionSelection) => unknown;
};

function handlePermissionPickerKeydown(
  event: KeyboardEvent,
  onSelect: (mode: PermissionSelection) => void,
): void {
  const dropdown = event.currentTarget;
  if (
    !(dropdown instanceof HTMLElement) ||
    !dropdown.hasAttribute("open") ||
    !/^[1-5]$/u.test(event.key)
  ) {
    return;
  }
  const option = dropdown.querySelector<HTMLElement>(
    `[data-chat-permission-shortcut="${event.key}"]`,
  );
  if (!option || option.hasAttribute("disabled")) {
    return;
  }
  const mode = permissionSelection(option.dataset.chatPermissionOption);
  if (mode === undefined) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  onSelect(mode);
  dropdown.removeAttribute("open");
  dropdown.querySelector<HTMLButtonElement>("[slot=trigger]")?.focus();
}

function modeLabel(mode: SessionPermissionMode | null | undefined): string {
  return mode
    ? t(`chat.permissionControls.modes.${mode}.label`)
    : t("chat.permissionControls.default");
}

function modeIcon(mode: SessionPermissionMode | null): unknown {
  switch (mode) {
    case "read-only":
      return icons.shieldEllipsis;
    case "guarded":
      return icons.shieldLock;
    case "workspace":
      return icons.shieldCog;
    case "full":
      return icons.shieldAlert;
    default:
      return icons.shieldCheck;
  }
}

function isPermissionMode(value: string | undefined): value is SessionPermissionMode {
  return value !== undefined && PERMISSION_MODES.some((mode) => mode === value);
}

function permissionSelection(value: string | undefined): PermissionSelection | undefined {
  if (value === DEFAULT_PERMISSION_VALUE) {
    return null;
  }
  return isPermissionMode(value) ? value : undefined;
}

export function renderChatPermissionPicker(params: ChatPermissionPickerProps) {
  const selectMode = (mode: PermissionSelection) => {
    if (params.disabled || (mode === "full" && !params.canSelectFull)) {
      return;
    }
    if (mode !== (params.mode ?? null)) {
      void params.onSelect(mode);
    }
  };
  return html`
    <wa-dropdown
      class="chat-controls__inline-select chat-controls__permission-picker"
      placement="top-start"
      @wa-after-show=${restorePointerOpenedChatComposerTrigger}
      @keydown=${(event: KeyboardEvent) => handlePermissionPickerKeydown(event, selectMode)}
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
        const mode = permissionSelection(event.detail.item.value);
        if (mode !== undefined) {
          selectMode(mode);
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        class="chat-controls__inline-select-trigger chat-controls__permission-trigger ${params.disabled
          ? "chat-controls__inline-select-trigger--disabled"
          : ""} ${params.mode ? "" : "chat-controls__permission-trigger--default"} ${params.mode ===
        "full"
          ? "chat-controls__permission-trigger--full"
          : ""}"
        data-chat-permission-select="true"
        data-chat-select-value=${params.mode ?? ""}
        aria-label=${`${t("chat.permissionControls.label")}: ${modeLabel(params.mode)}`}
        aria-disabled=${params.disabled ? "true" : "false"}
        title=${params.disabledReason ?? t("chat.permissionControls.help")}
        ?disabled=${params.disabled}
      >
        <span class="chat-controls__permission-icon" aria-hidden="true"
          >${modeIcon(params.mode ?? null)}</span
        >
        <span
          class="chat-controls__inline-select-label ${params.mode === "full"
            ? "chat-controls__permission-label--full"
            : ""}"
        >
          ${modeLabel(params.mode)}
        </span>
      </button>
      <div class="chat-controls__popover-title chat-controls__permission-heading">
        <span>${t("chat.permissionControls.label")}</span>
        <a
          class="chat-controls__permission-learn-more learn-more-link"
          href=${PERMISSION_MODES_DOCS_URL}
          target=${EXTERNAL_LINK_TARGET}
          rel=${buildExternalLinkRel()}
          >${t("common.learnMore")}</a
        >
      </div>
      ${PERMISSION_OPTIONS.map((mode, index) => {
        const value = mode ?? DEFAULT_PERMISSION_VALUE;
        const selected = (params.mode ?? null) === mode;
        const locked = mode === "full" && !params.canSelectFull;
        return html`
          <wa-dropdown-item
            class="chat-controls__permission-option ${selected
              ? "chat-controls__permission-option--selected"
              : ""}"
            value=${value}
            data-chat-permission-option=${value}
            data-chat-permission-shortcut=${String(index + 1)}
            role="menuitemradio"
            aria-checked=${selected ? "true" : "false"}
            aria-label=${locked
              ? `${modeLabel(mode)}. ${t("chat.permissionControls.fullRequiresAdmin")}`
              : modeLabel(mode)}
            title=${locked ? t("chat.permissionControls.fullRequiresAdmin") : nothing}
            ?disabled=${params.disabled || locked}
          >
            <span slot="icon" class="chat-controls__permission-option-icon" aria-hidden="true"
              >${modeIcon(mode)}</span
            >
            <span class="chat-controls__permission-option-copy">
              <span class="chat-controls__permission-option-title">
                <span>${modeLabel(mode)}</span>
              </span>
              <span class="chat-controls__permission-option-description">
                ${mode
                  ? t(`chat.permissionControls.modes.${mode}.description`)
                  : t("chat.permissionControls.defaultDescription")}
              </span>
            </span>
            <span slot="details" class="chat-controls__permission-option-state" aria-hidden="true">
              ${selected || locked
                ? nothing
                : html`<span class="chat-controls__permission-shortcut">${index + 1}</span>`}
              ${locked
                ? html`<span class="chat-controls__permission-lock">${icons.lock}</span>`
                : nothing}
              ${selected && !locked
                ? html`<span class="chat-controls__inline-select-check">${icons.check}</span>`
                : nothing}
            </span>
          </wa-dropdown-item>
        `;
      })}
    </wa-dropdown>
  `;
}
