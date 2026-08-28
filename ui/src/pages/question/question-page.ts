import "../../styles/approval.css";
import "../../styles/chat/question-card.css";
import { consume } from "@lit/context";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RouteId } from "../../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { requestQuestionGateway } from "../../app/question-prompt-client.ts";
import {
  cancelQuestionPrompt,
  createQuestionPromptState,
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
  listQuestionPrompts,
  setQuestionPromptClient,
  submitQuestionPrompt,
  type QuestionPrompt,
} from "../../app/question-prompt.ts";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import {
  createGatewayQuestionPanelProps,
  renderChatQuestionSummary,
} from "../chat/components/chat-question-card.ts";

type QuestionPageRequestError = "connection" | "unavailable" | null;

export class QuestionPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: false })
  context!: ApplicationContext<RouteId>;

  @property({ attribute: "question-id" }) questionId = "";
  @state() private loading = true;
  @state() private requestError: QuestionPageRequestError = null;

  private readonly questionState = createQuestionPromptState(() => this.requestUpdate());
  private client: GatewayBrowserClient | null = null;
  private boundQuestionId: string | undefined;
  private operationGeneration = 0;
  private stopGateway: (() => void) | undefined;
  private stopGatewayEvents: (() => void) | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.boundQuestionId = this.questionId;
    this.stopGateway = this.context.gateway.subscribe((snapshot) =>
      this.applyGatewaySnapshot(snapshot),
    );
    this.stopGatewayEvents = this.context.gateway.subscribeEvents((event) => {
      if (isRecord(event.payload) && event.payload.id === this.questionId) {
        handleQuestionPromptEvent(this.questionState, event);
      }
    });
    this.applyGatewaySnapshot(this.context.gateway.snapshot);
  }

  override disconnectedCallback(): void {
    this.stopGateway?.();
    this.stopGateway = undefined;
    this.stopGatewayEvents?.();
    this.stopGatewayEvents = undefined;
    this.operationGeneration += 1;
    this.client = null;
    disposeQuestionPromptState(this.questionState);
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("questionId") && this.boundQuestionId !== this.questionId) {
      this.boundQuestionId = this.questionId;
      this.operationGeneration += 1;
      this.requestError = this.questionId ? null : "unavailable";
      this.loading = Boolean(this.questionId);
      if (this.questionId && this.client) {
        void this.loadQuestion(this.client);
      }
    }
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot): void {
    const nextClient = snapshot.phase === "connected" ? snapshot.client : null;
    if (this.client === nextClient) {
      if (
        !nextClient &&
        (snapshot.lastError ||
          snapshot.phase === "offline" ||
          snapshot.phase === "reload-required" ||
          snapshot.phase === "stopped")
      ) {
        this.loading = false;
        this.requestError = "connection";
      }
      return;
    }
    this.operationGeneration += 1;
    this.client = nextClient;
    setQuestionPromptClient(this.questionState, nextClient);
    if (!nextClient) {
      if (listQuestionPrompts(this.questionState).some((prompt) => prompt.id === this.questionId)) {
        this.loading = false;
        this.requestError = "connection";
      }
      return;
    }
    if (!this.questionId) {
      this.loading = false;
      this.requestError = "unavailable";
      return;
    }
    void this.loadQuestion(nextClient);
  }

  private async loadQuestion(client: GatewayBrowserClient): Promise<void> {
    const id = this.questionId;
    const generation = ++this.operationGeneration;
    this.loading = true;
    this.requestError = null;
    try {
      const result = await requestQuestionGateway(client, "question.get", { id });
      if (
        this.client !== client ||
        this.operationGeneration !== generation ||
        this.questionId !== id
      ) {
        return;
      }
      if (!isRecord(result) || !isRecord(result.question) || result.question.id !== id) {
        this.requestError = "unavailable";
        return;
      }
      const record = result.question;
      if (
        record.id !== id ||
        (record.status !== "pending" &&
          record.status !== "answered" &&
          record.status !== "cancelled" &&
          record.status !== "expired") ||
        !handleQuestionPromptEvent(this.questionState, {
          event: "question.requested",
          payload: { ...record, status: "pending" },
        })
      ) {
        this.requestError = "unavailable";
        return;
      }
      if (record.status === "answered") {
        const accepted = handleQuestionPromptEvent(this.questionState, {
          event: "question.resolved",
          payload: { id, status: "answered", answers: record.answers },
        });
        if (!accepted) {
          this.requestError = "unavailable";
        }
      } else if (record.status === "cancelled" || record.status === "expired") {
        handleQuestionPromptEvent(this.questionState, {
          event: "question.resolved",
          payload: { id, status: record.status },
        });
      }
    } catch {
      if (this.client === client && this.operationGeneration === generation) {
        this.requestError = "unavailable";
      }
    } finally {
      if (this.client === client && this.operationGeneration === generation) {
        this.loading = false;
      }
    }
  }

  private renderQuestion(prompt: QuestionPrompt) {
    if (prompt.status !== "pending") {
      return html`
        <div class="approval-page__state" data-question-status=${prompt.status}>
          <h1>${this.questionStatusLabel(prompt)}</h1>
          ${renderChatQuestionSummary(prompt)}
        </div>
      `;
    }
    const props = createGatewayQuestionPanelProps(prompt, {
      onChange: () => this.requestUpdate(),
      onSubmit: (answers) => submitQuestionPrompt(this.questionState, prompt.id, answers),
      onSkip: () => cancelQuestionPrompt(this.questionState, prompt.id),
    });
    return html`<openclaw-chat-question-panel .props=${props}></openclaw-chat-question-panel>`;
  }

  private questionStatusLabel(prompt: QuestionPrompt): string {
    if (prompt.status === "answered") {
      return t("chat.questions.answered");
    }
    if (prompt.status === "cancelled") {
      return t("chat.questions.skipped");
    }
    if (prompt.status === "expired") {
      return t("chat.questions.expired");
    }
    return t("chat.questions.unavailable");
  }

  override render() {
    const prompt = listQuestionPrompts(this.questionState).find(
      (candidate) => candidate.id === this.questionId,
    );
    const content = this.loading
      ? html`<div class="approval-page__state" role="status">${t("common.loading")}</div>`
      : this.requestError
        ? html`<div class="approval-page__state" role="status">
            ${this.requestError === "connection"
              ? t("chat.questions.disconnected")
              : t("chat.questions.unavailable")}
          </div>`
        : prompt
          ? this.renderQuestion(prompt)
          : nothing;
    return html`
      <main
        class="approval-page question-page"
        data-state=${prompt?.status ?? this.requestError ?? "loading"}
      >
        <div class="approval-page__card approval-page__card--severity-info">
          <div class="approval-page__content">${content}</div>
        </div>
      </main>
    `;
  }
}
