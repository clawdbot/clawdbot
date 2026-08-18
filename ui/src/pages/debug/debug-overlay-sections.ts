import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, type TemplateResult } from "lit";
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
  type CommandLaneSnapshot,
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
  render: (value: T) => TemplateResult;
};

export type DebugOverlaySectionDescriptor = TypedDebugOverlaySectionDescriptor<unknown>;

function defineDebugOverlaySection<T>(
  descriptor: TypedDebugOverlaySectionDescriptor<T>,
): DebugOverlaySectionDescriptor {
  return {
    ...descriptor,
    render: (value) => {
      // SAFETY: This closure keeps each descriptor's load result paired with its own renderer.
      return descriptor.render(value as T);
    },
  };
}

type EventLoopSnapshot = {
  utilization?: number;
  delayP99Ms?: number;
  delayMaxMs?: number;
};

type StatusSectionValue = {
  eventLoop?: EventLoopSnapshot;
  uptimeMs?: number;
};

type ActiveSession = {
  key?: string;
  sessionId?: string;
};

function renderLanes(lanes: CommandLaneSnapshot[]): TemplateResult {
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
          ${renderCommandLaneRows(lanes, { compact: true })}
        </tbody>
      </table>
    </div>
  `;
}

function renderStatus(status: StatusSectionValue): TemplateResult {
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
  const events = gateway.eventLog.slice(-8).toReversed();
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
      const value = await context.client.request<StatusSectionValue>("status", {}, { signal });
      return {
        eventLoop: value.eventLoop,
        ...(typeof value.uptimeMs === "number" ? { uptimeMs: value.uptimeMs } : {}),
      } satisfies StatusSectionValue;
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
