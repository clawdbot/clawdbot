import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { currentWorkIdentity } from "./current-work.ts";

registerActivityEnglish();

type CurrentWorkProps = {
  basePath: string;
  fallbackAgentId: string;
  mainKey: string;
  globalScope: boolean;
  navigate: ApplicationContext["navigate"];
  connected: boolean;
  result?: SessionsListResult;
  loading: boolean;
  incomplete: boolean;
  error?: string;
  onRetry: () => void;
};

function renderCurrentSession(props: CurrentWorkProps, row: GatewaySessionRow) {
  const content = html`<span class="activity-current-work__copy">
      <span class="activity-current-work__title">${resolveSessionDisplayName(row.key, row)}</span>
      <span class="activity-current-work__agent"
        >${row.agentId ? t("activityFeed.agentLabel", { value: row.agentId }) : row.key}</span
      >
    </span>
    ${renderSettingsStatus({ kind: "warn", label: row.status === "queued" ? t("activity.currentWork.queued") : t("activity.status.running") })}`;
  // The Home URL addresses raw global only in global scope; raw unknown has no exact URL.
  if (row.key === "unknown" || (row.key === "global" && !props.globalScope)) {
    return html`<div
      class="activity-current-work__row"
      data-session-key=${row.key}
      data-agent-id=${row.agentId ?? nothing}
    >
      ${content}
    </div>`;
  }
  const face = resolveSessionPreferredFace(row);
  const target = sessionNavigationTarget({
    face,
    sessionKey: row.key,
    basePath: props.basePath,
    fallbackAgentId: row.agentId ?? props.fallbackAgentId,
    mainKey: props.mainKey,
    row,
  });
  return html`<a
    class="activity-current-work__row"
    data-session-key=${row.key}
    data-agent-id=${row.agentId ?? nothing}
    href=${target.href}
    @click=${(event: MouseEvent) => {
      if (shouldHandleNavigationClick(event)) {
        event.preventDefault();
        props.navigate(face, target.options);
      }
    }}
  >
    ${content}
  </a>`;
}

export function renderCurrentWork(props: CurrentWorkProps) {
  const rows = props.connected && !props.error ? (props.result?.sessions ?? []) : [];
  const message = !props.connected
    ? t("activity.currentWork.disconnected")
    : props.error
      ? t("activity.currentWork.loadFailed")
      : !props.result || (rows.length === 0 && props.incomplete)
        ? t("activity.currentWork.loading")
        : rows.length === 0
          ? t("activity.currentWork.empty")
          : null;
  return html`<section
    class="activity-current-work"
    aria-label=${t("activity.currentWork.title")}
    aria-busy=${props.loading}
  >
    <div class="settings-section__header">
      <h2 class="settings-section__heading">${t("activity.currentWork.title")}</h2>
    </div>
    <div class="settings-group activity-current-work__rows">
      ${
        message
          ? html`<div class="activity-current-work__feedback" role="status">
              <span>${message}</span>
              ${props.error ? html`<button type="button" class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRetry}>${t("common.retry")}</button>` : nothing}
            </div>`
          : repeat(rows, currentWorkIdentity, (row) => renderCurrentSession(props, row))
      }
      ${props.result?.hasMore && !message ? html`<div class="activity-current-work__feedback">${t("activity.currentWork.limit", { count: String(rows.length), total: String(props.result.totalCount ?? rows.length) })}</div>` : nothing}
    </div>
  </section>`;
}
