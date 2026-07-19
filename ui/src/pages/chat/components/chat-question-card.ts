// Control UI chat module renders the shared docked question panel and terminal summaries.
import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";

type QuestionPanelQuestion = {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  isOther?: boolean;
};

type QuestionPanelViewModel = {
  requestKey: string;
  title: string;
  questions: QuestionPanelQuestion[];
  collapsed: boolean;
  disabled: boolean;
  submitting?: boolean;
  countdown?: string;
  answersById?: Record<string, string[]>;
  error?: string | null;
  requestPosition?: { current: number; total: number };
};

type QuestionPanelProps = {
  model: QuestionPanelViewModel;
  onSubmit?: (answersById: Record<string, string[]>) => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
  onAnswersChange?: (answersById: Record<string, string[]>) => void;
  onDismissError?: () => void;
  onCollapsedChange?: (collapsed: boolean) => void;
  onPreviousRequest?: () => void;
  onNextRequest?: () => void;
};

type GatewayQuestionPanelOptions = {
  nowMs: number;
  onChange?: () => void;
  onSubmit?: (answers: Record<string, string[]>) => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  requestPosition?: { current: number; total: number };
  onPreviousRequest?: () => void;
  onNextRequest?: () => void;
};

function formatRemaining(expiresAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function promptDraftAnswers(prompt: QuestionPrompt): Record<string, string[]> {
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

export function createGatewayQuestionPanelProps(
  prompt: QuestionPrompt,
  options: GatewayQuestionPanelOptions,
): QuestionPanelProps {
  return {
    model: {
      requestKey: prompt.id,
      title: t("chat.questions.eyebrow"),
      questions: prompt.questions,
      collapsed: options.collapsed ?? false,
      disabled: prompt.status !== "pending" || prompt.submitting,
      submitting: prompt.submitting,
      countdown:
        prompt.status === "pending"
          ? formatRemaining(prompt.expiresAtMs, options.nowMs)
          : undefined,
      answersById: promptDraftAnswers(prompt),
      error: prompt.error,
      requestPosition: options.requestPosition,
    },
    onAnswersChange: (answersById) => {
      updatePromptDrafts(prompt, answersById);
      options.onChange?.();
    },
    onSubmit: options.onSubmit
      ? async (answersById) => {
          await options.onSubmit?.(answersById);
          if (prompt.status === "pending" && prompt.error) {
            throw new Error(prompt.error);
          }
        }
      : undefined,
    onSkip: options.onSkip
      ? async () => {
          await options.onSkip?.();
          if (prompt.status === "pending" && prompt.error) {
            throw new Error(prompt.error);
          }
        }
      : undefined,
    onDismissError:
      prompt.error && options.onChange
        ? () => {
            prompt.error = null;
            options.onChange?.();
          }
        : undefined,
    onCollapsedChange: options.onCollapsedChange,
    onPreviousRequest: options.onPreviousRequest,
    onNextRequest: options.onNextRequest,
  };
}

function terminalAnswer(prompt: QuestionPrompt, question: QuestionPanelQuestion): string {
  if (prompt.status === "cancelled") {
    return t("chat.questions.skipped");
  }
  if (prompt.status === "expired") {
    return t("chat.questions.expired");
  }
  if (prompt.status === "unavailable") {
    return t("chat.questions.unavailable");
  }
  const answer = prompt.answers?.answers[question.id]?.answers.join(", ");
  if (answer) {
    return answer;
  }
  if (prompt.answeredElsewhere) {
    return t("chat.questions.answeredElsewhere");
  }
  return t("chat.questions.answered");
}

export function renderChatQuestionSummary(prompt: QuestionPrompt) {
  if (prompt.status === "pending") {
    return nothing;
  }
  return html`
    <div class="chat-question-summary" aria-label=${t("chat.questions.summaryLabel")}>
      ${prompt.questions.map(
        (question) => html`
          <div class="chat-question-summary__line">
            <strong>${question.header}:</strong>
            <span>${terminalAnswer(prompt, question)}</span>
          </div>
        `,
      )}
    </div>
  `;
}

function answersSignature(answersById: Record<string, string[]>): string {
  return JSON.stringify(
    Object.entries(answersById)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([id, values]) => [id, values]),
  );
}

class ChatQuestionPanel extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) props?: QuestionPanelProps;
  @state() private selectedById = new Map<string, string[]>();
  @state() private freeTextById = new Map<string, string>();
  @state() private currentQuestionIndex = 0;
  @state() private pendingAction: "submit" | "skip" | null = null;
  private requestKey: string | null = null;
  private collapsed = false;
  private focusAfterUpdate = false;
  private syncedAnswersSignature: string | null = null;

  private setCollapsed(collapsed: boolean): void {
    if (this.props?.onCollapsedChange) {
      this.props.onCollapsedChange(collapsed);
      return;
    }
    this.collapsed = collapsed;
    this.focusAfterUpdate = !collapsed;
    this.requestUpdate();
  }

  override willUpdate() {
    const model = this.props?.model;
    const nextRequestKey = model?.requestKey ?? null;
    const nextCollapsed = model?.collapsed ?? false;
    if (nextRequestKey !== this.requestKey) {
      this.requestKey = nextRequestKey;
      this.selectedById = new Map();
      this.freeTextById = new Map();
      this.currentQuestionIndex = 0;
      this.pendingAction = null;
      this.syncedAnswersSignature = null;
      this.collapsed = nextCollapsed;
      this.focusAfterUpdate = !nextCollapsed;
    } else if (this.props?.onCollapsedChange) {
      if (this.collapsed && !nextCollapsed) {
        this.focusAfterUpdate = true;
      }
      this.collapsed = nextCollapsed;
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

  override updated(): void {
    if (!this.focusAfterUpdate || this.collapsed) {
      return;
    }
    this.focusAfterUpdate = false;
    this.querySelector<HTMLElement>(".chat-question-panel")?.focus({ preventScroll: true });
  }

  private answerValues(question: QuestionPanelQuestion): string[] {
    const selected = this.selectedById.get(question.id) ?? [];
    const freeText = this.freeTextById.get(question.id)?.trim();
    return [...selected, ...(freeText ? [freeText] : [])];
  }

  private buildAnswers(model: QuestionPanelViewModel): Record<string, string[]> {
    return Object.fromEntries(
      model.questions.map((question) => [question.id, this.answerValues(question)]),
    );
  }

  private answersChanged(model: QuestionPanelViewModel): void {
    const answersById = this.buildAnswers(model);
    model.answersById = answersById;
    this.syncedAnswersSignature = answersSignature(answersById);
    this.props?.onAnswersChange?.(answersById);
  }

  private focusPanel(): void {
    void this.updateComplete.then(() =>
      this.querySelector<HTMLElement>(".chat-question-panel")?.focus({ preventScroll: true }),
    );
  }

  private toggleOption(
    model: QuestionPanelViewModel,
    question: QuestionPanelQuestion,
    label: string,
    advance = true,
  ): void {
    const selectedById = new Map(this.selectedById);
    const current = selectedById.get(question.id) ?? [];
    selectedById.set(
      question.id,
      question.multiSelect
        ? current.includes(label)
          ? current.filter((value) => value !== label)
          : [...current, label]
        : // Single-select re-click keeps the choice: radios never deselect.
          [label],
    );
    this.selectedById = selectedById;
    if (!question.multiSelect) {
      const freeTextById = new Map(this.freeTextById);
      freeTextById.delete(question.id);
      this.freeTextById = freeTextById;
    }
    this.answersChanged(model);
    if (
      advance &&
      !question.multiSelect &&
      this.currentQuestionIndex < model.questions.length - 1
    ) {
      this.currentQuestionIndex += 1;
      this.focusPanel();
    }
  }

  private setFreeText(
    model: QuestionPanelViewModel,
    question: QuestionPanelQuestion,
    value: string,
  ): void {
    this.freeTextById = new Map(this.freeTextById).set(question.id, value);
    if (!question.multiSelect && value.trim()) {
      this.selectedById = new Map(this.selectedById).set(question.id, []);
    }
    this.answersChanged(model);
  }

  private async submit(model: QuestionPanelViewModel): Promise<void> {
    if (
      !this.props?.onSubmit ||
      !model.questions.every((question) => this.answerValues(question).length > 0)
    ) {
      return;
    }
    const requestKey = model.requestKey;
    this.pendingAction = "submit";
    try {
      await this.props.onSubmit(this.buildAnswers(model));
    } catch {
      if (this.requestKey === requestKey) {
        this.pendingAction = null;
      }
    }
  }

  private async skip(model: QuestionPanelViewModel): Promise<void> {
    if (!this.props?.onSkip) {
      return;
    }
    const requestKey = model.requestKey;
    this.pendingAction = "skip";
    try {
      await this.props.onSkip();
    } catch {
      if (this.requestKey === requestKey) {
        this.pendingAction = null;
      }
    }
  }

  private advanceOrSubmit(model: QuestionPanelViewModel, question: QuestionPanelQuestion): void {
    if (this.answerValues(question).length === 0) {
      return;
    }
    if (this.currentQuestionIndex < model.questions.length - 1) {
      this.currentQuestionIndex += 1;
      this.focusPanel();
      return;
    }
    void this.submit(model);
  }

  private goBack(): void {
    if (this.currentQuestionIndex === 0) {
      return;
    }
    this.currentQuestionIndex -= 1;
    this.focusPanel();
  }

  private handleKeyDown(
    event: KeyboardEvent,
    model: QuestionPanelViewModel,
    question: QuestionPanelQuestion,
    disabled: boolean,
  ): void {
    if (disabled || event.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.target instanceof HTMLInputElement) {
      if (event.key === "Enter" && this.answerValues(question).length > 0) {
        event.preventDefault();
        this.advanceOrSubmit(model, question);
      }
      return;
    }
    if (
      event.target instanceof HTMLButtonElement &&
      event.target.getAttribute("role") === "radio" &&
      ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home"].includes(event.key)
    ) {
      event.preventDefault();
      const currentIndex = Number(event.target.dataset.optionIndex ?? "0");
      const lastIndex = question.options.length - 1;
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? lastIndex
            : event.key === "ArrowLeft" || event.key === "ArrowUp"
              ? (currentIndex - 1 + question.options.length) % question.options.length
              : (currentIndex + 1) % question.options.length;
      const nextOption = question.options[nextIndex];
      if (!nextOption) {
        return;
      }
      const questionIndex = this.currentQuestionIndex;
      // Arrow navigation follows radio-group focus without leaving the step.
      // Explicit activation and numeric shortcuts keep the product's auto-advance behavior.
      this.toggleOption(model, question, nextOption.label, false);
      if (this.currentQuestionIndex === questionIndex) {
        void this.updateComplete.then(() =>
          this.querySelector<HTMLButtonElement>(
            `.chat-question-panel__option[data-option-index="${nextIndex}"]`,
          )?.focus({ preventScroll: true }),
        );
      }
      return;
    }
    const optionIndex = Number(event.key) - 1;
    if (optionIndex >= 0 && optionIndex < 4 && question.options[optionIndex]) {
      event.preventDefault();
      this.toggleOption(model, question, question.options[optionIndex].label);
      return;
    }
    if (
      event.key === "Enter" &&
      !(event.target instanceof HTMLButtonElement) &&
      this.answerValues(question).length > 0
    ) {
      event.preventDefault();
      this.advanceOrSubmit(model, question);
    }
  }

  override render() {
    const props = this.props;
    if (!props) {
      return nothing;
    }
    const { model } = props;
    const question = model.questions[this.currentQuestionIndex];
    if (!question) {
      return nothing;
    }
    const disabled = model.disabled || this.pendingAction !== null;
    const isLast = this.currentQuestionIndex === model.questions.length - 1;
    const canAdvance = this.answerValues(question).length > 0;
    const progress = `${this.currentQuestionIndex + 1}/${model.questions.length}`;
    const requestProgress = model.requestPosition
      ? `${model.requestPosition.current}/${model.requestPosition.total}`
      : null;

    if (this.collapsed) {
      return html`
        <section
          class="chat-question-panel chat-question-panel--collapsed"
          aria-label=${model.title}
        >
          <button
            class="chat-question-panel__collapsed-button"
            type="button"
            @click=${() => {
              this.setCollapsed(false);
            }}
            aria-label=${t("chat.questions.expand")}
          >
            <span>${question.header}</span>
            <span class="chat-question-panel__progress">${progress}</span>
            <span class="chat-question-panel__chevron">${icons.chevronDown}</span>
          </button>
          ${requestProgress
            ? html`<div class="chat-question-panel__request-nav">
                <button
                  type="button"
                  aria-label=${t("common.previous")}
                  @click=${props.onPreviousRequest}
                >
                  ${icons.chevronLeft}
                </button>
                <span>${requestProgress}</span>
                <button type="button" aria-label=${t("common.next")} @click=${props.onNextRequest}>
                  ${icons.chevronRight}
                </button>
              </div>`
            : nothing}
        </section>
      `;
    }

    return html`
      <section
        class="chat-question-panel"
        role="group"
        aria-label=${model.title}
        tabindex="0"
        @keydown=${(event: KeyboardEvent) => this.handleKeyDown(event, model, question, disabled)}
      >
        <div class="chat-question-panel__topline">
          <div class="chat-question-panel__title">${model.title}</div>
          ${requestProgress
            ? html`<div class="chat-question-panel__request-nav">
                <button
                  type="button"
                  aria-label=${t("common.previous")}
                  @click=${props.onPreviousRequest}
                >
                  ${icons.chevronLeft}
                </button>
                <span>${requestProgress}</span>
                <button type="button" aria-label=${t("common.next")} @click=${props.onNextRequest}>
                  ${icons.chevronRight}
                </button>
              </div>`
            : nothing}
          ${model.countdown
            ? html`<span
                class="chat-question-panel__countdown"
                title=${t("chat.questions.timeRemaining")}
                >${model.countdown}</span
              >`
            : nothing}
          <button
            class="chat-question-panel__collapse"
            type="button"
            @click=${() => this.setCollapsed(true)}
            aria-label=${t("chat.questions.collapse")}
          >
            ${icons.chevronDown}
          </button>
        </div>

        <div class="chat-question-panel__heading">
          <span class="chat-question-panel__progress">${progress}</span>
          <span class="chat-question-panel__prompt">${question.question}</span>
        </div>

        <div
          class="chat-question-panel__options"
          role=${question.multiSelect ? "group" : "radiogroup"}
          aria-label=${question.header}
        >
          ${question.options.map((option, index) => {
            const selected = (this.selectedById.get(question.id) ?? []).includes(option.label);
            const radioTabIndex =
              selected || (!this.selectedById.get(question.id)?.length && index === 0) ? 0 : -1;
            return html`
              <button
                class="chat-question-panel__option ${selected
                  ? "chat-question-panel__option--selected"
                  : ""}"
                type="button"
                role=${question.multiSelect ? "checkbox" : "radio"}
                aria-checked=${selected ? "true" : "false"}
                tabindex=${question.multiSelect ? 0 : radioTabIndex}
                data-option-index=${index}
                ?disabled=${disabled}
                @click=${() => this.toggleOption(model, question, option.label)}
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

        ${question.isOther || question.options.length === 0
          ? html`
              <input
                class="chat-question-panel__other"
                type="text"
                autocomplete="off"
                placeholder=${t("chat.questions.other")}
                aria-label=${t("chat.questions.ownAnswerFor", { header: question.header })}
                .value=${this.freeTextById.get(question.id) ?? ""}
                ?disabled=${disabled}
                @input=${(event: Event) =>
                  this.setFreeText(model, question, (event.target as HTMLInputElement).value)}
              />
            `
          : nothing}

        <div class="chat-question-panel__footer">
          ${model.error
            ? html`<span class="chat-question-panel__error" role="status">
                ${t("chat.questions.submitFailed", { error: model.error })}
                ${props.onDismissError
                  ? html`<button
                      type="button"
                      class="chat-question-panel__error-dismiss"
                      aria-label=${t("chat.actions.dismissError")}
                      @click=${props.onDismissError}
                    >
                      ×
                    </button>`
                  : nothing}
              </span>`
            : nothing}
          ${this.currentQuestionIndex > 0
            ? html`<button
                class="btn btn--sm chat-question-panel__back"
                type="button"
                ?disabled=${disabled}
                @click=${() => this.goBack()}
              >
                ${t("chat.questions.back")}
              </button>`
            : nothing}
          ${props.onSkip
            ? html`<button
                class="btn btn--sm chat-question-panel__skip"
                type="button"
                ?disabled=${disabled}
                @click=${() => void this.skip(model)}
              >
                ${this.pendingAction === "skip"
                  ? t("chat.questions.skipping")
                  : t("chat.questions.skip")}
              </button>`
            : nothing}
          <button
            class="btn btn--sm primary chat-question-panel__advance"
            type="button"
            ?disabled=${disabled || !canAdvance || !props.onSubmit}
            @click=${() => this.advanceOrSubmit(model, question)}
          >
            ${this.pendingAction === "submit" || model.submitting
              ? t("chat.questions.submitting")
              : isLast
                ? t("chat.questions.submit")
                : t("chat.questions.next")}
          </button>
        </div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-chat-question-panel")) {
  customElements.define("openclaw-chat-question-panel", ChatQuestionPanel);
}
