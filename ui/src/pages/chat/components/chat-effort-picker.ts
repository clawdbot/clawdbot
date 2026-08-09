import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import type {
  ChatFastModeSelectState,
  ChatFastModeSelectValue,
  ChatModelSelectOption,
} from "../../../lib/chat/model-select-state.ts";
import { formatThinkingOverrideLabel } from "../../../lib/chat/thinking.ts";

type ChatEffortPickerParams = {
  disabled: boolean;
  disabledReason?: string;
  fastMode: ChatFastModeSelectState;
  selectedThinkingValue: string;
  sessionKey: string;
  showFastMode: boolean;
  thinkingDefaultValue: string;
  thinkingDisabled: boolean;
  thinkingOptions: ChatModelSelectOption[];
  triggerThinkingLabel: string;
  onFastModeSelect: (value: ChatFastModeSelectValue, sessionKey: string) => Promise<unknown>;
  onRequestUpdate?: () => void;
  onThinkingSelect: (value: string, sessionKey: string) => Promise<unknown>;
};

function formatEffortLabel(label: string): string {
  return label.replace(/^Inherited:\s*/u, "");
}

export function renderChatEffortPicker(params: ChatEffortPickerParams) {
  const sliderStops = params.thinkingOptions.filter((option) => option.value !== "");
  const showReasoning = sliderStops.length > 0;
  if (!showReasoning && (!params.showFastMode || !params.fastMode.supported)) {
    return nothing;
  }
  const defaultStopIndex = sliderStops.findIndex(
    (option) => option.value === params.thinkingDefaultValue,
  );
  const hasThinkingOverride = params.selectedThinkingValue !== "";
  const overrideStopIndex = sliderStops.findIndex(
    (option) => option.value === params.selectedThinkingValue,
  );
  const sliderIndex = Math.max(hasThinkingOverride ? overrideStopIndex : defaultStopIndex, 0);
  const sliderUnanchored = !hasThinkingOverride && defaultStopIndex < 0;
  const sliderFillPercent = (index: number) =>
    sliderStops.length > 1 ? (index / (sliderStops.length - 1)) * 100 : 0;
  const defaultLevelLabel = formatThinkingOverrideLabel(params.thinkingDefaultValue);
  const selectedThinkingOption = params.thinkingOptions.find(
    (option) => option.value === params.selectedThinkingValue,
  );
  const reasoningValueText = hasThinkingOverride
    ? formatEffortLabel(
        selectedThinkingOption?.label ?? formatThinkingOverrideLabel(params.selectedThinkingValue),
      )
    : defaultLevelLabel;
  const reasoningValueLabel = hasThinkingOverride
    ? reasoningValueText
    : t("chat.modelControls.defaultWithLevel", { level: defaultLevelLabel });
  const triggerLabel = showReasoning
    ? formatEffortLabel(params.triggerThinkingLabel)
    : t("chat.modelControls.fastMode");
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
    if (params.thinkingDisabled || !stop || stop.value === params.selectedThinkingValue) {
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
  const effectiveThinkingValue = params.selectedThinkingValue || params.thinkingDefaultValue;
  const onlyStopSelected = onlyStop?.value === effectiveThinkingValue;
  const speedTooltip = params.fastMode.supported
    ? t("chat.modelControls.fastHelp")
    : t("chat.modelControls.speedUnsupported");
  return html`
    <details class="chat-controls__inline-select chat-controls__effort-picker">
      <summary
        class="chat-controls__inline-select-trigger chat-controls__effort-trigger ${params.fastMode
          .active
          ? "chat-controls__effort-trigger--fast"
          : ""} ${params.disabled ? "chat-controls__inline-select-trigger--disabled" : ""}"
        data-chat-thinking-select="true"
        data-chat-thinking-value=${params.selectedThinkingValue}
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
        <span class="chat-controls__inline-select-label">${triggerLabel}</span>
      </summary>
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
                  <span class="chat-controls__reasoning-state">
                    <span
                      class="chat-controls__reasoning-value ${hasThinkingOverride
                        ? ""
                        : "chat-controls__reasoning-value--inherit"}"
                    >
                      ${sliderStops.length > 1
                        ? html`
                            <span data-chat-thinking-preview-committed>
                              ${reasoningValueText}
                            </span>
                            ${sliderStops.map(
                              (stop, index) => html`
                                <span data-chat-thinking-preview-index=${index} hidden>
                                  ${formatEffortLabel(stop.label)}
                                </span>
                              `,
                            )}
                          `
                        : reasoningValueText}
                    </span>
                    ${hasThinkingOverride
                      ? html`
                          <button
                            class="chat-controls__reasoning-reset"
                            data-chat-thinking-option=""
                            type="button"
                            aria-label=${t("chat.modelControls.useDefaultReasoning", {
                              level: defaultLevelLabel,
                            })}
                            ?disabled=${params.thinkingDisabled}
                            @click=${(event: MouseEvent) => {
                              event.stopPropagation();
                              if (params.thinkingDisabled) {
                                event.preventDefault();
                                return;
                              }
                              commitThinking("");
                            }}
                          >
                            ${t("common.reset")}
                          </button>
                        `
                      : nothing}
                  </span>
                </div>
                ${sliderStops.length > 1
                  ? html`
                      <div class="chat-controls__effort-scale" aria-hidden="true">
                        <span>${t("chat.modelControls.faster")}</span>
                        <span>${t("chat.modelControls.smarter")}</span>
                      </div>
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
                <openclaw-tooltip .content=${speedTooltip}>
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
                </openclaw-tooltip>
              </div>
            `
          : nothing}
      </div>
    </details>
  `;
}
