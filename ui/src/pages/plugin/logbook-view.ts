// Control UI view renders the Logbook automatic work journal tab.
import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { t } from "../../i18n/index.ts";
import { formatDurationCompact, formatTimeMs } from "../../lib/format.ts";
import "../../styles/logbook.css";
import {
  askLogbook,
  configureLogbookPolling,
  getLogbookState,
  loadLogbook,
  loadLogbookFramePreview,
  loadLogbookStandup,
  localDayKey,
  runLogbookAnalysisNow,
  setLogbookCapturePaused,
  shiftDay,
  type LogbookCardPayload,
  type LogbookStatusPayload,
  type LogbookUiState,
} from "./logbook-controller.ts";

type LogbookProps = {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  onRequestUpdate?: () => void;
};

function formatClock(ms: number, timeZone: string): string {
  return formatTimeMs(ms, { hour: "2-digit", minute: "2-digit", timeZone }, "");
}

/** Stable category hue so colors stay consistent across renders and days. */
function categoryHue(category: string): number {
  let hash = 0;
  for (let i = 0; i < category.length; i += 1) {
    hash = (hash * 31 + category.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

function renderStatusChips(status: LogbookStatusPayload): TemplateResult {
  const capturing = status.captureEnabled && !status.capturePaused && !status.lastCaptureError;
  const captureLabel = status.capturePaused
    ? t("logbook.status.paused")
    : status.captureEnabled
      ? t("logbook.status.capturing", { seconds: String(status.captureIntervalSeconds) })
      : t("logbook.status.disabled");
  return html`
    <div class="logbook__chips">
      <span class="logbook__chip ${capturing ? "logbook__chip--ok" : "logbook__chip--warn"}">
        <span class="logbook__chip-dot"></span>
        ${captureLabel}
      </span>
      ${status.nodeName || status.nodeId
        ? html`<span class="logbook__chip" title=${t("logbook.status.nodeHelp")}>
            ${icons.monitor} ${status.nodeName ?? status.nodeId}
          </span>`
        : nothing}
      ${status.pendingFrames > 0
        ? html`<span class="logbook__chip" title=${t("logbook.status.pendingHelp")}>
            ${t("logbook.status.pending", { count: String(status.pendingFrames) })}
          </span>`
        : nothing}
      ${status.analysisRunning
        ? html`<span class="logbook__chip logbook__chip--busy"
            >${t("logbook.status.analyzing")}</span
          >`
        : nothing}
      ${status.lastCaptureError
        ? html`<span class="logbook__chip logbook__chip--error" title=${status.lastCaptureError}>
            ${t("logbook.status.captureError")}
          </span>`
        : nothing}
      ${status.lastBatch?.status === "error"
        ? html`<span
            class="logbook__chip logbook__chip--error"
            title=${status.lastBatch.error ?? ""}
          >
            ${t("logbook.status.batchError")}
          </span>`
        : nothing}
      ${status.visionModelSource === "missing"
        ? html`<span
            class="logbook__chip logbook__chip--warn"
            title=${t("logbook.status.modelMissingHelp")}
          >
            ${t("logbook.status.modelMissing")}
          </span>`
        : nothing}
    </div>
  `;
}

function renderCard(
  state: LogbookUiState,
  client: GatewayBrowserClient | null,
  card: LogbookCardPayload,
  timeZone: string,
): TemplateResult {
  const expanded = state.expandedCardIds.has(card.id);
  const hue = categoryHue(card.category);
  // Pruned keyframes look permanently absent; treating them as loading would
  // re-request the missing frame on every render.
  const keyframeId =
    card.keyframeId !== undefined && !state.framePreviewFailed.has(card.keyframeId)
      ? card.keyframeId
      : undefined;
  const preview = keyframeId !== undefined ? state.framePreviews.get(keyframeId) : undefined;
  if (expanded && keyframeId !== undefined && !preview) {
    void loadLogbookFramePreview(state, client, keyframeId);
  }
  return html`
    <article
      class="logbook-card ${expanded ? "logbook-card--expanded" : ""}"
      style="--logbook-hue: ${hue}"
    >
      <button
        class="logbook-card__header"
        type="button"
        @click=${() => {
          const next = new Set(state.expandedCardIds);
          if (expanded) {
            next.delete(card.id);
          } else {
            next.add(card.id);
          }
          state.expandedCardIds = next;
          state.requestUpdate?.();
        }}
      >
        <span class="logbook-card__time">
          ${formatClock(card.startMs, timeZone)}<span class="logbook-card__time-sep">–</span
          >${formatClock(card.endMs, timeZone)}
        </span>
        <span class="logbook-card__stripe" aria-hidden="true"></span>
        <span class="logbook-card__heading">
          <span class="logbook-card__title">${card.title}</span>
          <span class="logbook-card__summary">${card.summary}</span>
        </span>
        <span class="logbook-card__meta">
          <span class="logbook-card__category">${card.category}</span>
          ${card.appPrimary
            ? html`<span class="logbook-card__app">${card.appPrimary}</span>`
            : nothing}
          <span class="logbook-card__duration"
            >${formatDurationCompact(card.endMs - card.startMs, { spaced: true }) ?? "0s"}</span
          >
        </span>
      </button>
      ${expanded
        ? html`
            <div class="logbook-card__body">
              ${preview
                ? html`<img
                    class="logbook-card__keyframe"
                    src=${preview}
                    alt=${t("logbook.card.keyframeAlt")}
                  />`
                : keyframeId !== undefined
                  ? html`<div class="logbook-card__keyframe logbook-card__keyframe--loading">
                      ${t("common.loading")}
                    </div>`
                  : nothing}
              ${card.detail ? html`<p class="logbook-card__detail">${card.detail}</p>` : nothing}
              ${card.distractions.length > 0
                ? html`
                    <div class="logbook-card__distractions">
                      <span class="logbook-card__distractions-label">
                        ${t("logbook.card.distractions")}
                      </span>
                      ${card.distractions.map(
                        (distraction) => html`
                          <span class="logbook-card__distraction">
                            ${formatClock(distraction.startMs, timeZone)} · ${distraction.title}
                          </span>
                        `,
                      )}
                    </div>
                  `
                : nothing}
            </div>
          `
        : nothing}
    </article>
  `;
}

function renderStats(state: LogbookUiState): TemplateResult | typeof nothing {
  const stats = state.timeline?.stats;
  if (!stats || stats.trackedMs <= 0) {
    return nothing;
  }
  const focusMs = Math.max(0, stats.trackedMs - stats.distractionMs);
  const focusPct = Math.round((focusMs / stats.trackedMs) * 100);
  const maxCategoryMs = stats.categories[0]?.ms ?? 1;
  return html`
    <section class="card logbook-side__card">
      <div class="card-title">${t("logbook.stats.title")}</div>
      <div class="logbook-stats__focus">
        <div class="logbook-stats__focus-bar">
          <div class="logbook-stats__focus-fill" style="width: ${focusPct}%"></div>
        </div>
        <div class="logbook-stats__focus-legend">
          <span>${t("logbook.stats.focus", { pct: String(focusPct) })}</span>
          <span
            >${t("logbook.stats.tracked", {
              duration: formatDurationCompact(stats.trackedMs, { spaced: true }) ?? "0s",
            })}</span
          >
        </div>
      </div>
      <div class="logbook-stats__categories">
        ${stats.categories.slice(0, 6).map(
          (entry) => html`
            <div
              class="logbook-stats__category"
              style="--logbook-hue: ${categoryHue(entry.category)}"
            >
              <span class="logbook-stats__category-name">${entry.category}</span>
              <span class="logbook-stats__category-bar">
                <span
                  class="logbook-stats__category-fill"
                  style="width: ${Math.max(6, Math.round((entry.ms / maxCategoryMs) * 100))}%"
                ></span>
              </span>
              <span class="logbook-stats__category-time"
                >${formatDurationCompact(entry.ms, { spaced: true }) ?? "0s"}</span
              >
            </div>
          `,
        )}
      </div>
      ${stats.apps.length > 0
        ? html`
            <div class="logbook-stats__apps">
              ${stats.apps
                .slice(0, 5)
                .map((app) => html`<span class="logbook-stats__app">${app.domain}</span>`)}
            </div>
          `
        : nothing}
    </section>
  `;
}

function renderStandup(state: LogbookUiState, client: GatewayBrowserClient | null): TemplateResult {
  return html`
    <section class="card logbook-side__card">
      <div class="logbook-side__card-header">
        <div class="card-title">${t("logbook.standup.title")}</div>
        <button
          class="btn btn--small"
          type="button"
          ?disabled=${state.standupLoading}
          @click=${() => void loadLogbookStandup(state, client, state.standup !== null)}
        >
          ${state.standupLoading
            ? t("common.loading")
            : state.standup
              ? t("logbook.standup.refresh")
              : t("logbook.standup.generate")}
        </button>
      </div>
      ${state.standup
        ? html`<div class="logbook-standup__body markdown-body">
            ${unsafeHTML(toSanitizedMarkdownHtml(state.standup.text))}
          </div>`
        : html`<div class="card-sub">${t("logbook.standup.empty")}</div>`}
    </section>
  `;
}

function renderAsk(state: LogbookUiState, client: GatewayBrowserClient | null): TemplateResult {
  return html`
    <section class="card logbook-side__card">
      <div class="card-title">${t("logbook.ask.title")}</div>
      <form
        class="logbook-ask__form"
        @submit=${(event: Event) => {
          event.preventDefault();
          void askLogbook(state, client);
        }}
      >
        <input
          class="logbook-ask__input"
          type="text"
          .value=${state.askQuestion}
          placeholder=${t("logbook.ask.placeholder")}
          @input=${(event: Event) => {
            state.askQuestion = (event.target as HTMLInputElement).value;
          }}
        />
        <button class="btn btn--small" type="submit" ?disabled=${state.askLoading}>
          ${state.askLoading ? t("common.loading") : t("logbook.ask.submit")}
        </button>
      </form>
      ${state.askAnswer ? html`<p class="logbook-ask__answer">${state.askAnswer}</p>` : nothing}
    </section>
  `;
}

export function renderLogbook(props: LogbookProps) {
  const state = getLogbookState(props.host);
  state.requestUpdate = props.onRequestUpdate ?? null;
  // The tab only renders while the plugin's descriptor is advertised, so
  // enablement gating lives in the shell; connectivity is the only guard here.
  const active = props.connected;
  configureLogbookPolling(state, active ? props.client : null, active);
  if (active && !state.timeline && !state.loading && !state.error) {
    void loadLogbook(state, props.client);
  }

  // The gateway's day is authoritative; the browser clock only seeds the view
  // until the first status response arrives.
  const todayKey = state.status?.today ?? localDayKey();
  const isToday = state.day === todayKey;
  const status = state.status;
  const cards = state.timeline?.cards ?? [];
  return html`
    <section class="logbook">
      <header class="logbook__header">
        <div class="logbook__daynav">
          <button
            class="btn btn--small"
            type="button"
            aria-label=${t("logbook.nav.previousDay")}
            @click=${() => void loadLogbook(state, props.client, { day: shiftDay(state.day, -1) })}
          >
            ‹
          </button>
          <span class="logbook__day">${state.day}</span>
          <button
            class="btn btn--small"
            type="button"
            aria-label=${t("logbook.nav.nextDay")}
            ?disabled=${isToday}
            @click=${() => void loadLogbook(state, props.client, { day: shiftDay(state.day, 1) })}
          >
            ›
          </button>
          ${!isToday
            ? html`<button
                class="btn btn--small"
                type="button"
                @click=${() => void loadLogbook(state, props.client, { today: true })}
              >
                ${t("logbook.nav.today")}
              </button>`
            : nothing}
        </div>
        ${state.status ? renderStatusChips(state.status) : nothing}
        <div class="logbook__actions">
          ${state.status
            ? html`<button
                class="btn btn--small"
                type="button"
                ?disabled=${state.actionPending || !state.status.captureEnabled}
                @click=${() =>
                  void setLogbookCapturePaused(state, props.client, !state.status?.capturePaused)}
              >
                ${state.status.capturePaused
                  ? t("logbook.actions.resume")
                  : t("logbook.actions.pause")}
              </button>`
            : nothing}
          <button
            class="btn btn--small"
            type="button"
            ?disabled=${state.actionPending}
            @click=${() => void runLogbookAnalysisNow(state, props.client)}
          >
            ${t("logbook.actions.analyzeNow")}
          </button>
          <button
            class="btn btn--small"
            type="button"
            ?disabled=${state.loading}
            @click=${() => void loadLogbook(state, props.client)}
          >
            ${icons.refresh}
          </button>
        </div>
      </header>
      ${state.error ? html`<div class="callout danger" role="alert">${state.error}</div>` : nothing}
      <div class="logbook__layout">
        <div class="logbook__timeline">
          ${state.loading && cards.length === 0
            ? html`<div class="card-sub">${t("common.loading")}</div>`
            : nothing}
          ${!state.loading && cards.length === 0 && !state.error
            ? html`
                <div class="logbook__empty">
                  <div class="logbook__empty-title">${t("logbook.empty.title")}</div>
                  <div class="logbook__empty-sub">${t("logbook.empty.subtitle")}</div>
                </div>
              `
            : nothing}
          ${status
            ? cards.map((card) => renderCard(state, props.client, card, status.timeZone))
            : nothing}
        </div>
        <aside class="logbook__side">
          ${renderStats(state)} ${renderStandup(state, props.client)}
          ${renderAsk(state, props.client)}
        </aside>
      </div>
    </section>
  `;
}
