import { html, nothing, type TemplateResult } from "lit";
import type { SessionObserverDigest } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import { t } from "../../../i18n/index.ts";
import { formatTimeMs } from "../../format.ts";
import { pickFreshestObserverDigest } from "../../observer-digest.ts";
import type { BoardObserverContext } from "../view-types.ts";

type ObserverTimelineEntry = {
  digest: SessionObserverDigest;
  healthTransition: boolean;
  runStart: boolean;
  unreadBoundaryAfter: boolean;
};

function sameRun(
  first: SessionObserverDigest | undefined,
  second: SessionObserverDigest | undefined,
): boolean {
  return first?.runId === second?.runId;
}

function buildObserverTimeline(
  digests: readonly SessionObserverDigest[],
  lastReadAt?: number,
): ObserverTimelineEntry[] {
  const newestFirst = digests.toReversed();
  const firstReadIndex =
    lastReadAt == null ? -1 : newestFirst.findIndex((digest) => digest.updatedAt <= lastReadAt);
  const unreadCount =
    lastReadAt == null ? 0 : firstReadIndex === -1 ? newestFirst.length : firstReadIndex;
  return newestFirst.map((digest, index) => {
    const newer = newestFirst[index - 1];
    const older = newestFirst[index + 1];
    return {
      digest,
      runStart: !sameRun(digest, newer),
      healthTransition: sameRun(digest, older) && digest.health !== older?.health,
      unreadBoundaryAfter: unreadCount > 0 && index === unreadCount - 1,
    };
  });
}

function currentObserverDigest(
  digests: readonly SessionObserverDigest[],
  activeRunId: string | null,
): SessionObserverDigest | null {
  const candidates = activeRunId
    ? digests.filter((digest) => digest.runId === activeRunId)
    : digests;
  return candidates.reduce<SessionObserverDigest | null>(
    (freshest, digest) => pickFreshestObserverDigest(freshest, digest),
    null,
  );
}

function healthLabel(health: SessionObserverDigest["health"]): string {
  return t(`chat.observer.health.${health}` as Parameters<typeof t>[0]);
}

function compactRunId(runId: string | undefined): string {
  if (!runId) {
    return t("chat.observer.boardUnknownRun");
  }
  return runId.length > 14 ? `…${runId.slice(-12)}` : runId;
}

function renderCurrentStatus(digest: SessionObserverDigest): TemplateResult {
  const progress = digest.planProgress;
  const label = healthLabel(digest.health);
  return html`
    <header class="observer-widget__current" data-health=${digest.health}>
      <div class="observer-widget__current-heading">
        <span
          class="observer-widget__health-dot"
          data-health=${digest.health}
          title=${label}
        ></span>
        <div>
          <span class="observer-widget__eyebrow">${t("chat.observer.boardCurrentStatus")}</span>
          <strong>${digest.headline}</strong>
        </div>
      </div>
      ${digest.assessment
        ? html`<p class="observer-widget__assessment">${digest.assessment}</p>`
        : nothing}
      ${progress
        ? html`<div class="observer-widget__progress">
            <span>${t("chat.observer.plan")}</span>
            <strong
              >${t("chat.observer.progress", {
                completed: String(progress.completed),
                total: String(progress.total),
              })}</strong
            >
            <span class="observer-widget__progress-track" aria-hidden="true">
              <span
                style=${`width: ${progress.total > 0 ? Math.min(100, (progress.completed / progress.total) * 100) : 0}%`}
              ></span>
            </span>
          </div>`
        : nothing}
    </header>
  `;
}

function renderTimelineEntry(
  entry: ObserverTimelineEntry,
  currentRunId: string | null,
): TemplateResult {
  const digest = entry.digest;
  const label = healthLabel(digest.health);
  const currentRun = currentRunId !== null && digest.runId === currentRunId;
  return html`
    ${entry.runStart
      ? html`<div class="observer-widget__run" data-current=${currentRun ? "true" : "false"}>
          <span
            >${currentRun
              ? t("chat.observer.boardCurrentRun")
              : t("chat.observer.boardPreviousRun")}</span
          >
          <code title=${digest.runId ?? ""}>${compactRunId(digest.runId)}</code>
        </div>`
      : nothing}
    <div
      class=${`observer-widget__timeline-row ${entry.healthTransition ? "observer-widget__timeline-row--transition" : ""}`}
      data-health=${digest.health}
      data-transition=${entry.healthTransition ? "true" : "false"}
    >
      <time datetime=${new Date(digest.updatedAt).toISOString()}
        >${formatTimeMs(
          digest.updatedAt,
          { hour: "numeric", minute: "2-digit", second: "2-digit" },
          "",
        )}</time
      >
      <span class="observer-widget__health-dot" data-health=${digest.health} title=${label}></span>
      <span class="observer-widget__health-label">${label}</span>
      <span class="observer-widget__timeline-headline">${digest.headline}</span>
    </div>
    ${entry.unreadBoundaryAfter
      ? html`<div class="observer-widget__unread-boundary" data-test-id="observer-unread-boundary">
          <span>${t("chat.observer.boardSinceYouLeft")}</span>
        </div>`
      : nothing}
  `;
}

export function renderObserverWidget({
  observer,
}: {
  observer?: BoardObserverContext;
}): TemplateResult {
  const digests = observer?.digests ?? [];
  const current = currentObserverDigest(digests, observer?.activeRunId ?? null);
  const currentRunId = observer?.activeRunId ?? current?.runId ?? null;
  const timeline = buildObserverTimeline(digests, observer?.lastReadAt);
  return html`
    <div class="observer-widget" data-test-id="observer-widget">
      ${current ? renderCurrentStatus(current) : nothing}
      <section class="observer-widget__timeline" aria-label=${t("chat.observer.boardTimeline")}>
        <div class="observer-widget__timeline-title">${t("chat.observer.boardTimeline")}</div>
        ${timeline.map((entry) => renderTimelineEntry(entry, currentRunId))}
      </section>
    </div>
  `;
}
