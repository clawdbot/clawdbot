import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { GatewaySessionsDefaults } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import {
  hasProviderBrandIcon,
  providerDisplayLabel,
  renderProviderBrandIcon,
} from "../../../components/provider-icon.ts";
import { t } from "../../../i18n/index.ts";
import {
  type ChatContextWindowControlParams,
  renderContextWindowControl,
} from "./chat-context-window-control.ts";
import {
  type ChatModelCatalogState,
  renderChatModelCatalogState,
} from "./chat-model-catalog-state.ts";
import {
  renderChatModelPickerOption,
  renderChatModelPickerTargetOption,
  renderChatModelProviderIcon,
  type ChatModelPickerOption,
  type ChatModelPickerTargetGroup,
} from "./chat-model-picker-options.ts";
import { handleChatComposerDetailsToggle, syncChatPickerOverlay } from "./chat-picker-overlay.ts";

export type { ChatModelCatalogState } from "./chat-model-catalog-state.ts";

type ChatModelPickerParams = {
  contextWindow?: ChatContextWindowControlParams;
  defaultModelLabel: string;
  disabled: boolean;
  disabledReason?: string;
  modelCatalogState?: ChatModelCatalogState;
  modelSelectionLocked: boolean;
  modelSelectionTarget?: GatewaySessionsDefaults["modelSelectionTarget"];
  modelOptions: ChatModelPickerOption[];
  open?: boolean;
  targetGroups?: readonly ChatModelPickerTargetGroup[];
  selectedModelValue: string;
  /** Recorded user pin, so the footer never offers a reset for an inherited default. */
  sessionModelPinned: boolean;
  sessionKey: string;
  triggerModelLabel: string;
  triggerStatusLabel?: string;
  triggerLoading?: boolean;
  onModelSetup?: () => void;
  onOpen?: () => unknown;
  onOpenChange?: (open: boolean) => void;
  onModelSelect: (value: string, sessionKey: string) => Promise<unknown>;
  onTargetRetry?: (groupId: string) => unknown;
  onTargetSelect?: (groupId: string, value: string) => unknown;
  onRequestUpdate?: () => void;
};

function pickerMenu(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>(".chat-controls__model-menu")
    : null;
}

function visibleModelRows(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]")]
    .filter((row) => !row.hidden)
    .toSorted(
      (left, right) =>
        Number(left.dataset.chatModelRank ?? left.dataset.chatModelIndex ?? 0) -
        Number(right.dataset.chatModelRank ?? right.dataset.chatModelIndex ?? 0),
    );
}

function selectableModelRows(root: HTMLElement): HTMLButtonElement[] {
  return visibleModelRows(root).filter((row) => !row.disabled);
}

function ensureModelPickerIds(menu: HTMLElement): void {
  const details = menu.closest<HTMLDetailsElement>(".chat-controls__model-picker");
  const input = menu.querySelector<HTMLInputElement>("[data-chat-model-search]");
  const listbox = menu.querySelector<HTMLElement>("[data-chat-model-list]");
  if (!details || !input || !listbox) {
    return;
  }
  const prefix = details.dataset.chatModelPickerId ?? `chat-model-picker-${crypto.randomUUID()}`;
  details.dataset.chatModelPickerId = prefix;
  listbox.id = `${prefix}-listbox`;
  menu.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]").forEach((row, index) => {
    row.id = `${prefix}-option-${index}`;
  });
  input.setAttribute("aria-controls", listbox.id);
  input.setAttribute("aria-expanded", details.open ? "true" : "false");
}

function highlightModelRow(menu: HTMLElement, row: HTMLButtonElement | undefined): void {
  menu.querySelectorAll<HTMLElement>("[data-chat-model-option]").forEach((candidate) => {
    candidate.toggleAttribute("data-chat-model-highlighted", candidate === row);
  });
  const input = menu.querySelector<HTMLInputElement>("[data-chat-model-search]");
  if (row?.id) {
    input?.setAttribute("aria-activedescendant", row.id);
  } else {
    input?.removeAttribute("aria-activedescendant");
  }
}

