import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { SessionObserverDigest } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ControlUiSessionPullRequest } from "../../../../../src/gateway/control-ui-contract.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { formatDurationCompact } from "../../../lib/format.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { getSafeLocalStorage } from "../../../local-storage.ts";
import type { PlanStatus } from "../tool-stream.ts";

const EXPANDED_STORAGE_KEY = "openclaw.chat.observerHud.expanded";

export type ObserverHudMode = "hidden" | "pill" | "card";

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

  constructor(private expandedPreference = loadExpandedPreference()) {}

  mode(input: ObserverHudInput): ObserverHudMode {
    const digest = visibleDigest(input);
    if (!digest || (!input.running && !unreadFinalDigest(digest, input.lastReadAt))) {
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
    return this.expandedPreference || (runId !== null && this.autoExpandedRunId === runId)
      ? "card"
      : "pill";
  }

  expand(): void {
    this.expandedPreference = true;
    this.autoExpandedRunId = null;
    storeExpandedPreference(true);
  }

  collapse(): void {
    this.expandedPreference = false;
    this.autoExpandedRunId = null;
    storeExpandedPreference(false);
  }
}

function loadExpandedPreference(): boolean {
  return getSafeLocalStorage()?.getItem(EXPANDED_STORAGE_KEY) === "true";
}

function storeExpandedPreference(expanded: boolean): void {
  try {
    getSafeLocalStorage()?.setItem(EXPANDED_STORAGE_KEY, String(expanded));
  } catch {
    // Privacy mode can make localStorage unavailable; the in-memory choice still works.
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

class ChatObserverHudElement extends OpenClawLightDomElement {
  @property({ attribute: false }) digest: SessionObserverDigest | null = null;
  @property({ attribute: false }) running = false;
  @property({ attribute: false }) activeRunId: string | null = null;
  @property({ attribute: false }) startedAt?: number;
  @property({ attribute: false }) lastReadAt?: number;
  @property({ attribute: false }) sideChatOpen = false;
  @property({ attribute: false }) planStatus: PlanStatus | null = null;
  @property({ attribute: false }) pullRequests: ControlUiSessionPullRequest[] = [];
  @state() private now = Date.now();

  private readonly hudState = new ChatObserverHudState();
  private clock: ReturnType<typeof globalThis.setTimeout> | null = null;

  override disconnectedCallback() {
    this.stopClock();
    super.disconnectedCallback();
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
    const digest = visibleDigest(input);
    if (mode === "hidden" || !digest) {
      return nothing;
    }
    const headline = digest.headline;
    const health = digest.health;
    const label = healthLabel(health);
    if (mode === "pill") {
      return html`
        <button
          class="chat-observer-hud chat-observer-hud--pill"
          type="button"
          aria-live="polite"
          aria-label=${t("chat.observer.expand")}
          @click=${() => this.expand()}
        >
          <span class="chat-observer-hud__dot" data-health=${health} title=${label}></span>
          <span class="chat-observer-hud__headline">${headline}</span>
          <span class="chat-observer-hud__chevron" aria-hidden="true">⌄</span>
        </button>
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
          <div class="chat-observer-hud__heading">
            <span class="chat-observer-hud__dot" data-health=${health} title=${label}></span>
            <strong>${headline}</strong>
          </div>
          <button
            class="btn btn--ghost btn--icon chat-icon-btn chat-observer-hud__collapse"
            type="button"
            aria-label=${t("chat.observer.collapse")}
            @click=${() => this.collapse()}
          >
            ${icons.arrowUp}
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
        <footer class="chat-observer-hud__footer">
          <span class="chat-observer-hud__run-dot" ?data-running=${this.running}></span>
          <span>${this.running ? t("chat.observer.running") : label}</span>
          ${elapsed ? html`<span aria-hidden="true">·</span><span>${elapsed}</span>` : nothing}
        </footer>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-chat-observer-hud")) {
  customElements.define("openclaw-chat-observer-hud", ChatObserverHudElement);
}
