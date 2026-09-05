import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";

export type ChatModelCatalogState = {
  hasSnapshot: boolean;
  status: "idle" | "loading" | "ready" | "error" | "offline";
};

export function renderChatModelCatalogState(
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
      : state.status === "error"
        ? errorLabel
        : state.status === "ready"
          ? t("chat.modelControls.noModelsAvailable")
          : t("chat.modelControls.loadingModels");
  return html`
    <div
      class="chat-controls__model-catalog-state ${
        hasOptions ? "" : "chat-controls__model-catalog-state--empty"
      }"
      data-chat-model-catalog-state=${state.status}
      aria-live="polite"
    >
      <span class="chat-controls__model-catalog-state-label">
        ${state.status === "error" ? icons.alertTriangle : nothing}
        <span>${label}</span>
      </span>
      ${
        state.status === "error" && retryTarget
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
          : nothing
      }
      ${
        state.status === "ready" && !hasSelectableOptions && onModelSetup
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
                ${t("chat.modelControls.emptyModelsAction")}
              </button>
            `
          : nothing
      }
    </div>
  `;
}
