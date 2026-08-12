import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import {
  formatRawProviderLabel,
  providerDisplayLabel,
  renderProviderBrandIcon,
} from "../../../components/provider-icon.ts";
import { t } from "../../../i18n/index.ts";
import { formatContextTokenCapacity } from "../../../lib/format.ts";

export type ChatModelCatalogState = {
  hasSnapshot: boolean;
  onRetry?: () => void;
  status: "idle" | "loading" | "refreshing" | "ready" | "error";
};

export type ChatModelPickerOption = {
  agentRuntimeId?: string;
  commitValue: string;
  contextWindow?: number;
  isDefault: boolean;
  label: string;
  provider: string;
  supportsTools?: boolean;
  value: string;
};

export type ChatModelPickerTargetGroup = {
  id: string;
  label: string;
  options: readonly { label: string; value: string }[];
};

// Known models.list runtime ids; mirrors src/status/agent-runtime-label.ts,
// which cannot be imported here (it drags terminal sanitizers into the bundle).
const AGENT_RUNTIME_LABELS: Readonly<Record<string, string>> = {
  "claude-cli": "Claude CLI",
  codex: "Codex",
  "codex-cli": "Codex",
  "google-gemini-cli": "Gemini CLI",
  openclaw: "OpenClaw",
};

function formatAgentRuntimeLabel(id: string): string {
  const normalized = id.trim().toLowerCase();
  return (
    AGENT_RUNTIME_LABELS[normalized] ??
    `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
  );
}

type ChatModelPickerParams = {
  defaultModelLabel: string;
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
  onModelSelect: (value: string, sessionKey: string) => Promise<unknown>;
  onTargetSelect?: (groupId: string, value: string) => unknown;
  onRequestUpdate?: () => void;
};

function renderProviderIcon(provider: string) {
  return renderProviderBrandIcon(provider, { className: "chat-controls__provider-icon" });
}

function formatModelLabel(option: ChatModelPickerOption): string {
  const prefixes = [
    formatRawProviderLabel(option.provider),
    providerDisplayLabel(option.provider),
  ].toSorted((left, right) => right.length - left.length);
  for (const prefix of prefixes) {
    if (option.label.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) {
      return option.label.slice(prefix.length + 1);
    }
  }
  return option.label;
}

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
  const provider = row.dataset.chatModelProviderLabel ?? "";
  if (model.startsWith(query)) {
    return 0;
  }
  if (model.includes(query)) {
    return 1;
  }
  if (provider.startsWith(query)) {
    return 2;
  }
  return provider.includes(query) ? 3 : null;
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
  updateModelShortcuts(menu, visibleRows);
  const selected = visibleRows.find((row) => row.getAttribute("aria-selected") === "true");
  highlightModelRow(menu, query ? visibleRows[0] : (selected ?? visibleRows[0]));
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
  const rows = visibleModelRows(menu);
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
  const row = visibleModelRows(details)[Number(event.key) - 1];
  event.preventDefault();
  row?.click();
}

function renderCatalogState(state: ChatModelCatalogState | undefined, hasOptions: boolean) {
  if (!state || (state.status === "ready" && hasOptions)) {
    return nothing;
  }
  const label =
    state.status === "refreshing"
      ? t("chat.modelControls.refreshingModels")
      : state.status === "error"
        ? state.hasSnapshot
          ? t("chat.modelControls.modelsRefreshFailed")
          : t("chat.modelControls.modelsUnavailable")
        : state.status === "ready"
          ? t("chat.modelControls.noModelsAvailable")
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
      ${state.status === "error" && state.onRetry
        ? html`
            <button
              class="chat-controls__model-catalog-retry"
              data-chat-model-catalog-retry="true"
              type="button"
              @click=${(event: MouseEvent) => {
                event.stopPropagation();
                state.onRetry?.();
              }}
            >
              ${icons.refresh}
              <span>${t("common.retry")}</span>
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
  const triggerTitle = [
    params.triggerStatusLabel ?? params.triggerModelLabel,
    modelToolsUnavailable ? t("chat.modelControls.chatOnly") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const triggerMeta = activeModelOption?.contextWindow
    ? formatContextTokenCapacity(activeModelOption.contextWindow)
    : "";
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
  const hasOptions = params.modelOptions.length + targetOptionCount > 0;
  const commitModel = (value: string) => {
    if (params.modelSelectionLocked) {
      return;
    }
    void params.onModelSelect(value, params.sessionKey).finally(() => params.onRequestUpdate?.());
    params.onRequestUpdate?.();
  };
  const selectModel = (entry: ChatModelPickerOption, event: MouseEvent) => {
    event.stopPropagation();
    if (params.disabled || params.modelSelectionLocked) {
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
  return html`
    <details
      class="chat-controls__inline-select chat-controls__model-picker"
      @keydown=${handleModelPickerKeydown}
      @toggle=${(event: Event) => {
        const details = event.currentTarget as HTMLDetailsElement;
        if (!details.open) {
          resetModelSearch(details);
          return;
        }
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
        ${params.triggerStatusLabel || !triggerMeta
          ? nothing
          : html`<span class="chat-controls__trigger-meta">${triggerMeta}</span>`}
      </summary>
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
              ${renderCatalogState(params.modelCatalogState, params.modelOptions.length > 0)}
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
                              ${renderProviderIcon(provider)}
                              <span>${providerDisplayLabel(provider)}</span>
                            </div>
                            ${repeat(
                              options,
                              (entry) => entry.value,
                              (entry) => {
                                const selected =
                                  entry.value === params.selectedModelValue ||
                                  (entry.isDefault && params.selectedModelValue === "");
                                const modelLabel = formatModelLabel(entry);
                                const modelMeta = [
                                  entry.contextWindow
                                    ? formatContextTokenCapacity(entry.contextWindow)
                                    : "",
                                  entry.supportsTools === false
                                    ? t("chat.modelControls.chatOnly")
                                    : "",
                                  entry.agentRuntimeId
                                    ? formatAgentRuntimeLabel(entry.agentRuntimeId)
                                    : "",
                                ]
                                  .filter(Boolean)
                                  .join(" · ");
                                const index = optionIndex.get(entry.value) ?? 0;
                                return html`
                                  <button
                                    class="chat-controls__inline-select-option chat-controls__model-option ${selected
                                      ? "chat-controls__inline-select-option--selected"
                                      : ""}"
                                    data-chat-model-option=${entry.value}
                                    data-chat-model-default=${entry.isDefault ? "true" : nothing}
                                    data-chat-model-index=${index}
                                    data-chat-model-name=${modelLabel.toLocaleLowerCase()}
                                    data-chat-model-provider-label=${providerDisplayLabel(
                                      entry.provider,
                                    ).toLocaleLowerCase()}
                                    role="option"
                                    aria-selected=${selected ? "true" : "false"}
                                    type="button"
                                    ?disabled=${params.disabled}
                                    @mouseenter=${(event: MouseEvent) => {
                                      const menu = pickerMenu(event.currentTarget);
                                      if (menu) {
                                        highlightModelRow(
                                          menu,
                                          event.currentTarget as HTMLButtonElement,
                                        );
                                      }
                                    }}
                                    @click=${(event: MouseEvent) => selectModel(entry, event)}
                                  >
                                    <span class="chat-controls__model-option-provider">
                                      ${renderProviderIcon(entry.provider)}
                                    </span>
                                    <span class="chat-controls__model-option-copy">
                                      <span class="chat-controls__model-option-title">
                                        <span class="chat-controls__model-option-name"
                                          >${modelLabel}</span
                                        >
                                        ${entry.isDefault
                                          ? html`<span
                                              class="chat-controls__model-state-label chat-controls__model-state-label--default"
                                              >${t("chat.modelControls.default")}</span
                                            >`
                                          : nothing}
                                      </span>
                                      ${modelMeta
                                        ? html`<span class="chat-controls__model-option-meta"
                                            >${modelMeta}</span
                                          >`
                                        : nothing}
                                    </span>
                                    <span class="chat-controls__model-option-action">
                                      ${selected
                                        ? html`<span
                                            class="chat-controls__inline-select-check"
                                            aria-hidden="true"
                                            >${icons.check}</span
                                          >`
                                        : html`<kbd
                                            data-chat-model-shortcut="true"
                                            aria-hidden="true"
                                            hidden
                                          ></kbd>`}
                                    </span>
                                  </button>
                                `;
                              },
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
                            ${repeat(
                              group.options,
                              (entry) => entry.value,
                              (entry, targetIndex) => html`
                                <button
                                  class="chat-controls__inline-select-option chat-controls__model-option"
                                  data-chat-model-option=${`target:${group.id}:${entry.value}`}
                                  data-chat-model-target=${entry.value}
                                  data-chat-model-index=${orderedOptions.length + targetIndex}
                                  data-chat-model-name=${entry.label.toLocaleLowerCase()}
                                  data-chat-model-provider-label=${group.label.toLocaleLowerCase()}
                                  role="option"
                                  aria-selected="false"
                                  type="button"
                                  ?disabled=${params.disabled}
                                  @mouseenter=${(event: MouseEvent) => {
                                    const menu = pickerMenu(event.currentTarget);
                                    if (menu) {
                                      highlightModelRow(
                                        menu,
                                        event.currentTarget as HTMLButtonElement,
                                      );
                                    }
                                  }}
                                  @click=${(event: MouseEvent) =>
                                    selectTarget(group.id, entry.value, event)}
                                >
                                  <span
                                    class="chat-controls__model-option-provider chat-controls__target-icon"
                                    aria-hidden="true"
                                    >${icons.terminal}</span
                                  >
                                  <span class="chat-controls__model-option-copy">
                                    <span class="chat-controls__model-option-title">
                                      <span class="chat-controls__model-option-name"
                                        >${entry.label}</span
                                      >
                                    </span>
                                  </span>
                                  <span class="chat-controls__model-option-action">
                                    <kbd
                                      data-chat-model-shortcut="true"
                                      aria-hidden="true"
                                      hidden
                                    ></kbd>
                                  </span>
                                </button>
                              `,
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
                    ${params.modelOptions.length > 0
                      ? html`<footer class="chat-controls__model-provenance">
                          ${params.selectedModelValue === ""
                            ? html`<span class="chat-controls__model-provenance-value--inherit">
                                ${t("chat.modelControls.usingDefault")}
                              </span>`
                            : html`
                                <span>${t("chat.modelControls.sessionOverride")}</span>
                                <openclaw-tooltip
                                  .content=${t("chat.modelControls.resetToDefault", {
                                    model: params.defaultModelLabel,
                                  })}
                                >
                                  <button
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
                                      const details = (
                                        event.currentTarget as HTMLElement
                                      ).closest<HTMLDetailsElement>("details");
                                      if (details) {
                                        details.open = false;
                                        details.querySelector<HTMLElement>("summary")?.focus();
                                      }
                                    }}
                                  >
                                    ${t("chat.modelControls.useDefault")}
                                  </button>
                                </openclaw-tooltip>
                              `}
                        </footer>`
                      : nothing}
                  `
                : nothing}
            `}
      </div>
    </details>
  `;
}
