import { html, nothing } from "lit";
import type { SessionPermissionMode } from "../../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";

const PERMISSION_MODES = ["read-only", "guarded", "workspace", "full"] as const;
const DEFAULT_PERMISSION_VALUE = "default";
const PERMISSION_OPTIONS = [null, ...PERMISSION_MODES] as const;

type PermissionSelection = SessionPermissionMode | null;

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

function ellipsizeMiddle(value: string, maxLength = 54): string {
  if (value.length <= maxLength) {
    return value;
  }
  const edgeLength = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, edgeLength)}…${value.slice(-edgeLength)}`;
}

function modeLabel(mode: SessionPermissionMode | null | undefined): string {
  return mode
    ? t(`chat.permissionControls.modes.${mode}.label`)
    : t("chat.permissionControls.default");
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

export function renderChatPermissionPicker(params: {
  canSelectFull: boolean;
  disabled?: boolean;
  disabledReason?: string;
  mode?: SessionPermissionMode;
  sessionRoot?: string;
  onSelect: (mode: PermissionSelection) => unknown;
}) {
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
      placement="top-end"
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
          : ""}"
        data-chat-permission-select="true"
        data-chat-select-value=${params.mode ?? ""}
        aria-label=${`${t("chat.permissionControls.label")}: ${modeLabel(params.mode)}`}
        aria-disabled=${params.disabled ? "true" : "false"}
        title=${params.disabledReason ?? t("chat.permissionControls.help")}
        ?disabled=${params.disabled}
      >
        <span class="chat-controls__permission-icon" aria-hidden="true">${icons.shieldCheck}</span>
        <span
          class="chat-controls__inline-select-label ${params.mode === "full"
            ? "chat-controls__permission-label--full"
            : ""}"
        >
          ${modeLabel(params.mode)}
        </span>
      </button>
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
            <span class="chat-controls__permission-option-copy">
              <span class="chat-controls__permission-option-title">
                <span>${modeLabel(mode)}</span>
                <span class="chat-controls__permission-shortcut" aria-hidden="true"
                  >${index + 1}</span
                >
              </span>
              <span class="chat-controls__permission-option-description">
                ${mode
                  ? t(`chat.permissionControls.modes.${mode}.description`)
                  : t("chat.permissionControls.defaultDescription")}
              </span>
            </span>
            ${locked || selected
              ? html`
                  <span
                    slot="details"
                    class="chat-controls__permission-option-state"
                    aria-hidden="true"
                  >
                    ${locked
                      ? html`<span class="chat-controls__permission-lock">${icons.lock}</span>`
                      : nothing}
                    ${selected
                      ? html`<span class="chat-controls__inline-select-check">${icons.check}</span>`
                      : nothing}
                  </span>
                `
              : nothing}
          </wa-dropdown-item>
        `;
      })}
      ${params.sessionRoot
        ? html`
            <div
              class="chat-controls__permission-root"
              title=${params.sessionRoot}
              aria-label=${t("chat.permissionControls.sessionRoot", {
                root: params.sessionRoot,
              })}
            >
              <span>${t("chat.permissionControls.rootLabel")}</span>
              <code>${ellipsizeMiddle(params.sessionRoot)}</code>
            </div>
          `
        : nothing}
    </wa-dropdown>
  `;
}
