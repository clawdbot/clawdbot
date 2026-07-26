import { html, nothing } from "lit";
import type { ApplicationGateway } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import type { SkillWorkshopHistoryScanResult, SkillWorkshopHistoryScanState } from "./state.ts";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type SkillWorkshopHistoryStatusLoadParams = {
  agentId: string;
  gateway: ApplicationGateway;
  state: SkillWorkshopHistoryScanState;
  force?: boolean;
};

type SkillWorkshopHistoryStatusLoadQueue = {
  pending: SkillWorkshopHistoryStatusLoadParams | null;
  promise: Promise<void>;
};

const statusLoadQueues = new WeakMap<
  SkillWorkshopHistoryScanState,
  SkillWorkshopHistoryStatusLoadQueue
>();

export async function loadSkillWorkshopHistoryScanStatus(
  params: SkillWorkshopHistoryStatusLoadParams,
): Promise<void> {
  const client = params.gateway.snapshot.client;
  const currentQueue = statusLoadQueues.get(params.state);
  if (currentQueue) {
    if (params.force) {
      currentQueue.pending = params;
    }
    await currentQueue.promise;
    return;
  }
  if (
    !client ||
    params.gateway.snapshot.phase !== "connected" ||
    params.state.running ||
    (params.state.loaded && !params.force)
  ) {
    return;
  }
  params.state.loading = true;
  const queue: SkillWorkshopHistoryStatusLoadQueue = {
    pending: null,
    promise: Promise.resolve(),
  };
  queue.promise = Promise.resolve().then(async () => {
    try {
      let next: SkillWorkshopHistoryStatusLoadParams | null = params;
      while (next) {
        const current = next;
        const pendingBeforeRequest = queue.pending;
        queue.pending = null;
        const currentClient = current.gateway.snapshot.client;
        if (
          currentClient &&
          current.gateway.snapshot.phase === "connected" &&
          !current.state.running
        ) {
          current.state.error = null;
          try {
            current.state.result = await currentClient.request<SkillWorkshopHistoryScanResult>(
              "skills.proposals.historyStatus",
              { agentId: current.agentId },
            );
            current.state.loaded = true;
          } catch (error) {
            current.state.error = getErrorMessage(error);
            // Loaded means this scope attempted a read. A scan action can still
            // force a retry because the result remains absent.
            current.state.loaded = true;
          }
        }
        const pendingAfterRequest = queue.pending;
        queue.pending = null;
        next = pendingAfterRequest ?? pendingBeforeRequest;
      }
    } finally {
      // Keep the last pending check and queue removal in one synchronous
      // continuation so a forced refresh cannot land between them.
      params.state.loading = false;
      statusLoadQueues.delete(params.state);
    }
  });
  statusLoadQueues.set(params.state, queue);
  await queue.promise;
}

export async function runSkillWorkshopHistoryScan(params: {
  agentId: string;
  gateway: ApplicationGateway;
  state: SkillWorkshopHistoryScanState;
}): Promise<boolean> {
  let client = params.gateway.snapshot.client;
  if (
    !client ||
    params.gateway.snapshot.phase !== "connected" ||
    params.state.running ||
    params.state.loading
  ) {
    return false;
  }
  if (!params.state.result) {
    await loadSkillWorkshopHistoryScanStatus({ ...params, force: true });
    if (!params.state.result) {
      return false;
    }
    client = params.gateway.snapshot.client;
    if (!client || params.gateway.snapshot.phase !== "connected") {
      return false;
    }
  }
  const direction = params.state.result.hasScanned
    ? params.state.result.hasMore
      ? "older"
      : "newer"
    : "older";
  params.state.running = true;
  params.state.error = null;
  try {
    params.state.result = await client.request<SkillWorkshopHistoryScanResult>(
      "skills.proposals.historyScan",
      { agentId: params.agentId, direction },
    );
    params.state.loaded = true;
    return true;
  } catch (error) {
    const scanError = getErrorMessage(error);
    try {
      params.state.result = await client.request<SkillWorkshopHistoryScanResult>(
        "skills.proposals.historyStatus",
        { agentId: params.agentId },
      );
      params.state.loaded = true;
    } catch {
      // Preserve the actionable scan error when status recovery is unavailable.
    }
    params.state.error = scanError;
    return false;
  } finally {
    params.state.running = false;
  }
}

function formatCoverage(result: SkillWorkshopHistoryScanResult): string | null {
  if (!result.oldestReviewedAt || !result.newestReviewedAt) {
    return null;
  }
  const oldest = new Date(result.oldestReviewedAt);
  const newest = new Date(result.newestReviewedAt);
  if (!Number.isFinite(oldest.getTime()) || !Number.isFinite(newest.getTime())) {
    return null;
  }
  const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const newestIsToday = newest.toDateString() === new Date().toDateString();
  return `${date.format(oldest)}–${newestIsToday ? t("skillWorkshop.history.today") : date.format(newest)}`;
}

function actionLabel(state: SkillWorkshopHistoryScanState): string {
  if (state.running) {
    return t("skillWorkshop.history.scanning");
  }
  if (!state.result?.hasScanned) {
    return t("skillWorkshop.history.findIdeas");
  }
  return state.result.hasMore
    ? t("skillWorkshop.history.scanEarlier")
    : t("skillWorkshop.history.scanNew");
}

export function renderSkillWorkshopHistoryScan(params: {
  state: SkillWorkshopHistoryScanState;
  onScan: () => void;
}) {
  const result = params.state.result;
  const coverage = result ? formatCoverage(result) : null;
  return html`
    <section class="sw-history ${result?.hasScanned ? "is-compact" : ""}">
      <div class="sw-history__signal" aria-hidden="true">
        <span></span><span></span><span></span><span></span>
      </div>
      <div class="sw-history__copy">
        <div class="sw-history__eyebrow">${t("skillWorkshop.history.eyebrow")}</div>
        <h2>${t("skillWorkshop.history.title")}</h2>
        <p>${t("skillWorkshop.history.body")}</p>
        ${result?.hasScanned
          ? html`
              <div class="sw-history__stats" role="status">
                <span
                  >${t("skillWorkshop.history.reviewed", {
                    count: String(result.reviewedSessions),
                  })}</span
                >
                ${coverage ? html`<span>${coverage}</span>` : nothing}
                <span
                  >${t("skillWorkshop.history.found", {
                    count: String(result.ideasFound),
                  })}</span
                >
              </div>
              ${result.lastScanReviewed === 0
                ? html`<div class="sw-history__empty-window">
                    ${t("skillWorkshop.history.noSessions")}
                  </div>`
                : nothing}
            `
          : nothing}
        ${params.state.error
          ? html`<div class="sw-history__error" role="alert">${params.state.error}</div>`
          : nothing}
      </div>
      <div class="sw-history__action">
        <button
          class="sw-btn sw-btn--primary"
          ?disabled=${params.state.running || params.state.loading}
          @click=${params.onScan}
        >
          ${params.state.loading ? t("skillWorkshop.history.loading") : actionLabel(params.state)}
        </button>
        <span>${t("skillWorkshop.history.pendingOnly")}</span>
      </div>
    </section>
  `;
}
