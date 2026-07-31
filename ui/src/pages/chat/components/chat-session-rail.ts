import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { SessionObserverDigest } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ControlUiSessionPullRequest } from "../../../../../src/gateway/control-ui-contract.js";
import { icons } from "../../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { formatDurationCompact, formatTimeAgo, formatTimeMs } from "../../../lib/format.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import {
  type ChatObserverDisplayPreference,
  loadChatObserverDisplayPreference,
  storeChatObserverDisplayPreference,
} from "../chat-observer-display.ts";
import type { ChatSessionCompanionThread } from "../chat-session-companion.ts";
import type { PlanStatus } from "../tool-stream.ts";

export type SessionRailMode = "hidden" | "restore-icon" | "pill" | "expanded";

export type SessionRailInput = {
  running: boolean;
  activeRunId: string | null;
  digest: SessionObserverDigest | null;
  lastReadAt?: number;
  hasCompanionActivity: boolean;
};

function visibleDigest(input: SessionRailInput): SessionObserverDigest | null {
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

/** State owner for the persisted rail preference and once-per-run critical expansion. */
export class ChatSessionRailState {
  private autoExpandedRunIds = new Set<string>();
  private autoExpandedRunId: string | null = null;
  // Explicit open from the restore icon while idle: the companion must stay
  // reachable at any point, even with no digest and an empty thread.
  private manualOpen = false;

  constructor(
    private displayPreference: ChatObserverDisplayPreference = loadChatObserverDisplayPreference(),
  ) {}

  resetManualOpen(): void {
    this.manualOpen = false;
  }

  mode(input: SessionRailInput): SessionRailMode {
    const digest = visibleDigest(input);
    const digestRenderable =
      digest !== null && (input.running || unreadFinalDigest(digest, input.lastReadAt));
    const renderable = digestRenderable || input.hasCompanionActivity || this.manualOpen;
    if (this.displayPreference === "off") {
      this.autoExpandedRunId = null;
      return "restore-icon";
    }
    if (!renderable) {
      this.autoExpandedRunId = null;
      // Idle sessions keep the low-noise restore icon so companion questions
      // stay one click away after a run's final digest has been read.
      return "restore-icon";
    }
    const runId = input.activeRunId ?? digest?.runId ?? null;
    const critical = digest?.health === "stuck" || digest?.health === "waiting-on-user";
    if (critical && runId && !this.autoExpandedRunIds.has(runId)) {
      this.autoExpandedRunIds.add(runId);
      this.autoExpandedRunId = runId;
    }
    return this.displayPreference === "card" || (runId !== null && this.autoExpandedRunId === runId)
      ? "expanded"
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
    this.manualOpen = false;
    storeChatObserverDisplayPreference("off");
  }

  show(): void {
    this.displayPreference = "pill";
    this.autoExpandedRunId = null;
    this.manualOpen = true;
    storeChatObserverDisplayPreference("pill");
  }
}

function healthLabel(health: SessionObserverDigest["health"]): string {
  return t(`chat.rail.health.${health}` as Parameters<typeof t>[0]);
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
    return t("chat.rail.checksPassing", { count: String(checks.passed) });
  }
  if (checks.state === "failing") {
    return t("chat.rail.checksFailing", { count: String(checks.failed) });
  }
  return t("chat.rail.checksPending", { count: String(checks.running) });
}

function renderPlanStep(step: PlanStatus["steps"][number]) {
  const icon = step.status === "completed" ? "✓" : step.status === "in_progress" ? "→" : "·";
  return html`
    <li class="chat-session-rail__plan-item" data-status=${step.status}>
      <span class="chat-session-rail__plan-icon" aria-hidden="true">${icon}</span>
      <span>${step.step}</span>
    </li>
  `;
}

function companionHasActivity(thread: ChatSessionCompanionThread): boolean {
  return (
    thread.exchanges.length > 0 ||
    thread.pendingQuestion !== null ||
    thread.failedQuestion !== null ||
    thread.draft.length > 0
  );
}

