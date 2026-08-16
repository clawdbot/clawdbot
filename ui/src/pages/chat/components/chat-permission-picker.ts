import type { SessionPermissionMode } from "../../../../../packages/gateway-protocol/src/index.js";
import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { syncChatPickerOverlay } from "./chat-picker-overlay.ts";

const PERMISSION_MODES = ["read-only", "guarded", "workspace", "full"] as const;

function permissionPickerRows(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>("[data-chat-permission-option]")].filter(
    (row) => !row.disabled,
  );
}

function ensurePermissionPickerIds(details: HTMLDetailsElement): void {
  const listbox = details.querySelector<HTMLElement>("[data-chat-permission-list]");
  const trigger = details.querySelector<HTMLElement>("[data-chat-permission-select]");
  if (!listbox || !trigger) {
    return;
  }
  const prefix =
    details.dataset.chatPermissionPickerId ?? `chat-permission-picker-${crypto.randomUUID()}`;
  details.dataset.chatPermissionPickerId = prefix;
  listbox.id = `${prefix}-listbox`;
  details
    .querySelectorAll<HTMLButtonElement>("[data-chat-permission-option]")
    .forEach((row, index) => {
      row.id = `${prefix}-option-${index}`;
    });
  trigger.setAttribute("aria-controls", listbox.id);
  trigger.setAttribute("aria-expanded", details.open ? "true" : "false");
}

function highlightPermissionRow(root: HTMLElement, row: HTMLButtonElement | undefined): void {
  root.querySelectorAll<HTMLElement>("[data-chat-permission-option]").forEach((candidate) => {
    candidate.toggleAttribute("data-chat-permission-highlighted", candidate === row);
  });
  const listbox = root.querySelector<HTMLElement>("[data-chat-permission-list]");
  if (row?.id) {
    listbox?.setAttribute("aria-activedescendant", row.id);
  } else {
    listbox?.removeAttribute("aria-activedescendant");
  }
}

function handlePermissionPickerKeydown(event: KeyboardEvent): void {
  const details = event.currentTarget as HTMLDetailsElement;
  if (!details.open) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    details.open = false;
    details.querySelector<HTMLElement>("summary")?.focus();
    return;
  }
  const rows = permissionPickerRows(details);
  if (rows.length === 0) {
    return;
  }
  if (/^[1-4]$/u.test(event.key)) {
    event.preventDefault();
    rows.find((row) => row.dataset.chatPermissionShortcut === event.key)?.click();
    return;
  }
  if (event.key === "Enter") {
    const highlighted = rows.find((row) => row.hasAttribute("data-chat-permission-highlighted"));
    if (highlighted) {
      event.preventDefault();
      highlighted.click();
    }
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  event.preventDefault();
  const currentIndex = rows.findIndex((row) =>
    row.hasAttribute("data-chat-permission-highlighted"),
  );
  const offset = event.key === "ArrowDown" ? 1 : rows.length - 1;
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + offset) % rows.length;
  const next = rows[nextIndex];
  highlightPermissionRow(details, next);
  next?.focus({ preventScroll: true });
}