// Numbers follow the filtered order because digit selection reads that same row list.
// A focused search input owns the digits instead (handleModelPickerKeydown bails on input
// targets), and the :focus-within rule in styles/chat/layout.css withdraws these keycaps there.
function updateModelShortcuts(menu: HTMLElement, rows: readonly HTMLButtonElement[]): void {
  menu.querySelectorAll<HTMLElement>("[data-chat-model-shortcut]").forEach((shortcut) => {
    shortcut.hidden = true;
    shortcut.removeAttribute("data-shortcut");
    shortcut.removeAttribute("data-chat-model-shortcut-number");
  });
  rows.slice(0, 9).forEach((row, index) => {
    const shortcut = row.querySelector<HTMLElement>("[data-chat-model-shortcut]");
    if (!shortcut) {
      return;
    }
    shortcut.hidden = false;
    shortcut.setAttribute("data-shortcut", String(index + 1));
    shortcut.setAttribute("data-chat-model-shortcut-number", String(index + 1));
  });
}

function modelMatchRank(row: HTMLButtonElement, query: string): number | null {
  const model = row.dataset.chatModelName ?? "";
  const keywords = row.dataset.chatModelKeywords ?? "";
  const provider = row.dataset.chatModelProviderLabel ?? "";
  if (model.startsWith(query)) {
    return 0;
  }
  if (model.includes(query)) {
    return 1;
  }
  if (keywords.includes(query)) {
    return 2;
  }
  if (provider.startsWith(query)) {
    return 3;
  }
  return provider.includes(query) ? 4 : null;
}

function updateModelSearch(input: HTMLInputElement): void {
  const menu = pickerMenu(input);
  if (!menu) {
    return;
  }
  ensureModelPickerIds(menu);
  const query = input.value.trim().toLocaleLowerCase();
  menu.toggleAttribute("data-chat-model-filtering", Boolean(query));
  const rows = [...menu.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]")];
  const matches: Array<{ row: HTMLButtonElement; score: number; index: number }> = [];
  rows.forEach((row, index) => {
    const score = query ? modelMatchRank(row, query) : 0;
    row.hidden = score === null;
    row.style.removeProperty("--chat-model-rank");
    delete row.dataset.chatModelRank;
    if (score !== null) {
      matches.push({ row, score, index });
    }
  });
  matches
    .toSorted((left, right) => left.score - right.score || left.index - right.index)
    .forEach(({ row }, rank) => {
      row.dataset.chatModelRank = String(rank);
      row.style.setProperty("--chat-model-rank", String(rank));
    });
  const visibleRows = visibleModelRows(menu);
  const selectableRows = selectableModelRows(menu);
  updateModelShortcuts(menu, selectableRows);
  const selected = selectableRows.find((row) => row.getAttribute("aria-selected") === "true");
  highlightModelRow(menu, query ? selectableRows[0] : (selected ?? selectableRows[0]));
  const empty = menu.querySelector<HTMLElement>("[data-chat-model-search-empty]");
  if (empty) {
    empty.hidden = !query || visibleRows.length > 0;
  }
}

function resetModelSearch(details: HTMLDetailsElement): void {
  const input = details.querySelector<HTMLInputElement>("[data-chat-model-search]");
  if (!input) {
    return;
  }
  input.value = "";
  updateModelSearch(input);
}

