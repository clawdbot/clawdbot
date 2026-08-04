import { html } from "lit";
import "../../components/option-card.ts";
import type { CustodianStructuredQuestion } from "./structured-question.ts";

export function renderCustodianQuestionCard(params: {
  question: CustodianStructuredQuestion;
  disabled: boolean;
  onSelect: (label: string) => void;
  onSkip: () => void;
}) {
  return html`<div class="custodian__option-card">
    <openclaw-option-card
      .props=${{
        header: params.question.header,
        question: params.question.question,
        options: params.question.options.map((option) => ({
          value: option.label,
          label: option.label,
          description: option.description,
          recommended: option.recommended,
        })),
        disabled: params.disabled,
        onSelect: params.onSelect,
        onSkip: params.onSkip,
      }}
    ></openclaw-option-card>
  </div>`;
}
