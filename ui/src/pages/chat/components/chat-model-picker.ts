import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
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
import {
  handleModelPickerKeydown,
  handleModelSearchKeydown,
  highlightModelRow,
  pickerMenu,
  resetModelSearch,
  syncChatModelSearch,
  updateModelSearch,
} from "./chat-model-picker-search.ts";
import { handleChatComposerDetailsToggle, syncChatPickerOverlay } from "./chat-picker-overlay.ts";

export type { ChatModelCatalogState } from "./chat-model-catalog-state.ts";

type ChatModelPickerParams = {
  accountControl?: unknown;
  contextWindow?: ChatContextWindowControlParams;
  defaultModelLabel: string;
  disabled: boolean;
  disabledReason?: string;
  modelCatalogState?: ChatModelCatalogState;
  modelSelectionLocked: boolean;
  selectionScopeDescription?: string;
  modelOptions: ChatModelPickerOption[];
  open?: boolean;
  targetGroups?: readonly ChatModelPickerTargetGroup[];
  selectedModelValue: string;
  /** Recorded user pin, so the footer never offers a reset for an inherited default. */
  sessionModelPinned: boolean;
  sessionKey: string;
  triggerModelLabel: string;
  triggerModelValue?: string;
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

export function renderChatModelPicker(params: ChatModelPickerParams) {
  const defaultModelOption = params.modelOptions.find((option) => option.isDefault);
  const activeModelOption =
    params.selectedModelValue === ""
      ? defaultModelOption
      : params.modelOptions.find((option) => option.value === params.selectedModelValue);
  const triggerModelOption = params.triggerModelValue
    ? params.modelOptions.find((option) => option.value === params.triggerModelValue)
    : activeModelOption;
  const modelToolsUnavailable = triggerModelOption?.supportsTools === false;
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
    triggerModelOption &&
    hasProviderBrandIcon(triggerModelOption.provider)
      ? renderProviderBrandIcon(triggerModelOption.provider, {
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
      ${ref((details) => syncChatModelSearch(details))}
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
        syncChatModelSearch(details);
      }}
    >
      <summary
        class="chat-controls__inline-select-trigger chat-controls__model-trigger ${
          params.triggerLoading ? "chat-controls__model-trigger--loading" : ""
        } ${params.disabled ? "chat-controls__inline-select-trigger--disabled" : ""}"
        data-chat-model-select="true"
        data-chat-model-locked=${params.modelSelectionLocked ? "true" : "false"}
        data-chat-select-value=${params.selectedModelValue}
        data-chat-model-tools=${modelToolsUnavailable ? "unavailable" : "available"}
        aria-label=${`${t("chat.selectors.model")}: ${triggerTitle}${
          params.selectionScopeDescription ? `. ${params.selectionScopeDescription}` : ""
        }`}
        aria-busy=${params.triggerLoading ? "true" : "false"}
        aria-disabled=${params.disabled ? "true" : "false"}
        title=${params.disabledReason?.trim() || params.selectionScopeDescription || triggerTitle}
        @click=${(event: MouseEvent) => {
          if (params.disabled) {
            event.preventDefault();
            return;
          }
          (event.currentTarget as HTMLElement).focus({ preventScroll: true });
        }}
      >
        ${
          modelToolsUnavailable
            ? html`
                <openclaw-tooltip .content=${t("chat.modelControls.chatOnlyHelp")}>
                  <span class="chat-controls__model-capability-badge" aria-hidden="true">
                    ${icons.alertTriangle}
                    <span>${t("chat.modelControls.chatOnly")}</span>
                  </span>
                </openclaw-tooltip>
              `
            : nothing
        }
        ${triggerProviderIcon}
        <span class="chat-controls__inline-select-label">
          ${
            params.triggerLoading
              ? html`<span
                  class="skeleton chat-controls__model-trigger-skeleton"
                  aria-hidden="true"
                ></span>`
              : (params.triggerStatusLabel ?? params.triggerModelLabel)
          }
        </span>
        ${
          showContextWindowBadge
            ? html`
                <span
                  class="chat-controls__locked-model-badge chat-controls__model-context-badge"
                  data-chat-model-context-badge
                >
                  ${selectedContextWindowOption.label}
                </span>
              `
            : nothing
        }
        <span class="chat-controls__inline-select-chevron" aria-hidden="true"
          >${icons.chevronUp}</span
        >
      </summary>
      <wa-popup data-anchored-overlay>
        <div
          class="chat-controls__inline-select-menu chat-controls__model-menu"
          aria-label=${t("chat.selectors.model")}
        >
          ${
            params.modelSelectionLocked
              ? html`
                  <div
                    class="chat-controls__locked-model"
                    aria-label=${t("chat.selectors.modelLockedLabel")}
                  >
                    <span class="chat-controls__inline-select-section-label">
                      ${t("chat.selectors.modelSection")}
                    </span>
                    <span class="chat-controls__locked-model-value"
                      >${params.triggerModelLabel}</span
                    >
                    <span class="chat-controls__locked-model-badge">
                      ${t("chat.selectors.modelLocked")}
                    </span>
                  </div>
                `
              : html`
                  ${
                    params.modelOptions.length > 0
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
                      : nothing
                  }
                  ${renderChatModelCatalogState(
                    params.modelCatalogState,
                    params.modelOptions.length > 0,
                    hasSelectableModelOptions,
                    params.onModelSetup,
                  )}
                  ${
                    hasOptions
                      ? html`
                          <div class="chat-controls__model-options">
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
                                    <span class="chat-controls__provider-label"
                                      >${providerDisplayLabel(provider)}</span
                                    >
                                    ${
                                      params.onModelSetup
                                        ? html`<button
                                            class="chat-controls__provider-settings"
                                            data-chat-model-provider-settings
                                            type="button"
                                            aria-label=${t("chat.modelControls.configureModels")}
                                            @click=${(event: MouseEvent) => {
                                              event.stopPropagation();
                                              params.onModelSetup?.();
                                            }}
                                          >
                                            ${icons.settings}
                                          </button>`
                                        : nothing
                                    }
                                  </div>
                                  <div
                                    class="chat-controls__provider-model-list"
                                    data-chat-model-list="true"
                                    role="listbox"
                                    aria-label=${t("chat.modelControls.providerModels", {
                                      provider: providerDisplayLabel(provider),
                                    })}
                                  >
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
                                  </div>
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
                                  ${
                                    group.status === "ready"
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
                                        )
                                  }
                                  <div
                                    class="chat-controls__provider-model-list"
                                    data-chat-model-list="true"
                                    role="listbox"
                                    aria-label=${group.label}
                                  >
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
                                  </div>
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
                          ${
                            params.contextWindow
                              ? renderContextWindowControl(params.contextWindow, params.sessionKey)
                              : nothing
                          }
                          ${
                            params.sessionModelPinned && params.modelOptions.length > 0
                              ? html`<footer class="chat-controls__model-provenance">
                                  <button
                                    class="btn btn--ghost btn--xs chat-controls__model-reset"
                                    data-chat-model-reset="true"
                                    type="button"
                                    title=${t("chat.modelControls.useDefaultModel", {
                                      model: params.defaultModelLabel,
                                    })}
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
                                    ${t("chat.modelControls.resetSessionModel")}
                                  </button>
                                </footer>`
                              : nothing
                          }
                        `
                      : nothing
                  }
                `
          }
          ${params.accountControl ?? nothing}
        </div>
      </wa-popup>
    </details>
  `;
}
