import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import {
  formatDurationCompact,
  formatDurationHuman,
  formatRelativeTimestamp,
} from "../../lib/format.ts";
import {
  loadCommandLaneDiagnostics,
  type CommandLaneDiagnostics,
} from "../../lib/gateway-diagnostics.ts";
import { renderCommandLaneRows } from "./lane-table.ts";

type DebugOverlaySectionContext = {
  client: GatewayBrowserClient;
  gateway: ApplicationGateway;
};

type TypedDebugOverlaySectionDescriptor<T> = {
  id: string;
  titleKey: string;
  load: (context: DebugOverlaySectionContext, signal: AbortSignal) => Promise<T>;
  render: (value: T, statusHistory: readonly DebugOverlayStatusSnapshot[]) => TemplateResult;
};

export type DebugOverlaySectionDescriptor = TypedDebugOverlaySectionDescriptor<unknown>;

function defineDebugOverlaySection<T>(
  descriptor: TypedDebugOverlaySectionDescriptor<T>,
): DebugOverlaySectionDescriptor {
  return {
    ...descriptor,
    render: (value, statusHistory) => {
      // SAFETY: This closure keeps each descriptor's load result paired with its own renderer.
      return descriptor.render(value as T, statusHistory);
    },
  };
}

type EventLoopSnapshot = {
  utilization?: number;
  cpuCoreRatio?: number;
  delayP99Ms?: number;
  delayMaxMs?: number;
};

export type DebugOverlayStatusSnapshot = {
  eventLoop?: EventLoopSnapshot;
  processMemory?: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
  };
  uptimeMs?: number;
};

type ActiveSession = {
  key?: string;
  sessionId?: string;
};

function renderLanes(diagnostics: CommandLaneDiagnostics): TemplateResult {
  return html`
    <div class="debug-overlay__table-wrap">
      <table class="data-table command-lanes-table command-lanes-table--compact">
        <thead>
          <tr>
            <th>${t("debug.lanes.lane")}</th>
            <th>${t("debug.lanes.active")}</th>
            <th>${t("debug.lanes.queued")}</th>
            <th>${t("debug.lanes.blocked")}</th>
          </tr>
        </thead>
        <tbody>
          ${renderCommandLaneRows(diagnostics, { compact: true })}
        </tbody>
      </table>
    </div>
  `;
}

function renderSparkline(
  history: readonly DebugOverlayStatusSnapshot[],
  kind: "cpu" | "memory" | "delay",
  label: string,
  readValue: (sample: DebugOverlayStatusSnapshot) => number | undefined,
  formatValue: (value: number) => string | undefined,
) {
  const values = history.map(readValue).filter((value): value is number => Number.isFinite(value));
  const current = values.at(-1);
  if (values.length < 2 || current === undefined) {
    return nothing;
  }
  const maximum = Math.max(...values, 1);
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      const y = 30 - (value / maximum) * 26;
      return `${x},${y}`;
    })
    .join(" ");
  return html`
    <figure class="debug-overlay__graph debug-overlay__graph--${kind}">
      <figcaption>
        <span>${label}</span>
        <span class="mono">${formatValue(current)}</span>
      </figcaption>
      <svg viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
        <polygon points="0,32 ${points} 100,32"></polygon>
        <polyline points=${points}></polyline>
      </svg>
    </figure>
  `;
}

