// Control UI question module renders selectable and free-text answer controls.
import { html, nothing } from "lit";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { t } from "../../../i18n/index.ts";

type Question = QuestionPrompt["questions"][number];

type QuestionOptionsProps = {
  question: Question;
  selected: readonly string[];
  disabled: boolean;
  onSelect: (label: string) => void;
};

type QuestionFreeTextProps = {
  question: Question;
  value: string;
  selected: boolean;
  disabled: boolean;
  onInput: (value: string) => void;
};

export function renderQuestionOptions(props: QuestionOptionsProps) {
  const { question } = props;
  if (question.options.length === 0) {
    return nothing;
  }
  return html`
    <div
      class="chat-question-panel__options"
      role=${question.multiSelect ? "group" : "radiogroup"}
      aria-label=${question.header}
    >
      ${question.options.map((option, index) => {
        const selected = props.selected.includes(option.label);
        const radioTabIndex = selected || (props.selected.length === 0 && index === 0) ? 0 : -1;
        return html`
          <button
            class="chat-question-panel__option ${
              selected ? "chat-question-panel__option--selected" : ""
            }"
            type="button"
            role=${question.multiSelect ? "checkbox" : "radio"}
            aria-checked=${selected ? "true" : "false"}
            tabindex=${question.multiSelect ? 0 : radioTabIndex}
            data-option-index=${index}
            ?disabled=${props.disabled}
            @click=${() => props.onSelect(option.label)}
          >
            <span class="chat-question-panel__option-marker" aria-hidden="true">
              ${selected ? "✓" : ""}
            </span>
            <span class="chat-question-panel__option-copy">
              <strong>${option.label}</strong>
              ${option.description ? html`<small>${option.description}</small>` : nothing}
            </span>
            <kbd>${index + 1}</kbd>
          </button>
        `;
      })}
    </div>
  `;
}

export function renderQuestionFreeText(props: QuestionFreeTextProps) {
  const { question } = props;
  const handleInput = (event: Event) => {
    if (event.currentTarget instanceof HTMLInputElement) {
      props.onInput(event.currentTarget.value);
    }
  };
  if (question.options.length === 0) {
    const answerLabel = question.header || t("chat.questions.answer");
    return html`
      <label class="field">
        <span>${answerLabel}</span>
        <input
          class="input"
          type=${question.isSecret ? "password" : "text"}
          autocomplete="off"
          placeholder=${t("chat.questions.answerPlaceholder", {
            label: question.secretStore?.name ?? answerLabel,
          })}
          .value=${props.value}
          ?disabled=${props.disabled}
          @input=${handleInput}
        />
      </label>
    `;
  }
  if (!question.isOther) {
    return nothing;
  }
  return html`
    <label
      class="chat-question-panel__option chat-question-panel__option--other ${
        props.selected ? "chat-question-panel__option--selected" : ""
      }"
    >
      <span class="chat-question-panel__option-marker" aria-hidden="true"></span>
      <input
        class="chat-question-panel__other"
        type=${question.isSecret ? "password" : "text"}
        autocomplete="off"
        placeholder=${t("chat.questions.other")}
        aria-label=${t("chat.questions.ownAnswerFor", { header: question.header })}
        .value=${props.value}
        ?disabled=${props.disabled}
        @input=${handleInput}
      />
      <kbd>${question.options.length + 1}</kbd>
    </label>
  `;
}
