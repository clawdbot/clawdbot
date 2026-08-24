import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import { providerDisplayLabel } from "../../../components/provider-icon.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import {
  type ChatContextWindowControlParams,
  renderContextWindowControl,
} from "./chat-context-window-control.ts";
import {
  renderChatModelPickerOption,
  renderChatModelPickerTargetOption,
  renderChatModelProviderIcon,
  type ChatModelPickerOption,
  type ChatModelPickerTargetGroup,
} from "./chat-model-picker-options.ts";
import { syncChatPickerOverlay } from "./chat-picker-overlay.ts";

export type ChatModelCatalogState = {
  hasSnapshot: boolean;
  status: "idle" | "loading" | "refreshing" | "ready" | "error" | "offline";
};

type ChatModelPickerParams = {
  contextWindow?: ChatContextWindowControlParams;
  disabled: boolean;
  disabledReason?: string;
  modelCatalogState?: ChatModelCatalogState;
  modelSelectionLocked: boolean;
  modelOptions: ChatModelPickerOption[];
  targetGroups?: readonly ChatModelPickerTargetGroup[];
  selectedModelValue: string;
  sessionKey: string;
  triggerModelLabel: string;
  triggerStatusLabel?: string;
  onModelSetup?: () => void;
  onOpen?: () => unknown;
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

function updateModelShortcuts(menu: HTMLElement, rows: readonly HTMLButtonElement[]): void {
  menu.querySelectorAll<HTMLElement>("[data-chat-model-shortcut]").forEach((shortcut) => {
    shortcut.hidden = true;
    shortcut.removeAttribute("data-chat-model-shortcut-number");
  });
  rows.slice(0, 9).forEach((row, index) => {
    const shortcut = row.querySelector<HTMLElement>("[data-chat-model-shortcut]");
    if (!shortcut) {
      return;
    }
    shortcut.hidden = false;
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

function renderCatalogState(
  state: ChatModelCatalogState | undefined,
  hasOptions: boolean,
  hasSelectableOptions: boolean,
  onModelSetup?: () => void,
  errorLabel = t("chat.modelControls.modelsUnavailable"),
  retryTarget?: { disabled: boolean; groupId: string; onRetry: (groupId: string) => unknown },
) {
  if (!state || (state.status === "ready" && hasSelectableOptions)) {
    return nothing;
  }
  if (state.status === "error" && hasOptions) {
    return nothing;
  }
  const label =
    state.status === "offline"
      ? t("common.offline")
      : state.status === "refreshing"
        ? t("chat.modelControls.refreshingModels")
        : state.status === "error"
          ? errorLabel
          : state.status === "ready"
            ? hasOptions
              ? `${t("modelSetup.failure.auth")}. ${t("modelSetup.failureGuidance.auth")}`
              : t("chat.modelControls.noModelsAvailable")
            : t("chat.modelControls.loadingModels");
  return html`
    <div
      class="chat-controls__model-catalog-state ${hasOptions
        ? ""
        : "chat-controls__model-catalog-state--empty"}"
      data-chat-model-catalog-state=${state.status}
      aria-live="polite"
    >
      <span class="chat-controls__model-catalog-state-label">
        ${state.status === "error" ? icons.alertTriangle : nothing}
        <span>${label}</span>
      </span>
      ${state.status === "error" && retryTarget
        ? html`
            <button
              class="chat-controls__model-catalog-action"
              data-chat-model-target-retry=${retryTarget.groupId}
              type="button"
              ?disabled=${retryTarget.disabled}
              @click=${(event: MouseEvent) => {
                event.stopPropagation();
                retryTarget.onRetry(retryTarget.groupId);
              }}
            >
              ${t("common.retry")}
            </button>
          `
        : nothing}
      ${state.status === "ready" && !hasSelectableOptions && onModelSetup
        ? html`
            <button
              class="chat-controls__model-catalog-action"
              data-chat-model-setup="true"
              type="button"
              @click=${(event: MouseEvent) => {
                event.stopPropagation();
                onModelSetup();
              }}
            >
              ${t("modelSetup.connectionFailure.action")}
            </button>
          `
        : nothing}
    </div>
  `;
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
      details.querySelector<HTMLElement>("summary")?.focus();
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
      details.querySelector<HTMLElement>("summary")?.focus();
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
      @keydown=${handleModelPickerKeydown}
      @toggle=${(event: Event) => {
        const details = event.currentTarget as HTMLDetailsElement;
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
        class="chat-controls__inline-select-trigger chat-controls__model-trigger ${params.disabled
          ? "chat-controls__inline-select-trigger--disabled"
          : ""}"
        data-chat-model-select="true"
        data-chat-model-locked=${params.modelSelectionLocked ? "true" : "false"}
        data-chat-select-value=${params.selectedModelValue}
        data-chat-model-tools=${modelToolsUnavailable ? "unavailable" : "available"}
        aria-label=${`${t("chat.selectors.model")}: ${triggerTitle}`}
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
        <span class="chat-controls__inline-select-label">
          ${params.triggerStatusLabel ?? params.triggerModelLabel}
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
                ${renderCatalogState(
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
                                : renderCatalogState(
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
                      ${params.modelOptions.length > 0 && params.selectedModelValue !== ""
                        ? html`<footer class="chat-controls__model-provenance">
                            <span>${t("chat.modelControls.sessionOverride")}</span>
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