function renderStatus(
  status: DebugOverlayStatusSnapshot,
  history: readonly DebugOverlayStatusSnapshot[],
): TemplateResult {
  const eventLoop = status.eventLoop;
  const utilization =
    typeof eventLoop?.utilization === "number"
      ? `${Math.round(eventLoop.utilization * 100)}%`
      : t("common.na");
  const delay =
    typeof eventLoop?.delayP99Ms === "number"
      ? formatDurationCompact(eventLoop.delayP99Ms)
      : t("common.na");
  const maxDelay =
    typeof eventLoop?.delayMaxMs === "number"
      ? formatDurationCompact(eventLoop.delayMaxMs)
      : t("common.na");
  return html`
    ${history.length >= 2
      ? html`<div class="debug-overlay__graphs">
          ${renderSparkline(
            history,
            "cpu",
            t("debug.overlay.cpu"),
            (sample) => sample.eventLoop?.cpuCoreRatio,
            (value) => `${Math.round(value * 100)}%`,
          )}
          ${renderSparkline(
            history,
            "memory",
            t("debug.overlay.memory"),
            (sample) => sample.processMemory?.rssBytes,
            (value) =>
              t("debug.overlay.memoryMb", { value: String(Math.round(value / 1_048_576)) }),
          )}
          ${renderSparkline(
            history,
            "delay",
            t("debug.overlay.delayP99"),
            (sample) => sample.eventLoop?.delayP99Ms,
            formatDurationCompact,
          )}
        </div>`
      : nothing}
    <dl class="debug-overlay__metrics">
      <div>
        <dt>${t("debug.overlay.utilization")}</dt>
        <dd class="mono">${utilization}</dd>
      </div>
      <div>
        <dt>${t("debug.overlay.delayP99")}</dt>
        <dd class="mono">${delay}</dd>
      </div>
      <div>
        <dt>${t("debug.overlay.delayMax")}</dt>
        <dd class="mono">${maxDelay}</dd>
      </div>
      ${typeof status.uptimeMs === "number"
        ? html`<div>
            <dt>${t("debug.overlay.uptime")}</dt>
            <dd class="mono">${formatDurationHuman(status.uptimeMs)}</dd>
          </div>`
        : ""}
    </dl>
  `;
}

function renderActiveRuns(sessions: ActiveSession[]): TemplateResult {
  return html`
    <div class="debug-overlay__count">
      ${t("debug.overlay.activeRunsCount", { count: String(sessions.length) })}
    </div>
    ${sessions.length > 0
      ? html`<ul class="debug-overlay__list">
          ${sessions.map((session) => {
            const id = session.sessionId ?? session.key ?? t("common.unknown");
            return html`<li class="mono" title=${id}>${truncateUtf16Safe(id, 32)}</li>`;
          })}
        </ul>`
      : html`<div class="debug-overlay__empty">${t("debug.overlay.noActiveRuns")}</div>`}
  `;
}

function renderEvents(gateway: ApplicationGateway): TemplateResult {
  // The store prepends: eventLog is newest-first, so the head is the live tail.
  const events = gateway.eventLog.slice(0, 8);
  return events.length > 0
    ? html`<ul class="debug-overlay__list debug-overlay__events">
        ${events.map(
          (event) => html`<li>
            <span class="mono">${event.event}</span>
            <time>${formatRelativeTimestamp(event.ts)}</time>
          </li>`,
        )}
      </ul>`
    : html`<div class="debug-overlay__empty">${t("debug.noEvents")}</div>`;
}

export const DEBUG_OVERLAY_SECTIONS: readonly DebugOverlaySectionDescriptor[] = [
  defineDebugOverlaySection({
    id: "lanes",
    titleKey: "debug.overlay.lanes",
    load: (context, signal) => loadCommandLaneDiagnostics(context.client, signal),
    render: renderLanes,
  }),
  defineDebugOverlaySection({
    id: "status",
    titleKey: "debug.overlay.status",
    load: async (context, signal) => {
      const value = await context.client.request<DebugOverlayStatusSnapshot>(
        "status",
        {},
        { signal },
      );
      return {
        eventLoop: value.eventLoop,
        processMemory: value.processMemory,
        ...(typeof value.uptimeMs === "number" ? { uptimeMs: value.uptimeMs } : {}),
      } satisfies DebugOverlayStatusSnapshot;
    },
    render: renderStatus,
  }),
  defineDebugOverlaySection({
    id: "active-runs",
    titleKey: "debug.overlay.activeRuns",
    load: async (context, signal) => {
      const payload = await context.client.request<{
        sessions?: Array<ActiveSession & { hasActiveRun?: boolean }>;
      }>("sessions.list", {}, { signal });
      return (payload.sessions ?? []).filter((session) => session.hasActiveRun === true);
    },
    render: renderActiveRuns,
  }),
  defineDebugOverlaySection({
    id: "events",
    titleKey: "debug.overlay.events",
    load: async (context) => context.gateway,
    render: renderEvents,
  }),
];
