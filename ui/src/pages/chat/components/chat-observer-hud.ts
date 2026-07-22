import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  SessionObserverDigest,
  SessionsObserverAskResult,
} from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ControlUiSessionPullRequest } from "../../../../../src/gateway/control-ui-contract.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { formatDurationCompact } from "../../../lib/format.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import {
  type ChatObserverDisplayPreference,
  loadChatObserverDisplayPreference,
  storeChatObserverDisplayPreference,
} from "../chat-observer-display.ts";
import type { PlanStatus } from "../tool-stream.ts";

const MAX_ASK_EXCHANGES = 6;
const OBSERVER_BUSY_DETAIL_CODE = "SESSION_OBSERVER_BUSY";

export type ObserverHudMode = "hidden" | "restore" | "pill" | "card";
export type ObserverAskHint = "busy" | "unavailable";
export type ObserverAskExchange = {
  question: string;
  answer?: string;
  hint?: ObserverAskHint;
};

function errorDetailCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== "object") {
    return null;
  }
  const code = (details as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export class ChatObserverAskState {
  sessionKey = "";
  exchanges: ObserverAskExchange[] = [];
  pending = false;
  private generation = 0;

  switchSession(sessionKey: string): void {
    if (sessionKey === this.sessionKey) {
      return;
    }
    this.sessionKey = sessionKey;
    this.exchanges = [];
    this.pending = false;
    this.generation += 1;
  }

  async submit(
    question: string,
    ask: (sessionKey: string, question: string) => Promise<SessionsObserverAskResult>,
  ): Promise<void> {
    const normalized = question.trim();
    if (!normalized || !this.sessionKey || this.pending) {
      return;
    }
    const sessionKey = this.sessionKey;
    const generation = this.generation;
    const exchange: ObserverAskExchange = { question: normalized };
    this.exchanges = [...this.exchanges, exchange].slice(-MAX_ASK_EXCHANGES);
    this.pending = true;
    try {
      const result = await ask(sessionKey, normalized);
      if (generation === this.generation && sessionKey === this.sessionKey) {
        exchange.answer = result.answer;
        this.exchanges = [...this.exchanges];
      }
    } catch (error) {
      if (generation === this.generation && sessionKey === this.sessionKey) {
        exchange.hint =
          errorDetailCode(error) === OBSERVER_BUSY_DETAIL_CODE ? "busy" : "unavailable";
        this.exchanges = [...this.exchanges];
      }
    } finally {
      if (generation === this.generation && sessionKey === this.sessionKey) {
        this.pending = false;
      }
    }
  }
}

export type ObserverHudInput = {
  running: boolean;
  activeRunId: string | null;
  digest: SessionObserverDigest | null;
  lastReadAt?: number;
  sideChatOpen: boolean;
};

function visibleDigest(input: ObserverHudInput): SessionObserverDigest | null {
  if (!input.digest) {
    return null;
  }
  if (!input.running) {
    return input.digest;
  }
  return input.activeRunId && input.digest.runId === input.activeRunId ? input.digest : null;
}

function unreadFinalDigest(digest: SessionObserverDigest, lastReadAt?: number): boolean {
  return (
    (digest.health === "done" || digest.health === "failed") && (lastReadAt ?? 0) < digest.updatedAt
  );
}

/** State owner for preference, once-per-run critical expansion, and side-chat yield. */
export class ChatObserverHudState {
  private autoExpandedRunIds = new Set<string>();
  private autoExpandedRunId: string | null = null;

  constructor(
    private displayPreference: ChatObserverDisplayPreference = loadChatObserverDisplayPreference(),
  ) {}

  mode(input: ObserverHudInput): ObserverHudMode {
    const digest = visibleDigest(input);
    const renderable =
      digest !== null && (input.running || unreadFinalDigest(digest, input.lastReadAt));
    if (this.displayPreference === "off") {
      this.autoExpandedRunId = null;
      // A running chat keeps the restore control even before any digest exists:
      // hidden visibility stops generation, so waiting for a digest would leave
      // no rendered way to turn the observer back on.
      return input.running || renderable ? "restore" : "hidden";
    }
    if (!renderable) {
      // The transient critical-expansion latch must not survive the HUD hiding,
      // or a later benign digest under a reused run id reopens as a card.
      this.autoExpandedRunId = null;
      return "hidden";
    }
    const runId = input.activeRunId ?? digest.runId ?? null;
    const critical = digest.health === "stuck" || digest.health === "waiting-on-user";
    if (critical && runId && !this.autoExpandedRunIds.has(runId)) {
      this.autoExpandedRunIds.add(runId);
      this.autoExpandedRunId = runId;
    }
    if (input.sideChatOpen) {
      return "pill";
    }
    return this.displayPreference === "card" || (runId !== null && this.autoExpandedRunId === runId)
      ? "card"
      : "pill";
  }

  expand(): void {
    this.displayPreference = "card";
    this.autoExpandedRunId = null;
    storeChatObserverDisplayPreference("card");
  }

  collapse(): void {
    this.displayPreference = "pill";
    this.autoExpandedRunId = null;
    storeChatObserverDisplayPreference("pill");
  }

  hide(): void {
    this.displayPreference = "off";
    this.autoExpandedRunId = null;
    storeChatObserverDisplayPreference("off");
  }

  show(): void {
    this.displayPreference = "pill";
    this.autoExpandedRunId = null;
    storeChatObserverDisplayPreference("pill");
  }
}

function healthLabel(health: SessionObserverDigest["health"]): string {
  return t(`chat.observer.health.${health}` as Parameters<typeof t>[0]);
}

function prStateLabel(pullRequestState: ControlUiSessionPullRequest["state"]): string {
  return t(
    `chat.pullRequests.${pullRequestState === "draft" ? "draft" : pullRequestState}` as Parameters<
      typeof t
    >[0],
  );
}

function checksSummary(pullRequest: ControlUiSessionPullRequest): string | null {
  const checks = pullRequest.checks;
  if (!checks) {
    return null;
  }
  if (checks.state === "passing") {
    return t("chat.observer.checksPassing", { count: String(checks.passed) });
  }
  if (checks.state === "failing") {
    return t("chat.observer.checksFailing", { count: String(checks.failed) });
  }
  return t("chat.observer.checksPending", { count: String(checks.running) });
}

function renderPlanStep(step: PlanStatus["steps"][number]) {
  const icon = step.status === "completed" ? "✓" : step.status === "in_progress" ? "→" : "·";
  return html`
    <li class="chat-observer-hud__plan-item" data-status=${step.status}>
      <span class="chat-observer-hud__plan-icon" aria-hidden="true">${icon}</span>
      <span>${step.step}</span>
    </li>
  `;
}

export class ChatObserverHudElement extends OpenClawLightDomElement {
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) digest: SessionObserverDigest | null = null;
  @property({ attribute: false }) running = false;
  @property({ attribute: false }) activeRunId: string | null = null;
  @property({ attribute: false }) startedAt?: number;
  @property({ attribute: false }) lastReadAt?: number;
  @property({ attribute: false }) sideChatOpen = false;
  @property({ attribute: false }) planStatus: PlanStatus | null = null;
  @property({ attribute: false }) pullRequests: ControlUiSessionPullRequest[] = [];
  @property({ attribute: false }) onAsk?: (
    sessionKey: string,
    question: string,
  ) => Promise<SessionsObserverAskResult>;
  @property({ attribute: false }) onVisibilityChange?: (visible: boolean) => void;
  @state() private now = Date.now();
  @state() private question = "";
  @state() private askRevision = 0;

  private readonly hudState = new ChatObserverHudState();
  private readonly askState = new ChatObserverAskState();
  private clock: ReturnType<typeof globalThis.setTimeout> | null = null;

  override disconnectedCallback() {
    this.stopClock();
    super.disconnectedCallback();
  }

  protected override willUpdate(changedProperties: PropertyValues<this>) {
    if (changedProperties.has("sessionKey")) {
      this.askState.switchSession(this.sessionKey);
      this.question = "";
    }
  }

  override updated() {
    if (this.running && this.startedAt != null && visibleDigest(this.input())) {
      this.scheduleClock();
    } else {
      this.stopClock();
    }
  }

  private scheduleClock() {
    if (this.clock !== null) {
      return;
    }
    this.clock = globalThis.setTimeout(() => {
      this.clock = null;
      this.now = Date.now();
    }, 1_000);
  }

  private stopClock() {
    if (this.clock !== null) {
      globalThis.clearTimeout(this.clock);
      this.clock = null;
    }
  }

  private input(): ObserverHudInput {
    return {
      running: this.running,
      activeRunId: this.activeRunId,
      digest: this.digest,
      lastReadAt: this.lastReadAt,
      sideChatOpen: this.sideChatOpen,
    };
  }

  private collapse() {
    this.hudState.collapse();
    this.requestUpdate();
  }

  private expand() {
    this.hudState.expand();
    this.requestUpdate();
  }

  private hide() {
    this.hudState.hide();
    this.onVisibilityChange?.(false);
    this.requestUpdate();
  }

  private show() {
    this.hudState.show();
    this.onVisibilityChange?.(true);
    this.requestUpdate();
  }

  private renderStatus(health: SessionObserverDigest["health"], label: string) {
    return html`
      <span class="chat-observer-hud__status" data-health=${health}>
        <span class="chat-observer-hud__status-dot"></span>${label}
      </span>
    `;
  }

  private async submitQuestion() {
    const question = this.question.trim();
    if (!question || !this.onAsk || this.askState.pending) {
      return;
    }
    this.question = "";
    const pending = this.askState.submit(question, this.onAsk);
    this.askRevision += 1;
    await pending;
    this.askRevision += 1;
  }

  private renderAskThread() {
    // Reading the revision makes mutations in the deliberately small state
    // machine visible to Lit without moving this client-only thread upstream.
    void this.askRevision;
    if (this.askState.exchanges.length === 0) {
      return nothing;
    }
    return html`
      <div class="chat-observer-hud__ask-thread" aria-live="polite">
        ${this.askState.exchanges.map(
          (exchange, index) => html`
            <div class="chat-observer-hud__ask-exchange">
              <div class="chat-observer-hud__ask-question">${exchange.question}</div>
              ${exchange.answer
                ? html`<div class="chat-observer-hud__ask-answer">${exchange.answer}</div>`
                : exchange.hint
                  ? html`<div class="chat-observer-hud__ask-hint">
                      ${t(
                        exchange.hint === "busy"
                          ? "chat.observer.askBusy"
                          : "chat.observer.askUnavailable",
                      )}
                    </div>`
                  : this.askState.pending && index === this.askState.exchanges.length - 1
                    ? html`<div class="chat-observer-hud__ask-hint">
                        ${t("chat.observer.askPending")}
                      </div>`
                    : nothing}
            </div>
          `,
        )}
      </div>
    `;
  }

  private renderPullRequests() {
    const pullRequests = this.pullRequests.slice(0, 2);
    if (pullRequests.length === 0) {
      return nothing;
    }
    return html`
      <div class="chat-observer-hud__prs" aria-label=${t("chat.observer.pullRequests")}>
        ${pullRequests.map((pullRequest) => {
          const checks = checksSummary(pullRequest);
          return html`
            <a
              class="chat-observer-hud__pr"
              href=${pullRequest.url}
              target="_blank"
              rel="noopener noreferrer"
              title=${pullRequest.title}
            >
              <span>#${pullRequest.number}</span>
              <span>${prStateLabel(pullRequest.state)}</span>
              ${checks
                ? html`<span class="chat-observer-hud__pr-checks">${checks}</span>`
                : nothing}
            </a>
          `;
        })}
      </div>
    `;
  }

  override render() {
    const input = this.input();
    const mode = this.hudState.mode(input);
    if (mode === "hidden") {
      return nothing;
    }
    if (mode === "restore") {
      // Renders digest-free: while hidden, generation is off and a running chat
      // may never receive one.
      return html`
        <button
          class="btn btn--ghost btn--icon chat-icon-btn chat-observer-hud chat-observer-hud--restore"
          type="button"
          aria-label=${t("chat.observer.show")}
          title=${t("chat.observer.show")}
          @click=${() => this.show()}
        >
          ${icons.activity}
        </button>
      `;
    }
    const digest = visibleDigest(input);
    if (!digest) {
      return nothing;
    }
    const headline = digest.headline;
    const health = digest.health;
    const label = healthLabel(health);
    if (mode === "pill") {
      return html`
        <div class="chat-observer-hud chat-observer-hud--pill" aria-live="polite">
          ${this.renderStatus(health, label)}
          <button
            class="chat-observer-hud__expand"
            type="button"
            aria-label=${t("chat.observer.expand")}
            @click=${() => this.expand()}
          >
            <span class="chat-observer-hud__headline">${headline}</span>
          </button>
          <button
            class="btn btn--ghost btn--icon chat-icon-btn chat-observer-hud__hide"
            type="button"
            aria-label=${t("chat.observer.hide")}
            @click=${() => this.hide()}
          >
            ${icons.x}
          </button>
          <button
            class="btn btn--ghost btn--icon chat-icon-btn chat-observer-hud__toggle"
            type="button"
            aria-label=${t("chat.observer.expand")}
            @click=${() => this.expand()}
          >
            ${icons.chevronDown}
          </button>
        </div>
      `;
    }

    const elapsed =
      this.startedAt == null ? null : formatDurationCompact(Math.max(0, this.now - this.startedAt));
    const progress = digest.planProgress;
    const steps = this.planStatus?.steps.slice(-3) ?? [];
    return html`
      <section
        class="chat-observer-hud chat-observer-hud--card"
        role="region"
        aria-live="polite"
        aria-label=${t("chat.observer.title")}
        tabindex="-1"
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            this.collapse();
          }
        }}
      >
        <header class="chat-observer-hud__header">
          ${this.renderStatus(health, label)}
          <strong class="chat-observer-hud__headline">${headline}</strong>
          <button
            class="btn btn--ghost btn--icon chat-icon-btn chat-observer-hud__hide"
            type="button"
            aria-label=${t("chat.observer.hide")}
            @click=${() => this.hide()}
          >
            ${icons.x}
          </button>
          <button
            class="btn btn--ghost btn--icon chat-icon-btn chat-observer-hud__toggle"
            type="button"
            aria-label=${t("chat.observer.collapse")}
            @click=${() => this.collapse()}
          >
            ${icons.chevronUp}
          </button>
        </header>
        ${digest.assessment
          ? html`<p class="chat-observer-hud__assessment">${digest.assessment}</p>`
          : nothing}
        ${progress || steps.length > 0
          ? html`
              <div class="chat-observer-hud__plan">
                <div class="chat-observer-hud__plan-heading">
                  <span>${t("chat.observer.plan")}</span>
                  ${progress
                    ? html`<span
                        >${t("chat.observer.progress", {
                          completed: String(progress.completed),
                          total: String(progress.total),
                        })}</span
                      >`
                    : nothing}
                </div>
                ${steps.length > 0
                  ? html`<ul class="chat-observer-hud__plan-list">
                      ${steps.map(renderPlanStep)}
                    </ul>`
                  : nothing}
              </div>
            `
          : nothing}
        ${this.renderPullRequests()}
        ${this.running || elapsed
          ? html`
              <footer class="chat-observer-hud__footer">
                ${this.running
                  ? html`<span class="chat-observer-hud__run-dot" data-running></span>
                      <span>${t("chat.observer.running")}</span>`
                  : nothing}
                ${this.running && elapsed ? html`<span aria-hidden="true">·</span>` : nothing}
                ${elapsed ? html`<span>${elapsed}</span>` : nothing}
              </footer>
            `
          : nothing}
        ${this.renderAskThread()}
        <form
          class="chat-observer-hud__ask-form"
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            void this.submitQuestion();
          }}
        >
          <label class="chat-observer-hud__ask-field">
            <span class="sr-only">${t("chat.observer.askLabel")}</span>
            <input
              class="chat-observer-hud__ask-input"
              type="text"
              maxlength="400"
              autocomplete="off"
              .value=${this.question}
              placeholder=${t("chat.observer.askPlaceholder")}
              ?disabled=${this.askState.pending || !this.onAsk}
              @input=${(event: InputEvent) => {
                this.question = (event.currentTarget as HTMLInputElement).value;
              }}
            />
          </label>
          <button
            class="btn btn--ghost chat-observer-hud__ask-submit"
            type="submit"
            ?disabled=${this.askState.pending || !this.question.trim() || !this.onAsk}
          >
            ${t("chat.observer.askSubmit")}
          </button>
        </form>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-chat-observer-hud")) {
  customElements.define("openclaw-chat-observer-hud", ChatObserverHudElement);
}
