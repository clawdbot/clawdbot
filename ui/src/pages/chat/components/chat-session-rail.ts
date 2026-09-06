import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { SessionObserverDigest } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ControlUiSessionPullRequest } from "../../../../../src/gateway/control-ui-contract.js";
import { icons } from "../../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { renderPanelEmptyState } from "../../../components/panel-empty-state.ts";
import { renderPanelLoadingSkeleton } from "../../../components/panel-loading-skeleton.ts";
import "../../../components/tooltip.ts";
import "../../../components/web-awesome.ts";
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

export type SessionRailMode = "hidden" | "pill" | "expanded";

/**
 * Pane-owned command generation. `open` is the automatic path (a companion
 * question arrived) and stays refused while the rail is hidden; `toggle` is the
 * operator pressing the header button and must win over that refusal.
 */
export type SessionRailCommand = {
  generation: number;
  intent: "open" | "toggle";
};

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
  private transientExpanded = false;
  // Explicit open from the header toggle while idle: the companion must stay
  // reachable at any point, even with no digest and an empty thread.
  private manualOpen = false;

  constructor(
    private displayPreference: ChatObserverDisplayPreference = loadChatObserverDisplayPreference(),
  ) {}

  resetTransientState(): void {
    this.transientExpanded = false;
    this.autoExpandedRunId = null;
    this.manualOpen = false;
  }

  tryAutoOpen(): boolean {
    if (this.displayPreference === "off") {
      return false;
    }
    this.transientExpanded = true;
    return true;
  }

  mode(input: SessionRailInput): SessionRailMode {
    const digest = visibleDigest(input);
    const digestRenderable =
      digest !== null && (input.running || unreadFinalDigest(digest, input.lastReadAt));
    // transientExpanded counts: an open on an idle session with an empty thread
    // has nothing else to justify rendering, and swallowing it would leave the
    // toggle press with no visible outcome.
    const renderable =
      digestRenderable || input.hasCompanionActivity || this.manualOpen || this.transientExpanded;
    if (this.displayPreference === "off") {
      this.autoExpandedRunId = null;
      return "hidden";
    }
    if (!renderable) {
      this.autoExpandedRunId = null;
      // Idle sessions render nothing over the thread; the pane header toggle is
      // the always-present way back in.
      return "hidden";
    }
    const runId = input.activeRunId ?? digest?.runId ?? null;
    const critical = digest?.health === "stuck" || digest?.health === "waiting-on-user";
    if (critical && runId && !this.autoExpandedRunIds.has(runId)) {
      this.autoExpandedRunIds.add(runId);
      this.autoExpandedRunId = runId;
    }
    return this.displayPreference === "card" ||
      this.transientExpanded ||
      (runId !== null && this.autoExpandedRunId === runId)
      ? "expanded"
      : "pill";
  }

  expand(): void {
    this.displayPreference = "card";
    this.transientExpanded = false;
    this.autoExpandedRunId = null;
    storeChatObserverDisplayPreference("card");
  }

  /**
   * Closing the panel also drops the manual-open claim, so an idle session with
   * no digest falls back to nothing rather than to a pill with no status in it.
   * A running session still shows its digest pill.
   */
  collapse(): void {
    this.displayPreference = "pill";
    this.transientExpanded = false;
    this.autoExpandedRunId = null;
    this.manualOpen = false;
    storeChatObserverDisplayPreference("pill");
  }

  hide(): void {
    this.displayPreference = "off";
    this.resetTransientState();
    storeChatObserverDisplayPreference("off");
  }

  /**
   * Header-toggle open. Un-hides and shows the panel in the same gesture, but
   * stores `pill` rather than `card`: one press must not turn every later run
   * into a sticky panel. The chevron still owns that persistent choice.
   */
  openExplicitly(): void {
    this.displayPreference = "pill";
    this.transientExpanded = true;
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

const SESSION_RAIL_STARTER_KEYS = ["changed", "stopped", "remaining"] as const;

function companionHasActivity(thread: ChatSessionCompanionThread): boolean {
  return (
    thread.exchanges.length > 0 ||
    thread.pendingQuestion !== null ||
    thread.failedQuestion !== null ||
    thread.draft.length > 0
  );
}

const COMPANION_HINT_KEYS = {
  busy: "chat.rail.askBusy",
  "history-unavailable": "chat.rail.askHistoryUnavailable",
  missing: "chat.rail.askMissing",
  "model-unavailable": "chat.rail.askModelUnavailable",
  "rate-limited": "chat.rail.askRateLimited",
  unavailable: "chat.rail.askUnavailable",
} as const satisfies Record<
  NonNullable<ChatSessionCompanionThread["hint"]>,
  Parameters<typeof t>[0]
>;

function companionHintKey(
  hint: NonNullable<ChatSessionCompanionThread["hint"]>,
): Parameters<typeof t>[0] {
  return COMPANION_HINT_KEYS[hint];
}

export class ChatSessionRailElement extends OpenClawLightDomElement {
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) digest: SessionObserverDigest | null = null;
  @property({ attribute: false }) running = false;
  @property({ attribute: false }) activeRunId: string | null = null;
  @property({ attribute: false }) startedAt?: number;
  @property({ attribute: false }) lastReadAt?: number;
  @property({ attribute: false }) pullRequests: ControlUiSessionPullRequest[] = [];
  @property({ attribute: false }) companion: ChatSessionCompanionThread = {
    exchanges: [],
    loading: false,
    pendingQuestion: null,
    failedQuestion: null,
    hint: null,
    retryable: false,
    draft: "",
  };
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) command: SessionRailCommand | null = null;
  @property({ attribute: false }) consumedCommandGeneration = 0;
  @property({ attribute: false }) onCommandConsumed?: (generation: number) => void;
  @property({ attribute: false }) onSubmit?: (question: string) => void;
  @property({ attribute: false }) onDraftChange?: (draft: string) => void;
  @property({ attribute: false }) onModeChange?: (mode: SessionRailMode) => void;
  @property({ attribute: false }) onVisibilityChange?: (visible: boolean) => void;
  @property({ type: Boolean }) embedded = false;
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
      // Automatic and manual opens are per-session gestures; neither may leak
      // the rail open into the next selected session.
      this.railState.resetTransientState();
    }
    if (changedProperties.has("digest") && this.digest) {
      if (this.digest.health === "done" || this.digest.health === "failed") {
        this.terminalAgeReference = Date.now();
      }
    }
    if (changedProperties.has("command")) {
      this.applyPaneCommand();
    }
  }

  private applyPaneCommand() {
    const command = this.command;
    if (!command || command.generation <= this.consumedCommandGeneration) {
      return;
    }
    this.onCommandConsumed?.(command.generation);
    if (command.intent === "open") {
      if (this.railState.tryAutoOpen()) {
        this.onVisibilityChange?.(true);
      }
      return;
    }
    // renderedMode is the density the operator is actually looking at, which is
    // also what the header toggle reports as aria-expanded. Recomputing here
    // would run mode()'s once-per-run critical bookkeeping a second time.
    if (this.renderedMode === "expanded") {
      this.railState.collapse();
      // Collapsing is not hiding: only the explicit hide reports false. The
      // gateway stops producing digests when visibility goes false, and a
      // collapsed rail still shows the next one as a pill.
      return;
    }
    this.railState.openExplicitly();
    this.onVisibilityChange?.(true);
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
      hasCompanionActivity: companionHasActivity(this.companion),
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
        ${
          terminal
            ? html`<span class="chat-session-rail__status-icon" aria-hidden="true"
                >${digest.health === "done" ? icons.check : icons.x}</span
              >`
            : html`<span class="chat-session-rail__status-dot" aria-hidden="true"></span>`
        }
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
              ${
                checks ? html`<span class="chat-session-rail__pr-checks">${checks}</span>` : nothing
              }
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
    return html`
      ${
        digest.assessment
          ? html`<p class="chat-session-rail__assessment">${digest.assessment}</p>`
          : nothing
      }
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

  /**
   * The empty state is the only place the companion explains its scope, so it
   * shows openers it can actually answer from the transcript and the project
   * files it may read, rather than a sentence about being read-only.
   */
  private renderStarters() {
    const disabled = !this.connected || this.companion.pendingQuestion !== null;
    return html`
      <div class="chat-session-rail__starters">
        ${SESSION_RAIL_STARTER_KEYS.map((key) => {
          const question = t(`chat.rail.starters.${key}` as Parameters<typeof t>[0]);
          return html`
            <button
              class="chip chat-session-rail__starter"
              type="button"
              ?disabled=${disabled}
              @click=${() => this.onSubmit?.(question)}
            >
              ${icons.spark}<span>${question}</span>
            </button>
          `;
        })}
      </div>
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
        ${
          this.companion.loading && this.companion.exchanges.length === 0
            ? renderPanelLoadingSkeleton("chat", t("chat.thread.loading"))
            : nothing
        }
        ${
          !this.companion.loading &&
          this.companion.exchanges.length === 0 &&
          !this.companion.pendingQuestion
            ? renderPanelEmptyState({
                icon: icons.bot,
                heading: t("chat.sidePanel.companion"),
                description: t("chat.rail.empty"),
              })
            : nothing
        }
        ${this.companion.exchanges.map((exchange) =>
          this.renderExchange(exchange.question, exchange.answer, exchange.ts),
        )}
        ${
          this.companion.failedQuestion && this.companion.hint
            ? html`
                <article class="chat-session-rail__exchange chat-session-rail__exchange--error">
                  <div class="chat-session-rail__question">${this.companion.failedQuestion}</div>
                  <div class="chat-session-rail__hint">
                    ${t(companionHintKey(this.companion.hint))}
                  </div>
                  ${
                    this.companion.retryable && this.connected && this.onSubmit
                      ? html`
                          <button
                            class="btn btn--secondary chat-session-rail__retry"
                            type="button"
                            @click=${() => this.onSubmit?.(this.companion.failedQuestion ?? "")}
                          >
                            ${t("chat.rail.askRetry")}
                          </button>
                        `
                      : nothing
                  }
                </article>
              `
            : nothing
        }
        ${
          this.companion.pendingQuestion
            ? html`
                <article class="chat-session-rail__exchange chat-session-rail__exchange--pending">
                  <div class="chat-session-rail__question">${this.companion.pendingQuestion}</div>
                  <div class="chat-session-rail__hint">${t("chat.rail.askPending")}</div>
                </article>
              `
            : nothing
        }
      </div>
    `;
  }

  override render() {
    const input = this.input();
    const mode = this.embedded ? "expanded" : this.railState.mode(input);
    this.renderedMode = mode;
    if (mode === "hidden") {
      return nothing;
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
            aria-label=${t("chat.rail.close")}
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
    // No aria-live on the section: it contains a 1Hz elapsed clock, so a live
    // region would announce every tick; the thread owns its own polite region.
    return html`
      <section
        class="chat-session-rail chat-session-rail--expanded ${
          this.embedded ? "chat-session-rail--embedded" : ""
        }"
        role="region"
        aria-label=${t("chat.rail.title")}
        tabindex="-1"
        @keydown=${(event: KeyboardEvent) => {
          if (!this.embedded && event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            this.collapse();
          }
        }}
      >
        ${
          this.embedded
            ? nothing
            : html`<header class="rail-header chat-session-rail__header">
                <div class="rail-header__copy chat-session-rail__header-copy">
                  <div class="chat-session-rail__status-row">
                    ${
                      digest
                        ? this.renderStatus(digest)
                        : html`<strong>${t("chat.rail.title")}</strong>`
                    }
                    ${
                      elapsed
                        ? html`<span class="chat-session-rail__timing">${elapsed}</span>`
                        : finished
                          ? html`<span class="chat-session-rail__timing">${finished}</span>`
                          : nothing
                    }
                  </div>
                  ${
                    digest
                      ? html`<strong class="chat-session-rail__headline"
                          >${digest.headline}</strong
                        >`
                      : html`<span class="chat-session-rail__subtitle"
                          >${t("chat.rail.subtitle")}</span
                        >`
                  }
                </div>
                <div class="rail-header__actions chat-session-rail__actions">
                  <button
                    class="rail-header__action chat-session-rail__hide"
                    type="button"
                    aria-label=${t("chat.rail.close")}
                    @click=${() => this.hide()}
                  >
                    ${icons.x}
                  </button>
                  <button
                    class="rail-header__action chat-session-rail__toggle"
                    type="button"
                    aria-label=${t("chat.rail.collapse")}
                    @click=${() => this.collapse()}
                  >
                    ${icons.chevronUp}
                  </button>
                </div>
              </header>`
        }
        ${
          digest
            ? html`<div class="chat-session-rail__digest">${this.renderDigestDetails(digest)}</div>`
            : nothing
        }
        ${this.renderThread()}
        ${
          this.companion.exchanges.length === 0 && !this.companion.pendingQuestion
            ? this.renderStarters()
            : nothing
        }
        <form
          class="agent-chat__input chat-session-rail__composer"
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            this.submit();
          }}
        >
          <div class="agent-chat__composer-input-row">
            <label class="agent-chat__composer-combobox chat-session-rail__prompt">
              <input
                class="chat-session-rail__input"
                type="text"
                maxlength="400"
                autocomplete="off"
                aria-label=${t("chat.rail.askLabel")}
                .value=${this.companion.draft}
                placeholder=${
                  this.companion.pendingQuestion
                    ? t("chat.rail.askPending")
                    : t("chat.rail.askPlaceholder")
                }
                ?disabled=${!this.connected || this.companion.pendingQuestion !== null}
                @input=${(event: InputEvent) => {
                  this.onDraftChange?.((event.currentTarget as HTMLInputElement).value);
                }}
              />
            </label>
          </div>
          <div class="agent-chat__composer-footer">
            <div class="agent-chat__composer-trail">
              <div class="agent-chat__composer-actions">
                <button
                  class="chat-send-btn"
                  type="submit"
                  aria-label=${t("chat.rail.askSubmit")}
                  ?disabled=${
                    !this.connected ||
                    this.companion.pendingQuestion !== null ||
                    !this.companion.draft.trim()
                  }
                >
                  ${icons.arrowUp}
                </button>
              </div>
            </div>
          </div>
        </form>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-chat-session-rail")) {
  customElements.define("openclaw-chat-session-rail", ChatSessionRailElement);
}
