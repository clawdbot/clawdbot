import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import type {
  ChatFastModeSelectState,
  ChatFastModeSelectValue,
} from "../../../lib/chat/model-select-state.ts";
import {
  normalizeThinkingOptionValue,
  type ChatThinkingSelectState,
} from "../../../lib/chat/thinking.ts";
import { handleChatComposerDetailsToggle, syncChatPickerOverlay } from "./chat-picker-overlay.ts";

type ChatEffortPickerParams = {
  disabled: boolean;
  disabledReason?: string;
  fastMode: ChatFastModeSelectState;
  sessionKey: string;
  showFastMode: boolean;
  thinkingDisabled: boolean;
  thinking: ChatThinkingSelectState;
  onFastModeSelect: (value: ChatFastModeSelectValue, sessionKey: string) => Promise<unknown>;
  onRequestUpdate?: () => void;
  onThinkingSelect: (value: string, sessionKey: string) => Promise<unknown>;
  reserved?: boolean;
};

function formatEffortLabel(label: string): string {
  return label.replace(/^Inherited:\s*/u, "");
}

export function renderChatEffortPicker(params: ChatEffortPickerParams) {
  const sliderStops = params.thinking.options;
  const showReasoning = sliderStops.length > 0;
  if (!params.reserved && !showReasoning && (!params.showFastMode || !params.fastMode.supported)) {
    return nothing;
  }
  const selection = params.thinking.selection;
  const rankedThinkingStops = sliderStops.filter(
    (stop) => normalizeThinkingOptionValue(stop.value) !== "off",
  );
  const rankedThinkingIndex = rankedThinkingStops.findIndex(
    (stop) => stop.value === selection.value,
  );
  const effortFill =
    rankedThinkingIndex >= 0 && rankedThinkingStops.length > 0
      ? (rankedThinkingIndex + 1) / rankedThinkingStops.length
      : 0;
  const effortIsOff = normalizeThinkingOptionValue(selection.value) === "off";
  const hasThinkingOverride = selection.source === "override";
  const selectedThinkingValue = hasThinkingOverride ? selection.value : "";
  const sliderIndex = selection.kind === "anchored" ? selection.index : 0;
  const sliderUnanchored = selection.kind === "unanchored";
  const sliderFillPercent = (index: number) =>
    sliderStops.length > 1 ? (index / (sliderStops.length - 1)) * 100 : 0;
  const defaultLevelLabel = formatEffortLabel(params.thinking.inherited.displayLabel);
  const reasoningValueText = formatEffortLabel(selection.displayLabel);
  const reasoningValueLabel = hasThinkingOverride
    ? reasoningValueText
    : t("chat.modelControls.defaultWithLevel", { level: defaultLevelLabel });
  const triggerLabel = showReasoning ? reasoningValueText : t("chat.modelControls.fastMode");
  const triggerTitle = params.fastMode.active
    ? `${triggerLabel} · ${t("chat.modelControls.fastMode")}`
    : triggerLabel;
  const commitThinking = (value: string) => {
    void params
      .onThinkingSelect(value, params.sessionKey)
      .finally(() => params.onRequestUpdate?.());
    params.onRequestUpdate?.();
  };
  const commitFastMode = (value: ChatFastModeSelectValue) => {
    void params
      .onFastModeSelect(value, params.sessionKey)
      .finally(() => params.onRequestUpdate?.());
    params.onRequestUpdate?.();
  };
  const resetSliderPreview = (input: HTMLInputElement, restoreValue = false) => {
    if (restoreValue) {
      input.value = String(sliderIndex);
    }
    input.style.setProperty("--reasoning-fill", `${sliderFillPercent(sliderIndex)}%`);
    input.setAttribute("aria-valuetext", reasoningValueLabel);
    const panel = input.closest(".chat-controls__reasoning-panel");
    panel?.querySelectorAll<HTMLElement>("[data-chat-thinking-preview-index]").forEach((label) => {
      label.hidden = true;
    });
    const committedLabel = panel?.querySelector<HTMLElement>(
      "[data-chat-thinking-preview-committed]",
    );
    if (committedLabel) {
      committedLabel.hidden = false;
    }
  };
  const onSliderDrag = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const stop = sliderStops[Number(input.value)];
    if (!stop) {
      return;
    }
    input.style.setProperty("--reasoning-fill", `${sliderFillPercent(Number(input.value))}%`);
    input.setAttribute("aria-valuetext", formatEffortLabel(stop.label));
    const panel = input.closest(".chat-controls__reasoning-panel");
    panel?.querySelectorAll<HTMLElement>("[data-chat-thinking-preview-index]").forEach((label) => {
      label.hidden = label.dataset.chatThinkingPreviewIndex !== input.value;
    });
    const committedLabel = panel?.querySelector<HTMLElement>(
      "[data-chat-thinking-preview-committed]",
    );
    if (committedLabel) {
      committedLabel.hidden = true;
    }
  };
  const onSliderCommit = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const stop = sliderStops[Number(input.value)];
    resetSliderPreview(input);
    if (params.thinkingDisabled || !stop || stop.value === selectedThinkingValue) {
      return;
    }
    commitThinking(stop.value);
  };
  const onUnanchoredSliderClick = (event: MouseEvent) => {
    const input = event.currentTarget as HTMLInputElement;
    if (sliderUnanchored && Number(input.value) === sliderIndex) {
      onSliderCommit(event);
    }
  };
  const onUnanchoredSliderKeyDown = (event: KeyboardEvent) => {
    if (sliderUnanchored && ["Home", "ArrowLeft", "ArrowDown", "PageDown"].includes(event.key)) {
      onSliderCommit(event);
    }
  };
  const onlyStop = sliderStops.length === 1 ? sliderStops[0] : undefined;
  const onlyStopSelected = selection.kind === "anchored" && selection.index === 0;
  return html`
    <details
      class="chat-controls__inline-select chat-controls__effort-picker ${params.reserved
        ? "chat-controls__effort-picker--reserved"
        : ""}"
      aria-hidden=${String(params.reserved === true)}
      ?inert=${params.reserved === true}
      @toggle=${(event: Event) => {
        const details = event.currentTarget as HTMLDetailsElement;
        handleChatComposerDetailsToggle(event);
        syncChatPickerOverlay(details);
        if (!details.open) {
          return;
        }
        if (!details.hasAttribute("data-chat-focus-panel")) {
          return;
        }
        details.removeAttribute("data-chat-focus-panel");
        queueMicrotask(() => {
          details
            .querySelector<HTMLElement>(
              "[data-chat-thinking-slider]:not(:disabled), [data-chat-thinking-option]:not(:disabled), [data-chat-speed-toggle]:not(:disabled)",
            )
            ?.focus({ preventScroll: true });
        });
      }}
    >
      <summary
        class="chat-controls__inline-select-trigger chat-controls__effort-trigger ${params.fastMode
          .active
          ? "chat-controls__effort-trigger--fast"
          : ""} ${params.disabled ? "chat-controls__inline-select-trigger--disabled" : ""}"
        data-chat-thinking-select="true"
        data-chat-thinking-value=${selectedThinkingValue}
        data-chat-thinking-disabled=${params.thinkingDisabled ? "true" : "false"}
        data-chat-fast-mode=${params.fastMode.active ? "true" : "false"}
        aria-label=${`${t("chat.selectors.thinkingLevel")}: ${triggerTitle}`}
        aria-disabled=${params.disabled ? "true" : "false"}
        title=${params.disabledReason ?? triggerTitle}
        @click=${(event: MouseEvent) => {
          if (params.disabled) {
            event.preventDefault();
          }
        }}
      >
        ${params.fastMode.active
          ? html`<span class="chat-controls__effort-zap" aria-hidden="true">${icons.zap}</span>`
          : nothing}
        ${showReasoning
          ? html`
              <span
                class="chat-controls__effort-brain ${effortIsOff
                  ? "chat-controls__effort-brain--off"
                  : ""}"
                style=${`--chat-effort-fill: ${effortFill * 100}%`}
                aria-hidden="true"
              >
                <span class="chat-controls__effort-brain-outline">${icons.brain}</span>
                <span class="chat-controls__effort-brain-fill">${icons.brain}</span>
                ${params.fastMode.active
                  ? html`<span class="chat-controls__effort-fast-badge">${icons.zap}</span>`
                  : nothing}
              </span>
            `
          : nothing}
        <span class="chat-controls__inline-select-label">${triggerLabel}</span>
        <span class="chat-controls__inline-select-chevron" aria-hidden="true"
          >${icons.chevronUp}</span
        >
      </summary>
      <wa-popup data-anchored-overlay>
        <div
          class="chat-controls__inline-select-menu chat-controls__effort-menu"
          aria-label=${t("chat.modelControls.effort")}
        >
          ${showReasoning
            ? html`
                <div class="chat-controls__reasoning-panel">
                  <div class="chat-controls__reasoning-head">
                    <span class="chat-controls__effort-heading">
                      ${t("chat.modelControls.effort")}
                    </span>
                    <span class="sr-only">
                      <span data-chat-thinking-preview-committed>${reasoningValueText}</span>
                      ${sliderStops.map(
                        (stop, index) => html`<span data-chat-thinking-preview-index=${index} hidden
                          >${formatEffortLabel(stop.label)}</span
                        >`,
                      )}
                    </span>
                  </div>
                  ${sliderStops.length > 1
                    ? html`
                        <div class="chat-controls__reasoning-slider">
                          <div class="chat-controls__reasoning-dots" aria-hidden="true">
                            ${sliderStops.map(
                              (stop) => html`<span
                                class="chat-controls__reasoning-dot"
                                data-stop=${stop.value}
                              ></span>`,
                            )}
                          </div>
                          <input
                            class="chat-controls__reasoning-range ${hasThinkingOverride
                              ? ""
                              : "chat-controls__reasoning-range--inherit"} ${sliderUnanchored
                              ? "chat-controls__reasoning-range--unanchored"
                              : ""}"
                            type="range"
                            min="0"
                            max=${sliderStops.length - 1}
                            step="1"
                            .value=${String(sliderIndex)}
                            style=${`--reasoning-fill: ${sliderFillPercent(sliderIndex)}%`}
                            data-chat-thinking-slider="true"
                            data-chat-thinking-values=${sliderStops
                              .map((stop) => stop.value)
                              .join(",")}
                            aria-label=${t("chat.selectors.thinkingLevel")}
                            aria-valuetext=${reasoningValueLabel}
                            ?disabled=${params.thinkingDisabled}
                            @input=${onSliderDrag}
                            @change=${onSliderCommit}
                            @click=${onUnanchoredSliderClick}
                            @keydown=${onUnanchoredSliderKeyDown}
                            @pointercancel=${(event: PointerEvent) =>
                              resetSliderPreview(event.currentTarget as HTMLInputElement, true)}
                            @blur=${(event: FocusEvent) =>
                              resetSliderPreview(event.currentTarget as HTMLInputElement, true)}
                          />
                        </div>
                        <div class="chat-controls__effort-scale" aria-hidden="true">
                          <span>${t("chat.modelControls.faster")}</span>
                          <span>${t("chat.modelControls.smarter")}</span>
                        </div>
                      `
                    : onlyStop
                      ? html`
                          <button
                            class="chat-controls__reasoning-option ${onlyStopSelected
                              ? "chat-controls__reasoning-option--selected"
                              : ""}"
                            data-chat-thinking-option=${onlyStop.value}
                            type="button"
                            aria-pressed=${onlyStopSelected ? "true" : "false"}
                            ?disabled=${params.thinkingDisabled}
                            @click=${(event: MouseEvent) => {
                              event.stopPropagation();
                              if (params.thinkingDisabled || onlyStopSelected) {
                                event.preventDefault();
                                return;
                              }
                              commitThinking(onlyStop.value);
                            }}
                          >
                            <span>${onlyStop.label}</span>
                            ${onlyStopSelected
                              ? html`<span
                                  class="chat-controls__inline-select-check"
                                  aria-hidden="true"
                                  >${icons.check}</span
                                >`
                              : nothing}
                          </button>
                        `
                      : nothing}
                </div>
              `
            : nothing}
          ${params.showFastMode
            ? html`
                <div class="chat-controls__fast-mode-row">
                  <span class="chat-controls__fast-mode-icon" aria-hidden="true">${icons.zap}</span>
                  <span class="chat-controls__fast-mode-copy">
                    <span class="chat-controls__fast-mode-title">
                      ${t("chat.modelControls.fastMode")}
                    </span>
                    <span class="chat-controls__fast-mode-description">
                      ${t("chat.modelControls.fastHelp")}
                    </span>
                  </span>
                  <button
                    class="chat-controls__speed-toggle ${params.fastMode.active
                      ? "chat-controls__speed-toggle--active"
                      : ""}"
                    data-chat-speed-toggle=${params.fastMode.nextValue}
                    type="button"
                    role="switch"
                    aria-checked=${params.fastMode.active ? "true" : "false"}
                    aria-label=${t("chat.modelControls.fastResponsesAria", {
                      state: params.fastMode.label,
                    })}
                    ?disabled=${params.fastMode.disabled}
                    @click=${(event: MouseEvent) => {
                      event.stopPropagation();
                      if (params.fastMode.disabled) {
                        event.preventDefault();
                        return;
                      }
                      commitFastMode(params.fastMode.nextValue);
                    }}
                  >
                    <span class="chat-controls__speed-toggle-thumb"></span>
                  </button>
                </div>
              `
            : nothing}
        </div>
      </wa-popup>
    </details>
  `;
}
