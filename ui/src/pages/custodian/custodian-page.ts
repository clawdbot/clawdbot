import { consume } from "@lit/context";
import type { SystemAgentChatParams, SystemAgentChatResult } from "@openclaw/gateway-protocol";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import "../../components/option-card.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { searchForSession } from "../../lib/sessions/navigation.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../styles/custodian.css";
import { parseCustodianQuestion, type CustodianStructuredQuestion } from "./structured-question.ts";

const SYSTEM_AGENT_CHAT_TIMEOUT_MS = 190_000;

type CustodianMessage = {
  id: number;
  role: "assistant" | "user";
  text: string;
  question: CustodianStructuredQuestion | null;
};

function createSessionId(): string {
  if (typeof crypto.randomUUID === "function") {
    return `control-ui-onboarding-${crypto.randomUUID()}`;
  }
  const suffix = [...crypto.getRandomValues(new Uint32Array(4))]
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("");
  return `control-ui-onboarding-${suffix}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : t("custodian.requestFailed");
}

export class CustodianPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  /** Onboarding mode shows the Exit setup control; the route view sets this. */
  @property({ attribute: false }) onboarding = false;

  @state() private messages: CustodianMessage[] = [];
  @state() private input = "";
  @state() private sending = false;
  @state() private sensitive = false;
  @state() private error: string | null = null;
  @state() private dismissedQuestions = new Set<string>();
  @state() private answeredQuestions = new Set<string>();
  @state() private activeClient: GatewayBrowserClient | null = null;
  @state() private chatAvailable = false;

  private sessionId = createSessionId();
  private requestEpoch = 0;
  private nextMessageId = 1;
  private retryParams: SystemAgentChatParams | null = null;
  private sessionScopeKey: string | null = null;
  private sessionStarted = false;
  private lastHelloDeviceToken = "";
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.gateway,
    (gateway, notify) => gateway.subscribe(notify),
  );

  override disconnectedCallback(): void {
    this.requestEpoch += 1;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override updated(changedProperties: PropertyValues): void {
    this.synchronizeClient();
    if (changedProperties.has("messages")) {
      const lastMessage = this.querySelector(".custodian__messages")?.lastElementChild;
      if (lastMessage instanceof HTMLElement) {
        lastMessage.scrollIntoView?.({ block: "nearest" });
      }
    }
  }

  /**
   * Session ownership boundary: URL plus every presented credential. A client
   * swap with different auth on the same URL is a different operator; keeping
   * the transcript (or pending sensitive retryParams) would leak across logins.
   * Transport reconnects reuse the same client object and never hit this. The
   * store clears bootstrapToken on hello before the page sees a connected
   * client, so including it only resets across re-pairing handshakes.
   */
  private connectionScopeKey(): string {
    const { gatewayUrl, token, password, bootstrapToken } = this.context.gateway.connection;
    // Hello vanishes while the client retries a transient drop; keep the last
    // authenticated device token so a drop alone never crosses the session
    // boundary, while a new hello carrying a different stored-device token
    // still rotates the scope (shared-browser operator change).
    const hello = this.context.gateway.snapshot.hello;
    if (hello) {
      this.lastHelloDeviceToken = hello.auth?.deviceToken ?? "";
    }
    return JSON.stringify([gatewayUrl, token, password, bootstrapToken, this.lastHelloDeviceToken]);
  }

  private currentSessionScopeKey(): string {
    // Mode selects the welcome contract, so changing it starts a new session
    // instead of carrying the previous route's transcript across modes.
    return JSON.stringify([this.onboarding, this.connectionScopeKey()]);
  }

  private synchronizeClient(): void {
    const snapshot = this.context.gateway.snapshot;
    const client = snapshot.connected ? snapshot.client : null;
    const scopeKey = this.currentSessionScopeKey();
    const scopeChanged = this.sessionScopeKey !== null && this.sessionScopeKey !== scopeKey;
    if (client === this.activeClient && !scopeChanged) {
      return;
    }
    const requestWasPending = this.sending && this.retryParams !== null;
    this.activeClient = client;
    this.requestEpoch += 1;
    this.sending = false;
    this.chatAvailable = false;
    if (scopeChanged) {
      this.sessionScopeKey = scopeKey;
      this.sessionStarted = false;
      this.clearConversation();
    } else if (requestWasPending) {
      this.error = t("custodian.connectionChanged");
    }
    if (!client) {
      return;
    }
    if (isGatewayMethodAdvertised(snapshot, "openclaw.chat") !== true) {
      this.error = t("custodian.unsupportedGateway");
      return;
    }
    this.chatAvailable = true;
    if (this.sessionStarted && this.sessionScopeKey === scopeKey) {
      if (!this.retryParams) {
        this.error = null;
      }
      return;
    }
    this.sessionId = createSessionId();
    this.sessionScopeKey = scopeKey;
    this.sessionStarted = true;
    this.clearConversation();
    // The onboarding variant seeds the first-run setup proposal; the permanent
    // presence surface gets the normal caretaker greeting instead.
    void this.requestReply(client, {
      sessionId: this.sessionId,
      ...(this.onboarding ? { welcomeVariant: "onboarding" as const } : {}),
    });
  }

  private clearConversation(): void {
    this.messages = [];
    this.dismissedQuestions = new Set();
    this.answeredQuestions = new Set();
    this.retryParams = null;
    this.error = null;
    this.input = "";
    this.sensitive = false;
  }

  private appendAssistant(reply: string, question: CustodianStructuredQuestion | null): void {
    this.messages = [
      ...this.messages,
      {
        id: this.nextMessageId++,
        role: "assistant",
        text: reply,
        question,
      },
    ];
  }

  private async requestReply(
    client: GatewayBrowserClient,
    params: SystemAgentChatParams,
  ): Promise<void> {
    const epoch = ++this.requestEpoch;
    this.sending = true;
    this.error = null;
    this.retryParams = params;
    try {
      const result = await client.request<SystemAgentChatResult>("openclaw.chat", params, {
        timeoutMs: SYSTEM_AGENT_CHAT_TIMEOUT_MS,
      });
      if (epoch !== this.requestEpoch || client !== this.activeClient) {
        return;
      }
      this.sessionId = result.sessionId;
      this.sensitive = result.sensitive === true;
      this.retryParams = null;
      this.appendAssistant(result.reply, parseCustodianQuestion(result.question));
      if (result.action === "open-agent") {
        const sessionKey = this.context.gateway.snapshot.sessionKey?.trim();
        if (result.agentDraft === "hatch" && sessionKey) {
          // Preserve the destination session while preloading the localized
          // birth-sequence opener; draft-only chat routes are intentionally invalid.
          this.context.navigate("chat", {
            search: `${searchForSession(sessionKey)}&draft=${encodeURIComponent(t("custodian.hatchDraft"))}`,
          });
        } else {
          this.exitSetup();
        }
      } else if (result.action === "exit") {
        this.exitSetup();
      }
    } catch (error) {
      if (epoch === this.requestEpoch && client === this.activeClient) {
        this.error = errorMessage(error);
      }
      // A failed user turn may still have reached the agent and acted; there is
      // no turn idempotency, so never keep it replayable (or its raw text).
      if (params.message !== undefined && this.retryParams === params) {
        this.retryParams = null;
      }
    } finally {
      if (epoch === this.requestEpoch) {
        this.sending = false;
      }
    }
  }

  private send(text = this.input, display?: string): void {
    // Trim decides emptiness only; sensitive values (credentials) may carry
    // meaningful whitespace and must reach the agent exactly as entered.
    const message = this.sensitive ? text : text.trim();
    const client = this.activeClient;
    if (!message.trim() || !client || !this.chatAvailable || this.sending) {
      return;
    }
    const displayText = this.sensitive ? t("custodian.sensitiveReply") : (display ?? message);
    this.retireQuestions();
    this.messages = [
      ...this.messages,
      { id: this.nextMessageId++, role: "user", text: displayText, question: null },
    ];
    this.input = "";
    void this.requestReply(client, {
      sessionId: this.sessionId,
      ...(this.onboarding ? { welcomeVariant: "onboarding" as const } : {}),
      message,
    });
  }

  private dismissQuestion(message: CustodianMessage): void {
    const questionId = message.question?.id;
    if (!questionId) {
      return;
    }
    this.dismissedQuestions = new Set(this.dismissedQuestions).add(`${message.id}:${questionId}`);
    this.send(t("optionCard.skip"));
  }

  private answerQuestion(message: CustodianMessage, label: string): void {
    const question = message.question;
    if (!question) {
      return;
    }
    const option = question.options.find((candidate) => candidate.label === label);
    this.answeredQuestions = new Set(this.answeredQuestions).add(`${message.id}:${question.id}`);
    // The transcript shows the friendly label; the engine receives the reply
    // text it actually parses (wizard answers, canonical commands).
    this.send(option?.reply ?? label, label);
  }

  private retireQuestions(): void {
    const answered = new Set(this.answeredQuestions);
    for (const message of this.messages) {
      if (message.question) {
        answered.add(`${message.id}:${message.question.id}`);
      }
    }
    this.answeredQuestions = answered;
  }

  private exitSetup(): void {
    this.context.navigate("chat");
  }

  private canRetry(): boolean {
    // Only the welcome request is safely replayable; a user turn has no
    // idempotency key and may have already acted on the agent side.
    return this.retryParams !== null && this.retryParams.message === undefined;
  }

  private retry(): void {
    const client = this.activeClient;
    const params = this.retryParams;
    if (client && params && params.message === undefined && this.chatAvailable && !this.sending) {
      void this.requestReply(client, params);
    }
  }

  private handleComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
      return;
    }
    event.preventDefault();
    this.send();
  }

  override render() {
    return html`
      <section class="custodian">
        <header class="custodian__header">
          <div class="custodian__identity">
            <div class="custodian__mark" aria-hidden="true">OC</div>
            <div>
              <h1>${t("custodian.title")}</h1>
              <p>${t("custodian.subtitle")}</p>
            </div>
          </div>
          ${this.onboarding
            ? html`<button class="btn btn--ghost" type="button" @click=${() => this.exitSetup()}>
                ${t("custodian.exitSetup")}
              </button>`
            : nothing}
        </header>

        <div class="custodian__messages" aria-live="polite">
          ${this.messages.map((message) => {
            const questionKey = message.question ? `${message.id}:${message.question.id}` : "";
            const showQuestion =
              message.question !== null && !this.dismissedQuestions.has(questionKey);
            return html`
              <article class=${`custodian__message custodian__message--${message.role}`}>
                ${message.text
                  ? html`<div class="custodian__message-text chat-text">
                      ${message.role === "assistant"
                        ? unsafeHTML(toSanitizedMarkdownHtml(message.text))
                        : message.text}
                    </div>`
                  : nothing}
                ${showQuestion
                  ? html`<openclaw-option-card
                      .props=${{
                        header: message.question!.header,
                        question: message.question!.question,
                        options: message.question!.options.map((option) => ({
                          value: option.label,
                          label: option.label,
                          description: option.description,
                          recommended: option.recommended,
                        })),
                        disabled:
                          this.sending ||
                          !this.chatAvailable ||
                          this.answeredQuestions.has(questionKey),
                        onSelect: (label: string) => this.answerQuestion(message, label),
                        onSkip: () => this.dismissQuestion(message),
                      }}
                    ></openclaw-option-card>`
                  : nothing}
              </article>
            `;
          })}
          ${this.sending
            ? html`<div class="custodian__thinking" role="status">
                <span></span><span></span><span></span>
                <span class="sr-only">${t("custodian.thinking")}</span>
              </div>`
            : nothing}
          ${this.error
            ? html`<div class="custodian__error" role="alert">
                <span>${this.error}</span>
                ${this.activeClient && this.chatAvailable && this.canRetry()
                  ? html`<button class="btn btn--sm" type="button" @click=${() => this.retry()}>
                      ${t("common.retry")}
                    </button>`
                  : nothing}
              </div>`
            : nothing}
        </div>

        <div class="custodian__composer">
          ${this.sensitive
            ? html`<input
                type="password"
                .value=${this.input}
                autocomplete="off"
                placeholder=${t("custodian.sensitivePlaceholder")}
                aria-label=${t("custodian.sensitivePlaceholder")}
                ?disabled=${!this.activeClient || !this.chatAvailable || this.sending}
                @input=${(event: Event) => (this.input = (event.target as HTMLInputElement).value)}
                @keydown=${(event: KeyboardEvent) => this.handleComposerKeydown(event)}
              />`
            : html`<textarea
                rows="1"
                .value=${this.input}
                autocomplete="on"
                placeholder=${t("custodian.placeholder")}
                aria-label=${t("custodian.placeholder")}
                ?disabled=${!this.activeClient || !this.chatAvailable || this.sending}
                @input=${(event: Event) =>
                  (this.input = (event.target as HTMLTextAreaElement).value)}
                @keydown=${(event: KeyboardEvent) => this.handleComposerKeydown(event)}
              ></textarea>`}
          <button
            class="btn primary"
            type="button"
            ?disabled=${!this.input.trim() ||
            !this.activeClient ||
            !this.chatAvailable ||
            this.sending}
            @click=${() => this.send()}
          >
            ${t("custodian.send")}
          </button>
        </div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-custodian-page")) {
  customElements.define("openclaw-custodian-page", CustodianPage);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-custodian-page": CustodianPage;
  }
}
