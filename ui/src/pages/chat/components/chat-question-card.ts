// Control UI chat module renders provider-neutral question cards.
import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { t } from "../../../i18n/index.ts";
import type { QuestionStatus } from "../tool-stream.ts";

type QuestionCardQuestion = {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  isOther?: boolean;
};

type QuestionCardTerminalState = "answered" | "answered-elsewhere" | "expired" | "cancelled";

type QuestionCardViewModel = {
  requestKey: string;
  title: string;
  questions: QuestionCardQuestion[];
  terminalState?: QuestionCardTerminalState;
  disabled: boolean;
  submitting?: boolean;
  countdown?: string;
  answersById?: Record<string, string[]>;
  error?: string | null;
};

type QuestionCardProps = {
  model: QuestionCardViewModel;
  onSubmit: (answersById: Record<string, string[]>) => void | Promise<void>;
  onAnswersChange?: (answersById: Record<string, string[]>) => void;
  onDismissError?: () => void;
};

type CodexQuestionCardOptions = {
  disabled: boolean;
  onSubmit: (answers: Record<string, string>, onRejected: () => void) => void;
};

type GatewayQuestionCardOptions = {
  nowMs: number;
  onChange: () => void;
  onSubmit: (answers: Record<string, string[]>) => void | Promise<void>;
};

function formatRemaining(expiresAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function terminalStateForPrompt(prompt: QuestionPrompt): QuestionCardTerminalState | undefined {
  if (prompt.status === "answered") {
    return prompt.answeredElsewhere ? "answered-elsewhere" : "answered";
  }
  return prompt.status === "pending" ? undefined : prompt.status;
}

function promptDraftAnswers(prompt: QuestionPrompt): Record<string, string[]> {
  if (prompt.status === "answered") {
    return Object.fromEntries(
      prompt.questions.map((question) => [
        question.id,
        prompt.answers?.answers[question.id]?.answers ?? [],
      ]),
    );
  }
  return Object.fromEntries(
    prompt.questions.map((question) => {
      const draft = prompt.drafts.get(question.id);
      return [
        question.id,
        [...(draft?.selected ?? []), ...(draft?.freeText.trim() ? [draft.freeText.trim()] : [])],
      ];
    }),
  );
}

function updatePromptDrafts(prompt: QuestionPrompt, answersById: Record<string, string[]>): void {
  for (const question of prompt.questions) {
    const values = answersById[question.id] ?? [];
    const optionLabels = new Set(question.options.map((option) => option.label));
    prompt.drafts.set(question.id, {
      selected: new Set(values.filter((value) => optionLabels.has(value))),
      freeText: values.find((value) => !optionLabels.has(value)) ?? "",
    });
  }
}

export function createCodexQuestionCardProps(
  status: QuestionStatus,
  options: CodexQuestionCardOptions,
): QuestionCardProps {
  return {
    model: {
      requestKey: `${status.itemId}:${status.actionToken}`,
      title: t("chat.questions.title"),
      questions: status.questions,
      disabled: options.disabled,
    },
    onSubmit: (answersById) =>
      new Promise<void>((_resolve, reject) => {
        const answers = Object.fromEntries(
          Object.entries(answersById).map(([id, values]) => [id, values[0] ?? ""]),
        );
        options.onSubmit(answers, () => reject(new Error("question submission rejected")));
      }),
  };
}

export function renderChatQuestionCard(
  prompt: QuestionPrompt,
  options: GatewayQuestionCardOptions,
) {
  const pending = prompt.status === "pending";
  const props: QuestionCardProps = {
    model: {
      requestKey: prompt.id,
      title: t("chat.questions.eyebrow"),
      questions: prompt.questions,
      terminalState: terminalStateForPrompt(prompt),
      disabled: !pending || prompt.submitting,
      submitting: prompt.submitting,
      countdown: pending ? formatRemaining(prompt.expiresAtMs, options.nowMs) : undefined,
      answersById: promptDraftAnswers(prompt),
      error: prompt.error,
    },
    onAnswersChange: (answersById) => {
      updatePromptDrafts(prompt, answersById);
      options.onChange();
    },
    onSubmit: async (answersById) => {
      await options.onSubmit(answersById);
      if (prompt.status === "pending" && prompt.error) {
        throw new Error(prompt.error);
      }
    },
    onDismissError: prompt.error
      ? () => {
          prompt.error = null;
          options.onChange();
        }
      : undefined,
  };
  return html`<openclaw-chat-question .props=${props}></openclaw-chat-question>`;
}

function answersSignature(answersById: Record<string, string[]>): string {
  return JSON.stringify(
    Object.entries(answersById)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([id, values]) => [id, values]),
  );
}