export function clearChatModelSearchOnEscape(event: KeyboardEvent): boolean {
  if (event.key !== "Escape") {
    return false;
  }
  const input = event
    .composedPath()
    .find(
      (target): target is HTMLInputElement =>
        target instanceof HTMLInputElement && target.matches("[data-chat-model-search]"),
    );
  if (!input?.value) {
    return false;
  }
  input.value = "";
  updateModelSearch(input);
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function handleModelSearchKeydown(event: KeyboardEvent): void {
  const input = event.currentTarget as HTMLInputElement;
  const menu = pickerMenu(input);
  if (!menu) {
    return;
  }
  const rows = selectableModelRows(menu);
  if (rows.length === 0) {
    return;
  }
  if (event.key === "Enter") {
    const highlighted = rows.find((row) => row.hasAttribute("data-chat-model-highlighted"));
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
  const currentIndex = rows.findIndex((row) => row.hasAttribute("data-chat-model-highlighted"));
  const offset = event.key === "ArrowDown" ? 1 : rows.length - 1;
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + offset) % rows.length;
  highlightModelRow(menu, rows[nextIndex]);
  rows[nextIndex]?.scrollIntoView?.({ block: "nearest" });
}

function handleModelPickerKeydown(event: KeyboardEvent): void {
  const details = event.currentTarget as HTMLDetailsElement;
  if (!details.open || event.target instanceof HTMLInputElement || !/^[1-9]$/u.test(event.key)) {
    return;
  }
  const row = selectableModelRows(details)[Number(event.key) - 1];
  event.preventDefault();
  row?.click();
}

export function renderChatModelPicker(params: ChatModelPickerParams) {
  const defaultModelOption = params.modelOptions.find((option) => option.isDefault);
  const activeModelOption =
    params.selectedModelValue === ""
      ? defaultModelOption
      : params.modelOptions.find((option) => option.value === params.selectedModelValue);
  const modelToolsUnavailable = activeModelOption?.supportsTools === false;
  const selectedContextWindowOption = params.contextWindow?.options.find(
    (option) => option.id === params.contextWindow?.selected,
  );
  const showContextWindowBadge =
    selectedContextWindowOption !== undefined &&
    params.contextWindow?.selected !== params.contextWindow?.defaultId;
  const triggerTitle = [
    params.triggerStatusLabel ?? params.triggerModelLabel,
    modelToolsUnavailable ? t("chat.modelControls.chatOnly") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // Brand mark ahead of the model name, and only when one actually ships:
  // hasProviderBrandIcon gates out the lettered fallback badge, so a provider
  // without a mark renders nothing rather than a placeholder — the trigger's gap
  // sits between boxes that exist, so nothing reserves space either. A status
  // label replaces the model name outright, and a provider mark next to
  // "Loading..." would claim an identity the trigger is not showing.
  const triggerProviderIcon =
    !params.triggerLoading &&
    !params.triggerStatusLabel &&
    activeModelOption &&
    hasProviderBrandIcon(activeModelOption.provider)
      ? renderProviderBrandIcon(activeModelOption.provider, {
          className: "chat-controls__trigger-provider-icon",
        })
      : nothing;
  const providerGroups = new Map<string, ChatModelPickerOption[]>();
  for (const option of params.modelOptions) {
    const existing = providerGroups.get(option.provider);
    if (existing) {
      existing.push(option);
    } else {
      providerGroups.set(option.provider, [option]);
    }
  }
  const orderedProviderGroups = [...providerGroups];
  const defaultProviderIndex = orderedProviderGroups.findIndex(
    ([provider]) => provider === defaultModelOption?.provider,
  );
  if (defaultProviderIndex > 0) {
    const [defaultGroup] = orderedProviderGroups.splice(defaultProviderIndex, 1);
    if (defaultGroup) {
      orderedProviderGroups.unshift(defaultGroup);
    }
  }
  const orderedOptions = orderedProviderGroups.flatMap(([, options]) => options);
  const optionIndex = new Map(orderedOptions.map((option, index) => [option.value, index]));
  const targetGroups = params.targetGroups ?? [];
  const targetOptionCount = targetGroups.reduce((count, group) => count + group.options.length, 0);
  const hasOptions =
    params.modelOptions.length + targetOptionCount > 0 ||
    targetGroups.some((group) => group.status !== "ready");
  const hasSelectableModelOptions = params.modelOptions.some((option) => !option.disabled);
  const commitModel = (value: string) => {
    if (params.modelSelectionLocked) {
      return;
    }
    void params.onModelSelect(value, params.sessionKey).finally(() => params.onRequestUpdate?.());
    params.onRequestUpdate?.();
  };
  const selectionTargetLabel =
    params.modelSelectionTarget === "session"
      ? t("chat.modelControls.selectionTargetSession")
      : params.modelSelectionTarget === "agent"
        ? t("chat.modelControls.selectionTargetAgent")
        : params.modelSelectionTarget === "global"
          ? t("chat.modelControls.selectionTargetGlobal")
          : undefined;
  const sessionPinProvenanceLabel = params.sessionModelPinned
    ? t("chat.modelControls.onlyForSession")
    : undefined;
  const selectModel = (entry: ChatModelPickerOption, event: MouseEvent) => {
    event.stopPropagation();
    if (params.disabled || params.modelSelectionLocked || entry.disabled) {
      event.preventDefault();
      return;
    }
    if (entry.commitValue !== params.selectedModelValue) {
      commitModel(entry.commitValue);
    }
    const details = (event.currentTarget as HTMLElement).closest<HTMLDetailsElement>("details");
    if (details) {
      details.open = false;
      if (event.detail === 0) {
        details.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
      }
    }
  };
  const selectTarget = (groupId: string, value: string, event: MouseEvent) => {
    event.stopPropagation();
    if (params.disabled || params.modelSelectionLocked) {
      event.preventDefault();
      return;
    }
    params.onTargetSelect?.(groupId, value);
    const details = (event.currentTarget as HTMLElement).closest<HTMLDetailsElement>("details");
    if (details) {
      details.open = false;
      if (event.detail === 0) {
        details.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
      }
    }
  };
  const highlightOption = (row: HTMLButtonElement) => {
    const menu = pickerMenu(row);
    if (menu) {
      highlightModelRow(menu, row);
    }
  };
  return html`
    <details
      class="chat-controls__inline-select chat-controls__model-picker"
      data-chat-autotype-shortcuts
      ?open=${params.open === true}
      @keydown=${handleModelPickerKeydown}
      @toggle=${(event: Event) => {
        const details = event.currentTarget as HTMLDetailsElement;
        params.onOpenChange?.(details.open);
        handleChatComposerDetailsToggle(event);
        syncChatPickerOverlay(details);
        if (!details.open) {
          resetModelSearch(details);
          return;
        }
        void params.onOpen?.();
        queueMicrotask(() => {
          const input = details.querySelector<HTMLInputElement>("[data-chat-model-search]");
          if (input) {
            updateModelSearch(input);
          }
        });
      }}
    >
      <summary
        class="chat-controls__inline-select-trigger chat-controls__model-trigger ${params.triggerLoading
          ? "chat-controls__model-trigger--loading"
          : ""} ${params.disabled ? "chat-controls__inline-select-trigger--disabled" : ""}"
        data-chat-model-select="true"
        data-chat-model-locked=${params.modelSelectionLocked ? "true" : "false"}
        data-chat-select-value=${params.selectedModelValue}
        data-chat-model-tools=${modelToolsUnavailable ? "unavailable" : "available"}
        aria-label=${`${t("chat.selectors.model")}: ${triggerTitle}`}
        aria-busy=${params.triggerLoading ? "true" : "false"}
        aria-disabled=${params.disabled ? "true" : "false"}
        title=${params.disabledReason ?? triggerTitle}
        @click=${(event: MouseEvent) => {
          if (params.disabled) {
            event.preventDefault();
            return;
          }
          (event.currentTarget as HTMLElement).focus({ preventScroll: true });
        }}
      >
        ${modelToolsUnavailable
          ? html`
              <openclaw-tooltip .content=${t("chat.modelControls.chatOnlyHelp")}>
                <span class="chat-controls__model-capability-badge" aria-hidden="true">
                  ${icons.alertTriangle}
                  <span>${t("chat.modelControls.chatOnly")}</span>
                </span>
              </openclaw-tooltip>
            `
          : nothing}
        ${triggerProviderIcon}
        <span class="chat-controls__inline-select-label">
          ${params.triggerLoading
            ? html`<span
                class="skeleton chat-controls__model-trigger-skeleton"
                aria-hidden="true"
              ></span>`
            : (params.triggerStatusLabel ?? params.triggerModelLabel)}
        </span>
        ${showContextWindowBadge
          ? html`
              <span
                class="chat-controls__locked-model-badge chat-controls__model-context-badge"
                data-chat-model-context-badge
              >
                ${selectedContextWindowOption.label}
              </span>
            `
          : nothing}
        <span class="chat-controls__inline-select-chevron" aria-hidden="true"
          >${icons.chevronUp}</span
        >
      </summary>
      <wa-popup data-anchored-overlay>
        <div
          class="chat-controls__inline-select-menu chat-controls__model-menu"
          aria-label=${t("chat.selectors.model")}
        >
          ${params.modelSelectionLocked
            ? html`
                <div
                  class="chat-controls__locked-model"
                  aria-label=${t("chat.selectors.modelLockedLabel")}
                >
                  <span class="chat-controls__inline-select-section-label">
                    ${t("chat.selectors.modelSection")}
                  </span>
                  <span class="chat-controls__locked-model-value">${params.triggerModelLabel}</span>
                  <span class="chat-controls__locked-model-badge">
                    ${t("chat.selectors.modelLocked")}
                  </span>
                </div>
              `
            : html`
                ${params.modelOptions.length > 0
                  ? html`
                      <div class="chat-controls__model-search-wrap">
                        ${icons.search}
                        <input
                          class="chat-controls__model-search"
                          data-chat-model-search="true"
                          type="search"
                          role="combobox"
                          aria-autocomplete="list"
                          autocomplete="off"
                          spellcheck="false"
                          placeholder=${t("chat.modelControls.searchModels")}
                          aria-label=${t("chat.modelControls.searchModels")}
                          ?disabled=${params.disabled}
                          @input=${(event: InputEvent) =>
                            updateModelSearch(event.currentTarget as HTMLInputElement)}
                          @keydown=${handleModelSearchKeydown}
                        />
                      </div>
                    `
                  : nothing}
                ${renderChatModelCatalogState(
                  params.modelCatalogState,
                  params.modelOptions.length > 0,
                  hasSelectableModelOptions,
                  params.onModelSetup,
                )}
                ${hasOptions
                  ? html`
                      <div
                        class="chat-controls__model-options"
                        data-chat-model-list="true"
                        role="listbox"
                        aria-label=${t("chat.selectors.model")}
                      >
                        ${repeat(
                          orderedProviderGroups,
                          ([provider]) => provider,
                          ([provider, options]) => html`
                            <section
                              class="chat-controls__provider-model-group"
                              data-chat-model-provider-group=${provider}
                              aria-label=${t("chat.modelControls.providerModels", {
                                provider: providerDisplayLabel(provider),
                              })}
                            >
                              <div
                                class="chat-controls__provider-heading"
                                data-chat-model-provider=${provider}
                              >
                                ${renderChatModelProviderIcon(provider)}
                                <span>${providerDisplayLabel(provider)}</span>
                              </div>
                              ${repeat(
                                options,
                                (entry) => entry.value,
                                (entry) =>
                                  renderChatModelPickerOption({
                                    disabled: params.disabled,
                                    entry,
                                    index: optionIndex.get(entry.value) ?? 0,
                                    selectedModelValue: params.selectedModelValue,
                                    onHighlight: highlightOption,
                                    onSelect: selectModel,
                                    onModelSetup: params.onModelSetup,
                                  }),
                              )}
                            </section>
                          `,
                        )}
                        ${repeat(
                          targetGroups,
                          (group) => group.id,
                          (group) => html`
                            <section
                              class="chat-controls__provider-model-group"
                              data-chat-model-target-group=${group.id}
                              aria-label=${group.label}
                            >
                              <div class="chat-controls__provider-heading">
                                <span
                                  class="chat-controls__provider-icon chat-controls__target-icon"
                                  aria-hidden="true"
                                  >${icons.terminal}</span
                                >
                                <span>${group.label}</span>
                              </div>
                              ${group.status === "ready"
                                ? nothing
                                : renderChatModelCatalogState(
                                    { hasSnapshot: false, status: group.status },
                                    false,
                                    false,
                                    undefined,
                                    group.errorLabel,
                                    params.onTargetRetry
                                      ? {
                                          disabled: params.disabled,
                                          groupId: group.id,
                                          onRetry: params.onTargetRetry,
                                        }
                                      : undefined,
                                  )}
                              ${repeat(
                                group.options,
                                (entry) => entry.value,
                                (entry, targetIndex) =>
                                  renderChatModelPickerTargetOption({
                                    disabled: params.disabled,
                                    entry,
                                    groupId: group.id,
                                    groupLabel: group.label,
                                    index: orderedOptions.length + targetIndex,
                                    onHighlight: highlightOption,
                                    onSelect: selectTarget,
                                  }),
                              )}
                            </section>
                          `,
                        )}
                      </div>
                      <div
                        class="chat-controls__model-search-empty"
                        data-chat-model-search-empty
                        hidden
                      >
                        ${t("chat.modelControls.noMatchingModels")}
                      </div>
                      ${params.contextWindow
                        ? renderContextWindowControl(params.contextWindow, params.sessionKey)
                        : nothing}
                      ${selectionTargetLabel ||
                      sessionPinProvenanceLabel ||
                      (params.sessionModelPinned && params.modelOptions.length > 0)
                        ? html`<footer class="chat-controls__model-provenance">
                            ${selectionTargetLabel || sessionPinProvenanceLabel
                              ? html`<span>
                                  ${selectionTargetLabel
                                    ? html`<span data-chat-model-selection-target>
                                        ${selectionTargetLabel}
                                      </span>`
                                    : nothing}
                                  ${selectionTargetLabel && sessionPinProvenanceLabel
                                    ? html`<br />`
                                    : nothing}
                                  ${sessionPinProvenanceLabel
                                    ? html`<span data-chat-model-pin-provenance>
                                        ${sessionPinProvenanceLabel}
                                      </span>`
                                    : nothing}
                                </span>`
                              : nothing}
                            ${params.sessionModelPinned && params.modelOptions.length > 0
                              ? html`<button
                                  class="chat-controls__model-reset"
                                  data-chat-model-reset="true"
                                  type="button"
                                  ?disabled=${params.disabled}
                                  @click=${(event: MouseEvent) => {
                                    event.stopPropagation();
                                    if (params.disabled) {
                                      event.preventDefault();
                                      return;
                                    }
                                    commitModel("");
                                    const resetButton = event.currentTarget;
                                    if (!(resetButton instanceof HTMLElement)) {
                                      return;
                                    }
                                    const details =
                                      resetButton.closest<HTMLDetailsElement>("details");
                                    if (details) {
                                      details.open = false;
                                      if (event.detail === 0) {
                                        details
                                          .querySelector<HTMLElement>("summary")
                                          ?.focus({ preventScroll: true });
                                      }
                                    }
                                  }}
                                >
                                  ${t("chat.modelControls.useDefaultModel", {
                                    model: params.defaultModelLabel,
                                  })}
                                </button>`
                              : nothing}
                          </footer>`
                        : nothing}
                    `
                  : nothing}
              `}
        </div>
      </wa-popup>
    </details>
  `;
}
