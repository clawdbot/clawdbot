// Read-only task-lanes panel for the Automations activity tab: live provider
// lanes with newest-first items, per-provider diagnostic chips, and
// empty/error states. Data arrives from the taskLanes.list gateway RPC;
// artifact URLs are sanitized upstream (only http(s) survives the provider)
// and render here as-is.
import { html, nothing } from "lit";
import type { TaskLaneSnapshotPayload } from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";

export type TaskLanesSectionProps = {
  taskLanes: TaskLaneSnapshotPayload | null;
  taskLanesError: string | null;
};

type TaskLane = TaskLaneSnapshotPayload["lanes"][number];
type TaskLaneItem = TaskLane["items"][number];
type TaskLaneDiagnostic = TaskLaneSnapshotPayload["diagnostics"][number];

/** Lanes sort by provider-then-id; items render newest-first (startedAtMs desc, missing last). */
function sortTaskLaneSnapshot(snapshot: TaskLaneSnapshotPayload): TaskLaneSnapshotPayload {
  return {
    ...snapshot,
    lanes: snapshot.lanes
      .toSorted((a, b) =>
        a.providerId === b.providerId
          ? a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0
          : (a.providerId ?? "") < (b.providerId ?? "")
            ? -1
            : 1,
      )
      .map((lane) =>
        Object.assign({}, lane, {
          items: lane.items.toSorted((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0)),
        }),
      ),
    diagnostics: snapshot.diagnostics.toSorted((a, b) =>
      a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0,
    ),
  };
}

/**
 * Paging can leave a lane with zero rendered items while its queue is
 * non-empty. Totals distinguish omission from emptiness; a lane missing
 * totals (older snapshot) falls back to its rendered count.
 */
function renderLaneCount(lane: TaskLane) {
  const omitted = lane.omittedItems ?? 0;
  if (omitted > 0 && lane.totalItems !== undefined) {
    return t("cron.lanes.itemsShownOfTotal", {
      shown: String(lane.items.length),
      total: String(lane.totalItems),
    });
  }
  return String(lane.items.length);
}

function renderDiagnosticChip(diagnostic: TaskLaneDiagnostic) {
  if (diagnostic.ok) {
    return html`
      <span class="cron-task-lanes__chip cron-task-lanes__chip--ok">
        ${t("cron.lanes.providerOk", {
          provider: diagnostic.providerId,
          lanes: String(diagnostic.laneCount),
          items: String(diagnostic.itemCount),
        })}
      </span>
    `;
  }
  return html`
    <span class="cron-task-lanes__chip cron-task-lanes__chip--error">
      ${t("cron.lanes.providerError", { provider: diagnostic.providerId, error: diagnostic.error })}
    </span>
  `;
}

function renderLaneItem(item: TaskLaneItem) {
  return html`
    <div class="cron-task-lanes__item">
      <span class="cron-task-lanes__item-state cron-task-lanes__item-state--${item.state}">
        ${item.state}
      </span>
      <span class="cron-task-lanes__item-title">${item.title}</span>
      <span class="cron-task-lanes__item-time">
        ${formatRelativeTimestamp(item.startedAtMs, { fallback: "" })}
      </span>
      ${
        item.outcome
          ? html`<span class="cron-task-lanes__item-outcome">${item.outcome}</span>`
          : nothing
      }
      ${
        item.artifactUrl
          ? html`<a
              class="cron-task-lanes__item-artifact"
              href=${item.artifactUrl}
              target="_blank"
              rel="noreferrer noopener"
              >${t("cron.lanes.artifact")}</a
            >`
          : nothing
      }
    </div>
  `;
}

export function renderTaskLanesPanel(props: TaskLanesSectionProps) {
  if (props.taskLanesError) {
    return html`
      <div class="cron-task-lanes">
        <div class="cron-task-lanes__heading">
          <span class="cron-task-lanes__title">${t("cron.lanes.title")}</span>
        </div>
        <div class="cron-task-lanes__error" role="alert">${props.taskLanesError}</div>
      </div>
    `;
  }
  if (!props.taskLanes) {
    return nothing;
  }
  const snapshot = sortTaskLaneSnapshot(props.taskLanes);
  const heading = html`
    <div class="cron-task-lanes__heading">
      <span class="cron-task-lanes__title">${t("cron.lanes.title")}</span>
    </div>
  `;
  if (snapshot.lanes.length === 0 && snapshot.diagnostics.length === 0) {
    return html`
      <div class="cron-task-lanes">
        ${heading}
        <div class="cron-task-lanes__empty">${t("cron.lanes.empty")}</div>
      </div>
    `;
  }
  return html`
    <div class="cron-task-lanes">
      ${heading}
      ${
        snapshot.diagnostics.length > 0
          ? html`
              <div class="cron-task-lanes__diagnostics">
                ${snapshot.diagnostics.map(renderDiagnosticChip)}
              </div>
            `
          : nothing
      }
      ${
        snapshot.paging && snapshot.paging.totalItems > snapshot.paging.returnedItems
          ? html`
              <div class="cron-task-lanes__truncated" role="status">
                ${t("cron.lanes.truncated", {
                  shown: String(snapshot.paging.returnedItems),
                  total: String(snapshot.paging.totalItems),
                })}
              </div>
            `
          : nothing
      }
      <div class="cron-task-lanes__lanes">
        ${snapshot.lanes.map(
          (lane) => html`
            <details class="cron-task-lanes__lane">
              <summary class="cron-task-lanes__lane-summary">
                <span class="cron-task-lanes__lane-label">
                  ${lane.providerId ? `${lane.providerId} · ${lane.label}` : lane.label}
                </span>
                <span class="cron-task-lanes__lane-count">${renderLaneCount(lane)}</span>
              </summary>
              <div class="cron-task-lanes__items">${lane.items.map(renderLaneItem)}</div>
            </details>
          `,
        )}
      </div>
    </div>
  `;
}