function ellipsizeMiddle(value: string, maxLength = 54): string {
  if (value.length <= maxLength) {
    return value;
  }
  const edgeLength = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, edgeLength)}…${value.slice(-edgeLength)}`;
}

function modeLabel(mode: SessionPermissionMode | undefined): string {
  return mode
    ? t(`chat.permissionControls.modes.${mode}.label`)
    : t("chat.permissionControls.default");
}

export function renderChatPermissionPicker(params: {
  canSelectFull: boolean;
  disabled?: boolean;
  disabledReason?: string;
  mode?: SessionPermissionMode;
  sessionRoot?: string;
  onSelect: (mode: SessionPermissionMode) => Promise<unknown> | unknown;
}) {
  const selectMode = (mode: SessionPermissionMode, event: MouseEvent) => {
    event.stopPropagation();
    if (params.disabled || (mode === "full" && !params.canSelectFull)) {
      event.preventDefault();
      return;
    }
    if (mode !== params.mode) {
      void params.onSelect(mode);
    }
    const details = (event.currentTarget as HTMLElement).closest<HTMLDetailsElement>("details");
    if (details) {
      details.open = false;
      details.querySelector<HTMLElement>("summary")?.focus();
    }
  };
  return html`
    <details
      class="chat-controls__inline-select chat-controls__permission-picker"
      @keydown=${handlePermissionPickerKeydown}
      @toggle=${(event: Event) => {
        const details = event.currentTarget as HTMLDetailsElement;
        syncChatPickerOverlay(details);
        ensurePermissionPickerIds(details);
        if (details.open) {
          queueMicrotask(() => {
            const rows = permissionPickerRows(details);
            const selected = rows.find((row) => row.getAttribute("aria-selected") === "true");
            highlightPermissionRow(details, selected ?? rows[0]);
          });
        }
      }}
    >
      <summary
        class="chat-controls__inline-select-trigger chat-controls__permission-trigger ${params.disabled
          ? "chat-controls__inline-select-trigger--disabled"
          : ""}"
        data-chat-permission-select="true"
        data-chat-select-value=${params.mode ?? ""}
        aria-label=${`${t("chat.permissionControls.label")}: ${modeLabel(params.mode)}`}
        aria-disabled=${params.disabled ? "true" : "false"}
        title=${params.disabledReason ?? t("chat.permissionControls.help")}
        @click=${(event: MouseEvent) => {
          if (params.disabled) {
            event.preventDefault();
            return;
          }
          (event.currentTarget as HTMLElement).focus({ preventScroll: true });
        }}
      >
        <span class="chat-controls__permission-icon" aria-hidden="true">${icons.shieldCheck}</span>
        <span
          class="chat-controls__inline-select-label ${params.mode === "full"
            ? "chat-controls__permission-label--full"
            : ""}"
        >
          ${modeLabel(params.mode)}
        </span>
      </summary>
      <wa-popup data-anchored-overlay>
        <div
          class="chat-controls__inline-select-menu chat-controls__permission-menu"
          data-chat-permission-list="true"
          role="listbox"
          aria-label=${t("chat.permissionControls.label")}
        >
          <div class="chat-controls__permission-options">
            ${PERMISSION_MODES.map((mode, index) => {
              const selected = params.mode === mode;
              const locked = mode === "full" && !params.canSelectFull;
              return html`
                <button
                  class="chat-controls__inline-select-option chat-controls__permission-option ${selected
                    ? "chat-controls__inline-select-option--selected"
                    : ""}"
                  data-chat-permission-option=${mode}
                  data-chat-permission-shortcut=${String(index + 1)}
                  role="option"
                  aria-selected=${selected ? "true" : "false"}
                  aria-label=${locked
                    ? `${modeLabel(mode)}. ${t("chat.permissionControls.fullRequiresAdmin")}`
                    : modeLabel(mode)}
                  title=${locked ? t("chat.permissionControls.fullRequiresAdmin") : nothing}
                  type="button"
                  ?disabled=${params.disabled || locked}
                  @mouseenter=${(event: MouseEvent) =>
                    highlightPermissionRow(
                      (event.currentTarget as HTMLElement).closest<HTMLDetailsElement>("details") ??
                        (event.currentTarget as HTMLButtonElement),
                      event.currentTarget as HTMLButtonElement,
                    )}
                  @focus=${(event: FocusEvent) =>
                    highlightPermissionRow(
                      (event.currentTarget as HTMLElement).closest<HTMLDetailsElement>("details") ??
                        (event.currentTarget as HTMLButtonElement),
                      event.currentTarget as HTMLButtonElement,
                    )}
                  @click=${(event: MouseEvent) => selectMode(mode, event)}
                >
                  <span class="chat-controls__permission-option-copy">
                    <span class="chat-controls__permission-option-title">
                      <span>${modeLabel(mode)}</span>
                      <span class="chat-controls__permission-shortcut" aria-hidden="true"
                        >${index + 1}</span
                      >
                    </span>
                    <span class="chat-controls__permission-option-description">
                      ${t(`chat.permissionControls.modes.${mode}.description`)}
                    </span>
                  </span>
                  ${locked || selected
                    ? html`
                        <span class="chat-controls__permission-option-state" aria-hidden="true">
                          ${locked
                            ? html`<span class="chat-controls__permission-lock">${icons.lock}</span>`
                            : nothing}
                          ${selected
                            ? html`<span class="chat-controls__inline-select-check"
                                >${icons.check}</span
                              >`
                            : nothing}
                        </span>
                      `
                    : nothing}
                </button>
              `;
            })}
          </div>
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
        </div>
      </wa-popup>
    </details>
  `;
}