class ChatQuestionCard extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) props?: QuestionCardProps;
  @state() private selectedById = new Map<string, string[]>();
  @state() private freeTextById = new Map<string, string>();
  @state() private submitted = false;
  private requestKey: string | null = null;
  private syncedAnswersSignature: string | null = null;

  override willUpdate() {
    const model = this.props?.model;
    const nextRequestKey = model?.requestKey ?? null;
    if (nextRequestKey !== this.requestKey) {
      this.requestKey = nextRequestKey;
      this.selectedById = new Map();
      this.freeTextById = new Map();
      this.submitted = false;
      this.syncedAnswersSignature = null;
    }
    if (!model?.answersById) {
      return;
    }
    const signature = answersSignature(model.answersById);
    if (signature === this.syncedAnswersSignature) {
      return;
    }
    this.syncedAnswersSignature = signature;
    const selectedById = new Map<string, string[]>();
    const freeTextById = new Map<string, string>();
    for (const question of model.questions) {
      const optionLabels = new Set(question.options.map((option) => option.label));
      const values = model.answersById[question.id] ?? [];
      selectedById.set(
        question.id,
        values.filter((value) => optionLabels.has(value)),
      );
      const custom = values.filter((value) => !optionLabels.has(value)).join(", ");
      if (custom) {
        freeTextById.set(question.id, custom);
      }
    }
    this.selectedById = selectedById;
    this.freeTextById = freeTextById;
  }

  private answerValues(question: QuestionCardQuestion): string[] {
    const selected = this.selectedById.get(question.id) ?? [];
    const freeText = this.freeTextById.get(question.id)?.trim();
    return [...selected, ...(freeText ? [freeText] : [])];
  }

  private buildAnswers(model: QuestionCardViewModel): Record<string, string[]> {
    return Object.fromEntries(
      model.questions.map((question) => [question.id, this.answerValues(question)]),
    );
  }

  private answersChanged(model: QuestionCardViewModel): void {
    const answersById = this.buildAnswers(model);
    this.syncedAnswersSignature = answersSignature(answersById);
    this.props?.onAnswersChange?.(answersById);
  }

  private toggleOption(
    model: QuestionCardViewModel,
    question: QuestionCardQuestion,
    label: string,
  ) {
    const selectedById = new Map(this.selectedById);
    const current = selectedById.get(question.id) ?? [];
    selectedById.set(
      question.id,
      question.multiSelect
        ? current.includes(label)
          ? current.filter((value) => value !== label)
          : [...current, label]
        : [label],
    );
    this.selectedById = selectedById;
    if (!question.multiSelect) {
      const freeTextById = new Map(this.freeTextById);
      freeTextById.delete(question.id);
      this.freeTextById = freeTextById;
    }
    this.answersChanged(model);
  }

  private setFreeText(model: QuestionCardViewModel, question: QuestionCardQuestion, value: string) {
    this.freeTextById = new Map(this.freeTextById).set(question.id, value);
    if (!question.multiSelect && value.trim()) {
      this.selectedById = new Map(this.selectedById).set(question.id, []);
    }
    this.answersChanged(model);
  }

  private async submit(model: QuestionCardViewModel): Promise<void> {
    if (!model.questions.every((question) => this.answerValues(question).length > 0)) {
      return;
    }
    const requestKey = model.requestKey;
    this.submitted = true;
    try {
      await this.props?.onSubmit(this.buildAnswers(model));
    } catch {
      if (this.requestKey === requestKey) {
        this.submitted = false;
      }
    }
  }

  override render() {
    const props = this.props;
    if (!props) {
      return nothing;
    }
    const { model } = props;
    const disabled = model.disabled || this.submitted || Boolean(model.terminalState);
    const complete = model.questions.every((question) => this.answerValues(question).length > 0);
    return html`
      <section class="chat-question" role="group" aria-label=${model.title}>
        <div class="chat-question__topline">
          <div class="chat-question__title">${model.title}</div>
          ${model.countdown
            ? html`<span class="chat-question__countdown" title=${t("chat.questions.timeRemaining")}
                >${model.countdown}</span
              >`
            : nothing}
        </div>
        ${model.questions.map(
          (question) => html`
            <fieldset class="chat-question__field" ?disabled=${disabled}>
              <legend>${question.header}</legend>
              <div class="chat-question__prompt">${question.question}</div>
              ${question.options.map((option) => {
                const selected = (this.selectedById.get(question.id) ?? []).includes(option.label);
                return html`
                  <label class="chat-question__option">
                    <input
                      type=${question.multiSelect ? "checkbox" : "radio"}
                      name=${`${model.requestKey}-${question.id}`}
                      .checked=${selected}
                      ?disabled=${disabled}
                      @change=${() => this.toggleOption(model, question, option.label)}
                    />
                    <span>
                      <strong>${option.label}</strong>
                      ${option.description ? html`<small>${option.description}</small>` : nothing}
                    </span>
                  </label>
                `;
              })}
              ${question.isOther || question.options.length === 0
                ? html`
                    <input
                      class="chat-question__other"
                      type="text"
                      autocomplete="off"
                      placeholder=${t("chat.questions.other")}
                      aria-label=${t("chat.questions.ownAnswerFor", { header: question.header })}
                      .value=${this.freeTextById.get(question.id) ?? ""}
                      ?disabled=${disabled}
                      @input=${(event: Event) =>
                        this.setFreeText(model, question, (event.target as HTMLInputElement).value)}
                      @keydown=${(event: KeyboardEvent) => {
                        if (
                          event.key === "Enter" &&
                          !event.isComposing &&
                          event.keyCode !== 229 &&
                          complete &&
                          !disabled
                        ) {
                          event.preventDefault();
                          void this.submit(model);
                        }
                      }}
                    />
                  `
                : nothing}
            </fieldset>
          `,
        )}
        <div class="chat-question__footer">
          ${model.terminalState
            ? html`<span class="chat-question__status"
                >${t(
                  `chat.questions.${model.terminalState === "answered-elsewhere" ? "answeredElsewhere" : model.terminalState}`,
                )}</span
              >`
            : nothing}
          ${model.error
            ? html`<span class="chat-question__error" role="status">
                ${t("chat.questions.submitFailed", { error: model.error })}
                ${props.onDismissError
                  ? html`<button
                      type="button"
                      class="chat-question__error-dismiss"
                      aria-label=${t("chat.actions.dismissError")}
                      @click=${props.onDismissError}
                    >
                      ×
                    </button>`
                  : nothing}
              </span>`
            : nothing}
          ${model.terminalState
            ? nothing
            : html`<button
                class="btn btn--sm primary chat-question__submit"
                type="button"
                ?disabled=${disabled || !complete}
                @click=${() => void this.submit(model)}
              >
                ${this.submitted || model.submitting
                  ? t("chat.questions.submitting")
                  : t("chat.questions.submit")}
              </button>`}
        </div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-chat-question")) {
  customElements.define("openclaw-chat-question", ChatQuestionCard);
}
