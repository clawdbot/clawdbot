// builtin:instances — connected instances + health over `system-presence`
// (PresenceEntry[]; see ui/src/api/types.ts). Each entry is a live gateway/node
// presence row; the widget shows the host/instance, mode, and an idle-derived
// health dot. Thin re-implementation — the instances page owns its own masking
// and refresh state.

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import { formatMs } from "../../format.ts";
import type { WorkspaceWidget } from "../types.ts";
import { isRecord, toFiniteNumber, widgetProps } from "./types.ts";

const DEFAULT_LIMIT = 8;
// A presence row idle beyond this window renders as degraded rather than live.
const HEALTHY_IDLE_SECONDS = 120;

type InstanceModel = {
  id: string;
  detail: string | null;
  healthy: boolean;
  lastInputMs: number | null;
};

type InstancesModel = {
  instances: InstanceModel[];
  total: number;
};

function instanceId(entry: Record<string, unknown>): string {
  const candidate = entry.instanceId ?? entry.host ?? entry.ip ?? entry.deviceFamily;
  return typeof candidate === "string" && candidate.trim() ? candidate : "";
}

function instanceDetail(entry: Record<string, unknown>): string | null {
  const parts = [entry.mode, entry.platform, entry.version].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

function mapInstances(widget: WorkspaceWidget, value: unknown): InstancesModel {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.presence)
      ? value.presence
      : isRecord(value) && Array.isArray(value.nodes)
        ? value.nodes
        : [];
  const limitProp = toFiniteNumber(widgetProps(widget).limit);
  const limit = limitProp && limitProp > 0 ? Math.trunc(limitProp) : DEFAULT_LIMIT;
  const records = raw.filter(isRecord);
  const instances = records
    .map((entry) => {
      const lastInputSeconds = toFiniteNumber(entry.lastInputSeconds);
      return {
        id: instanceId(entry),
        detail: instanceDetail(entry),
        healthy: lastInputSeconds === undefined || lastInputSeconds <= HEALTHY_IDLE_SECONDS,
        lastInputMs: lastInputSeconds !== undefined ? lastInputSeconds * 1000 : null,
      };
    })
    .filter((entry) => entry.id)
    .slice(0, limit);
  return { instances, total: records.length };
}

export function renderInstances(widget: WorkspaceWidget, value: unknown): TemplateResult {
  const model = mapInstances(widget, value);
  if (model.instances.length === 0) {
    return html`<div class="workspace-widget__placeholder">
      ${t("workspaces.widget.instances.empty")}
    </div>`;
  }
  return html`
    <ul class="workspace-list workspace-instances" data-test-id="workspace-instances">
      ${model.instances.map(
        (instance) => html`
          <li class="workspace-list__row">
            <span
              class="workspace-dot ${instance.healthy
                ? "workspace-dot--ok"
                : "workspace-dot--warn"}"
              aria-hidden="true"
            ></span>
            <span class="workspace-list__label">${instance.id}</span>
            ${instance.detail
              ? html`<span class="workspace-list__meta">${instance.detail}</span>`
              : nothing}
            ${instance.lastInputMs !== null
              ? html`<span class="workspace-list__meta"
                  >${t("workspaces.widget.instances.idle", {
                    duration: formatMs(instance.lastInputMs),
                  })}</span
                >`
              : nothing}
          </li>
        `,
      )}
    </ul>
  `;
}
