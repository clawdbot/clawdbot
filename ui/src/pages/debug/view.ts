// Control UI view renders debug screen content.
import { html, nothing } from "lit";
import type { EventLogEntry } from "../../api/event-log.ts";
import {
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatTimeMs } from "../../lib/format.ts";
import { formatEventPayload } from "../../lib/presenter.ts";

type DebugProps = {
  loading: boolean;
  status: Record<string, unknown> | null;
  health: Record<string, unknown> | null;
  models: unknown[];
  heartbeat: unknown;
  eventLog: readonly EventLogEntry[];
  methods: string[];
  callMethod: string;
  callParams: string;
  callResult: string | null;
  callError: string | null;
  onCallMethodChange: (next: string) => void;
  onCallParamsChange: (next: string) => void;
  onRefresh: () => void;
  onCall: () => void;
};

function renderJsonRow(title: unknown, value: unknown) {
  return renderSettingsRow({
    title,
    stacked: true,
    control: html`<pre class="code-block">${JSON.stringify(value ?? {}, null, 2)}</pre>`,
  });
}

function renderSecurityRow(props: DebugProps) {
  const securityAudit =
    props.status && typeof props.status === "object"
      ? (props.status as { securityAudit?: { summary?: Record<string, number> } }).securityAudit
      : null;
  const securitySummary = securityAudit?.summary ?? null;
  if (!securitySummary) {
    return nothing;
  }
  const critical = securitySummary.critical ?? 0;
  const warn = securitySummary.warn ?? 0;
  const info = securitySummary.info ?? 0;
  const securityKind = critical > 0 ? "danger" : warn > 0 ? "warn" : "ok";
  const securityLabel =
    critical > 0
      ? t("debug.security.critical", { count: String(critical) })
      : warn > 0
        ? t("debug.security.warnings", { count: String(warn) })
        : t("debug.security.noCriticalIssues");
  const infoSuffix = info > 0 ? ` · ${t("debug.security.info", { count: String(info) })}` : "";
  return renderSettingsRow({
    title: t("debug.security.audit"),
    description: html`
      ${t("debug.security.runPrefix")}
      <span class="mono">openclaw security audit --deep</span>
      ${t("debug.security.runSuffix")}
    `,
    control: renderSettingsStatus({ kind: securityKind, label: `${securityLabel}${infoSuffix}` }),
  });
}

function renderEventRow(evt: EventLogEntry) {
  return renderSettingsRow({
    title: evt.event,
    description: formatTimeMs(evt.ts, undefined, ""),
    stacked: true,
    control: html`<pre class="code-block">${formatEventPayload(evt.payload)}</pre>`,
  });
}

export function renderDebug(props: DebugProps) {
  const snapshotsSection = renderSettingsSection(
    {
      title: t("debug.snapshotsTitle"),
      description: t("debug.snapshotsSubtitle"),
      actions: html`
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? t("common.refreshing") : t("common.refresh")}
        </button>
      `,
    },
    html`
      ${renderSecurityRow(props)} ${renderJsonRow(t("debug.status"), props.status)}
      ${renderJsonRow(t("debug.health"), props.health)}
      ${renderJsonRow(t("debug.lastHeartbeat"), props.heartbeat)}
    `,
  );

  const rpcSection = renderSettingsSection(
    { title: t("debug.manualRpcTitle"), description: t("debug.manualRpcSubtitle") },
    html`
      ${renderSettingsRow({
        title: t("debug.method"),
        control: html`
          <select
            class="settings-select"
            aria-label=${t("debug.method")}
            .value=${props.callMethod}
            @change=${(e: Event) => props.onCallMethodChange((e.target as HTMLSelectElement).value)}
          >
            ${!props.callMethod
              ? html` <option value="" disabled>${t("debug.selectMethod")}</option> `
              : nothing}
            ${props.methods.map((m) => html`<option value=${m}>${m}</option>`)}
          </select>
        `,
      })}
      ${renderSettingsRow({
        title: t("debug.paramsJson"),
        stacked: true,
        control: html`
          <textarea
            class="settings-input"
            aria-label=${t("debug.paramsJson")}
            .value=${props.callParams}
            @input=${(e: Event) =>
              props.onCallParamsChange((e.target as HTMLTextAreaElement).value)}
            rows="6"
          ></textarea>
        `,
      })}
      ${renderSettingsRow({
        title: t("common.call"),
        control: html`
          <button class="btn primary" @click=${props.onCall}>${t("common.call")}</button>
        `,
      })}
      ${props.callError
        ? html`
            <div class="settings-row settings-row--stacked">
              ${renderSettingsStatus({ kind: "danger", label: t("debug.callFailed") })}
              <pre class="code-block">${props.callError}</pre>
            </div>
          `
        : nothing}
      ${props.callResult
        ? html`
            <div class="settings-row settings-row--stacked">
              ${renderSettingsStatus({ kind: "ok", label: t("common.ok") })}
              <pre class="code-block">${props.callResult}</pre>
            </div>
          `
        : nothing}
    `,
  );

  const modelsSection = renderSettingsSection(
    { title: t("debug.modelsTitle"), description: t("debug.modelsSubtitle") },
    html`
      <div class="settings-row settings-row--stacked">
        <pre class="code-block">${JSON.stringify(props.models ?? [], null, 2)}</pre>
      </div>
    `,
  );

  const eventLogSection = renderSettingsSection(
    { title: t("debug.eventLogTitle"), description: t("debug.eventLogSubtitle") },
    props.eventLog.length === 0
      ? renderSettingsEmpty(t("debug.noEvents"))
      : props.eventLog.map((evt) => renderEventRow(evt)),
  );

  return renderSettingsPage(
    html`${snapshotsSection} ${rpcSection} ${modelsSection} ${eventLogSection}`,
    { wide: true },
  );
}
