import { formatByteSize } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing, type TemplateResult } from "lit";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
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
import "./sparkline-tile.ts";
import type { SparklineSample } from "./sparkline-tile.ts";

type DebugOverlaySectionContext = {
  client: GatewayBrowserClient;
  gateway: ApplicationGateway;
};

type TypedDebugOverlaySectionDescriptor<T> = {
  id: string;
  titleKey: string;
  load: (context: DebugOverlaySectionContext, signal: AbortSignal) => Promise<T>;
  render: (value: T, statusHistory: readonly DebugOverlayStatusSample[]) => TemplateResult;
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
  reasons?: string[];
};

export type DebugOverlayStatusSnapshot = {
  eventLoop?: EventLoopSnapshot;
  processMemory?: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
  };
  diskSpace?: {
    availableBytes: number;
    totalBytes: number;
    path?: string;
  };
  uptimeMs?: number;
};

export type DebugOverlayStatusSample = {
  at: number;
  status: DebugOverlayStatusSnapshot;
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

function collectSamples(
  history: readonly DebugOverlayStatusSample[],
  read: (status: DebugOverlayStatusSnapshot) => number | undefined,
): SparklineSample[] {
  const samples: SparklineSample[] = [];
  for (const entry of history) {
    const value = read(entry.status);
    if (typeof value === "number" && Number.isFinite(value)) {
      samples.push({ value, at: entry.at });
    }
  }
  return samples;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatMegabytes(bytes: number): string {
  return t("debug.overlay.memoryMb", { value: String(Math.round(bytes / 1_048_576)) });
}

function formatDelayMs(value: number): string {
  return formatDurationCompact(value) ?? t("common.na");
}

function formatFreeBytes(bytes: number): string {
  return t("debug.overlay.freeShort", { value: formatStorageBytes(bytes) });
}

function formatStorageBytes(bytes: number): string {
  return formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: "tera",
    separator: " ",
    fractionDigits: (value, unit) => (unit === "byte" ? null : value < 10 ? 1 : 0),
  });
}

function renderStatus(
  status: DebugOverlayStatusSnapshot,
  history: readonly DebugOverlayStatusSample[],
): TemplateResult {
  const eventLoop = status.eventLoop;
  const reasons = eventLoop?.reasons ?? [];
  const cpuDegraded = reasons.includes("cpu") || reasons.includes("event_loop_utilization");
  const delayDegraded = reasons.includes("event_loop_delay");
  const loopSub =
    typeof eventLoop?.utilization === "number"
      ? t("debug.overlay.loopShort", { value: formatPercent(eventLoop.utilization) })
      : "";
  const heapSub =
    typeof status.processMemory?.heapUsedBytes === "number"
      ? t("debug.overlay.heapShort", { value: formatMegabytes(status.processMemory.heapUsedBytes) })
      : "";
  const maxSub =
    typeof eventLoop?.delayMaxMs === "number"
      ? t("debug.overlay.maxShort", { value: formatDelayMs(eventLoop.delayMaxMs) })
      : "";
  const diskTotalSub =
    typeof status.diskSpace?.totalBytes === "number"
      ? t("debug.overlay.totalShort", { value: formatStorageBytes(status.diskSpace.totalBytes) })
      : "";
  return html`
    <div class="debug-overlay__vitals">
      <openclaw-debug-sparkline
        class="debug-overlay__vital debug-overlay__vital--cpu"
        data-degraded=${cpuDegraded ? "" : nothing}
        .label=${t("debug.overlay.cpu")}
        .sub=${loopSub}
        .samples=${collectSamples(history, (sample) => sample.eventLoop?.cpuCoreRatio)}
        .format=${formatPercent}
        .floorMax=${1}
      ></openclaw-debug-sparkline>
      <openclaw-debug-sparkline
        class="debug-overlay__vital debug-overlay__vital--memory"
        .label=${t("debug.overlay.memory")}
        .sub=${heapSub}
        .samples=${collectSamples(history, (sample) => sample.processMemory?.rssBytes)}
        .format=${formatMegabytes}
        autorange
      ></openclaw-debug-sparkline>
      <openclaw-debug-sparkline
        class="debug-overlay__vital debug-overlay__vital--delay"
        data-degraded=${delayDegraded ? "" : nothing}
        .label=${t("debug.overlay.delayP99")}
        .sub=${maxSub}
        .samples=${collectSamples(history, (sample) => sample.eventLoop?.delayP99Ms)}
        .format=${formatDelayMs}
        .floorMax=${20}
      ></openclaw-debug-sparkline>
      ${status.diskSpace
        ? html`<openclaw-debug-sparkline
            class="debug-overlay__vital debug-overlay__vital--disk"
            title=${status.diskSpace.path ?? ""}
            .label=${t("debug.overlay.disk")}
            .sub=${diskTotalSub}
            .samples=${collectSamples(history, (sample) => sample.diskSpace?.availableBytes)}
            .format=${formatFreeBytes}
            autorange
          ></openclaw-debug-sparkline>`
        : nothing}
    </div>
    ${typeof status.uptimeMs === "number"
      ? html`<div class="debug-overlay__vitals-footer mono">
          ${t("debug.overlay.uptime")} ${formatDurationHuman(status.uptimeMs)}
        </div>`
      : nothing}
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
      const [value, systemInfo] = await Promise.all([
        context.client.request<DebugOverlayStatusSnapshot>("status", {}, { signal }),
        context.client.request<SystemInfoResult>("system.info", {}, { signal }).catch(() => null),
      ]);
      const diskSpace =
        typeof systemInfo?.diskAvailableBytes === "number" &&
        typeof systemInfo.diskTotalBytes === "number"
          ? {
              availableBytes: systemInfo.diskAvailableBytes,
              totalBytes: systemInfo.diskTotalBytes,
              ...(systemInfo.diskPath ? { path: systemInfo.diskPath } : {}),
            }
          : undefined;
      return {
        eventLoop: value.eventLoop,
        processMemory: value.processMemory,
        ...(diskSpace ? { diskSpace } : {}),
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