export class ChatSessionRailElement extends OpenClawLightDomElement {
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) digest: SessionObserverDigest | null = null;
  @property({ attribute: false }) running = false;
  @property({ attribute: false }) activeRunId: string | null = null;
  @property({ attribute: false }) startedAt?: number;
  @property({ attribute: false }) lastReadAt?: number;
  @property({ attribute: false }) planStatus: PlanStatus | null = null;
  @property({ attribute: false }) pullRequests: ControlUiSessionPullRequest[] = [];
  @property({ attribute: false }) companion: ChatSessionCompanionThread = {
    exchanges: [],
    pendingQuestion: null,
    failedQuestion: null,
    hint: null,
    draft: "",
  };
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) openRequest = 0;
  @property({ attribute: false }) onSubmit?: (question: string) => void;
  @property({ attribute: false }) onDraftChange?: (draft: string) => void;
  @property({ attribute: false }) onClear?: () => void;
  @property({ attribute: false }) onModeChange?: (mode: SessionRailMode) => void;
  @property({ attribute: false }) onVisibilityChange?: (visible: boolean) => void;
  @state() private now = Date.now();

  private readonly railState = new ChatSessionRailState();
  private clock: ReturnType<typeof globalThis.setTimeout> | null = null;
  private renderedMode: SessionRailMode = "hidden";
  private reportedMode: SessionRailMode | null = null;
  private terminalAgeReference = Date.now();

  override disconnectedCallback() {
    this.stopClock();
    super.disconnectedCallback();
  }

  protected override willUpdate(changedProperties: PropertyValues<this>) {
    if (changedProperties.has("sessionKey")) {
      this.terminalAgeReference = Date.now();
      // A manual idle-open is a per-session gesture; it must not leak the
      // rail open into the next selected session.
      this.railState.resetManualOpen();
    }
    if (changedProperties.has("digest") && this.digest) {
      if (this.digest.health === "done" || this.digest.health === "failed") {
        this.terminalAgeReference = Date.now();
      }
    }
    if (changedProperties.has("openRequest") && this.openRequest > 0) {
      this.railState.expand();
      this.onVisibilityChange?.(true);
    }
  }

  override updated() {
    if (this.running && this.startedAt != null && visibleDigest(this.input())) {
      this.scheduleClock();
    } else {
      this.stopClock();
    }
    if (this.reportedMode !== this.renderedMode) {
      this.reportedMode = this.renderedMode;
      this.onModeChange?.(this.renderedMode);
    }
  }

  private input(): SessionRailInput {
    return {
      running: this.running,
      activeRunId: this.activeRunId,
      digest: this.digest,
      lastReadAt: this.lastReadAt,
      hasCompanionActivity: companionHasActivity(this.companion) || this.openRequest > 0,
    };
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

  private collapse() {
    this.railState.collapse();
    this.requestUpdate();
  }

  private expand() {
    this.railState.expand();
    this.requestUpdate();
  }

  private hide() {
    this.railState.hide();
    this.onVisibilityChange?.(false);
    this.requestUpdate();
  }

  private show() {
    this.railState.show();
    this.onVisibilityChange?.(true);
    this.requestUpdate();
  }

  private submit() {
    const question = this.companion.draft.trim();
    if (!question || !this.connected || this.companion.pendingQuestion || !this.onSubmit) {
      return;
    }
    this.onSubmit(question);
  }

  private renderStatus(digest: SessionObserverDigest): TemplateResult {
    const terminal = digest.health === "done" || digest.health === "failed";
    const critical = digest.health === "stuck" || digest.health === "waiting-on-user";
    return html`
      <span
        class="chat-session-rail__status ${critical ? "chat-session-rail__status--critical" : ""}"
        data-health=${digest.health}
      >
        ${terminal
          ? html`<span class="chat-session-rail__status-icon" aria-hidden="true"
              >${digest.health === "done" ? icons.check : icons.x}</span
            >`
          : html`<span class="chat-session-rail__status-dot" aria-hidden="true"></span>`}
        <span>${healthLabel(digest.health)}</span>
      </span>
    `;
  }

  private renderPullRequests() {
    const pullRequests = this.pullRequests.slice(0, 2);
    if (pullRequests.length === 0) {
      return nothing;
    }
    return html`
      <div class="chat-session-rail__prs" aria-label=${t("chat.rail.pullRequests")}>
        ${pullRequests.map((pullRequest) => {
          const checks = checksSummary(pullRequest);
          return html`
            <a
              class="chat-session-rail__pr"
              href=${pullRequest.url}
              target="_blank"
              rel="noopener noreferrer"
              title=${pullRequest.title}
            >
              <span>#${pullRequest.number}</span>
              <span>${prStateLabel(pullRequest.state)}</span>
              ${checks
                ? html`<span class="chat-session-rail__pr-checks">${checks}</span>`
                : nothing}
            </a>
          `;
        })}
      </div>
    `;
  }

  private renderDigestDetails(digest: SessionObserverDigest | null) {
    if (!digest) {
      return nothing;
    }
    const progress = digest.planProgress;
    const steps = this.planStatus?.steps.slice(-3) ?? [];
    return html`
      ${digest.assessment
        ? html`<p class="chat-session-rail__assessment">${digest.assessment}</p>`
        : nothing}
      ${progress || steps.length > 0
        ? html`
            <div class="chat-session-rail__plan">
              <div class="chat-session-rail__plan-heading">
                <span>${t("chat.rail.plan")}</span>
                ${progress
                  ? html`<span
                      >${t("chat.rail.progress", {
                        completed: String(progress.completed),
                        total: String(progress.total),
                      })}</span
                    >`
                  : nothing}
              </div>
              ${steps.length > 0
                ? html`<ul class="chat-session-rail__plan-list">
                    ${steps.map(renderPlanStep)}
                  </ul>`
                : nothing}
            </div>
          `
        : nothing}
      ${this.renderPullRequests()}
    `;
  }

  private renderExchange(question: string, answer: string, ts: number) {
    return html`
      <article class="chat-session-rail__exchange">
        <div class="chat-session-rail__question" dir=${detectTextDirection(question)}>
          ${question}
        </div>
        <div class="chat-session-rail__answer" dir=${detectTextDirection(answer)}>
          ${unsafeHTML(toSanitizedMarkdownHtml(answer))}
        </div>
        <time class="chat-session-rail__timestamp" datetime=${new Date(ts).toISOString()}>
          ${t("chat.rail.asOf", {
            time: formatTimeMs(ts, { hour: "numeric", minute: "2-digit" }, ""),
          })}
        </time>
      </article>
    `;
  }

  private renderThread() {
    const scrollKey = `${this.companion.exchanges.length}:${this.companion.pendingQuestion ?? ""}:${this.companion.failedQuestion ?? ""}`;
    const syncScroll = (element: Element | undefined) => {
      if (!(element instanceof HTMLElement) || element.dataset.railScrollKey === scrollKey) {
        return;
      }
      element.dataset.railScrollKey = scrollKey;
      element.scrollTop = element.scrollHeight;
    };
    return html`
      <div class="chat-session-rail__thread" aria-live="polite" ${ref(syncScroll)}>
        ${this.companion.exchanges.length === 0 && !this.companion.pendingQuestion
          ? html`<p class="chat-session-rail__empty">${t("chat.rail.empty")}</p>`
          : nothing}
        ${this.companion.exchanges.map((exchange) =>
          this.renderExchange(exchange.question, exchange.answer, exchange.ts),
        )}
        ${this.companion.failedQuestion && this.companion.hint
          ? html`
              <article class="chat-session-rail__exchange chat-session-rail__exchange--error">
                <div class="chat-session-rail__question">${this.companion.failedQuestion}</div>
                <div class="chat-session-rail__hint">
                  ${t(
                    this.companion.hint === "busy"
                      ? "chat.rail.askBusy"
                      : "chat.rail.askUnavailable",
                  )}
                </div>
              </article>
            `
          : nothing}
        ${this.companion.pendingQuestion
          ? html`
              <article class="chat-session-rail__exchange chat-session-rail__exchange--pending">
                <div class="chat-session-rail__question">${this.companion.pendingQuestion}</div>
                <div class="chat-session-rail__hint">${t("chat.rail.askPending")}</div>
              </article>
            `
          : nothing}
      </div>
    `;
  }

  override render() {
    const input = this.input();
    const mode = this.railState.mode(input);
    this.renderedMode = mode;
    if (mode === "hidden") {
      return nothing;
    }
    if (mode === "restore-icon") {
      return html`
        <button
          class="btn btn--ghost btn--icon chat-icon-btn chat-session-rail chat-session-rail--restore"
          type="button"
          aria-label=${t("chat.rail.show")}
          title=${t("chat.rail.show")}
          @click=${() => this.show()}
        >
          ${icons.activity}
        </button>
      `;
    }
    const digest = visibleDigest(input);
    if (mode === "pill") {
      return html`
        <div class="chat-session-rail chat-session-rail--pill" aria-live="polite">
          ${digest ? this.renderStatus(digest) : nothing}
          <button
            class="chat-session-rail__expand"
            type="button"
            aria-label=${t("chat.rail.expand")}
            @click=${() => this.expand()}
          >
            <span class="chat-session-rail__headline"
              >${digest?.headline ?? t("chat.rail.title")}</span
            >
          </button>
          <button
            class="btn btn--ghost btn--icon chat-icon-btn chat-session-rail__hide"
            type="button"
            aria-label=${t("chat.rail.hide")}
            @click=${() => this.hide()}
          >
            ${icons.x}
          </button>
          <button
            class="btn btn--ghost btn--icon chat-icon-btn chat-session-rail__toggle"
            type="button"
            aria-label=${t("chat.rail.expand")}
            @click=${() => this.expand()}
          >
            ${icons.chevronDown}
          </button>
        </div>
      `;
    }

    const elapsed =
      this.running && this.startedAt != null
        ? formatDurationCompact(Math.max(0, this.now - this.startedAt))
        : null;
    const finished =
      digest && (digest.health === "done" || digest.health === "failed")
        ? t("chat.rail.finished", {
            time: formatTimeAgo(Math.max(0, this.terminalAgeReference - digest.updatedAt)),
          })
        : null;
    return html`
      <section
        class="chat-session-rail chat-session-rail--expanded"
        role="region"
        aria-live="polite"
        aria-label=${t("chat.rail.title")}
        tabindex="-1"
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            this.collapse();
          }
        }}
      >
        <header class="chat-session-rail__header">
          <div class="chat-session-rail__header-copy">
            <div class="chat-session-rail__status-row">
              ${digest ? this.renderStatus(digest) : html`<strong>${t("chat.rail.title")}</strong>`}
              ${elapsed
                ? html`<span class="chat-session-rail__timing">${elapsed}</span>`
                : finished
                  ? html`<span class="chat-session-rail__timing">${finished}</span>`
                  : nothing}
            </div>
            ${digest
              ? html`<strong class="chat-session-rail__headline">${digest.headline}</strong>`
              : html`<span class="chat-session-rail__subtitle">${t("chat.rail.subtitle")}</span>`}
          </div>
          <div class="chat-session-rail__actions">
            <openclaw-tooltip .content=${t("chat.rail.clear")}>
              <button
                class="btn btn--ghost btn--icon chat-icon-btn"
                type="button"
                aria-label=${t("chat.rail.clear")}
                ?disabled=${!this.connected || this.companion.pendingQuestion !== null}
                @click=${() => this.onClear?.()}
              >
                ${icons.trash}
              </button>
            </openclaw-tooltip>
            <button
              class="btn btn--ghost btn--icon chat-icon-btn chat-session-rail__hide"
              type="button"
              aria-label=${t("chat.rail.hide")}
              @click=${() => this.hide()}
            >
              ${icons.x}
            </button>
            <button
              class="btn btn--ghost btn--icon chat-icon-btn chat-session-rail__toggle"
              type="button"
              aria-label=${t("chat.rail.collapse")}
              @click=${() => this.collapse()}
            >
              ${icons.chevronUp}
            </button>
          </div>
        </header>
        <div class="chat-session-rail__digest">${this.renderDigestDetails(digest)}</div>
        ${this.renderThread()}
        <form
          class="chat-session-rail__composer"
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            this.submit();
          }}
        >
          <label class="chat-session-rail__prompt">
            <span class="sr-only">${t("chat.rail.askLabel")}</span>
            <input
              class="chat-session-rail__input"
              type="text"
              maxlength="400"
              autocomplete="off"
              .value=${this.companion.draft}
              placeholder=${this.companion.pendingQuestion
                ? t("chat.rail.askPending")
                : t("chat.rail.askPlaceholder")}
              ?disabled=${!this.connected || this.companion.pendingQuestion !== null}
              @input=${(event: InputEvent) => {
                this.onDraftChange?.((event.currentTarget as HTMLInputElement).value);
              }}
            />
          </label>
          <button
            class="btn btn--ghost btn--icon chat-icon-btn chat-session-rail__submit"
            type="submit"
            aria-label=${t("chat.rail.askSubmit")}
            ?disabled=${!this.connected ||
            this.companion.pendingQuestion !== null ||
            !this.companion.draft.trim()}
          >
            ${icons.cornerDownLeft}
          </button>
        </form>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-chat-session-rail")) {
  customElements.define("openclaw-chat-session-rail", ChatSessionRailElement);
}
