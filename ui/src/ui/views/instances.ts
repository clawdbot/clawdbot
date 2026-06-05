// Control UI view renders instances screen content.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import { formatPresenceAge } from "../presenter.ts";
import type { PresenceEntry } from "../types.ts";

export type InstancesProps = {
  loading: boolean;
  entries: PresenceEntry[];
  lastError: string | null;
  statusMessage: string | null;
  onRefresh: () => void;
};

let hostsRevealed = false;

export function renderInstances(props: InstancesProps) {
  const masked = !hostsRevealed;

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${t("instances.title")}</div>
          <div class="card-sub">${t("instances.subtitle")}</div>
        </div>
        <div class="row" style="gap: 8px;">
          <button
            class="btn btn--icon ${masked ? "" : "active"}"
            @click=${() => {
              hostsRevealed = !hostsRevealed;
              props.onRefresh();
            }}
            title=${masked ? t("instances.showHosts") : t("instances.hideHosts")}
            aria-label=${t("instances.toggleHostVisibility")}
            aria-pressed=${!masked}
            style="width: 36px; height: 36px;"
          >
            ${masked ? icons.eyeOff : icons.eye}
          </button>
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? t("common.loading") : t("common.refresh")}
          </button>
        </div>
      </div>
      ${props.lastError
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.lastError}</div>`
        : nothing}
      ${props.statusMessage
        ? html`<div class="callout" style="margin-top: 12px;">${props.statusMessage}</div>`
        : nothing}
      <div class="list" style="margin-top: 16px;">
        ${props.entries.length === 0
          ? html` <div class="muted">${t("instances.noInstances")}</div> `
          : props.entries.map((entry) => renderEntry(entry, masked))}
      </div>
    </section>
  `;
}

function renderEntry(entry: PresenceEntry, masked: boolean) {
  const lastInput =
    entry.lastInputSeconds != null
      ? t("common.secondsAgo", { count: String(entry.lastInputSeconds) })
      : t("common.na");
  const mode = entry.mode ?? "unknown";
  const host = entry.host ?? "unknown host";
  const ip = entry.ip ?? null;
  const roles = Array.isArray(entry.roles) ? entry.roles.filter(Boolean) : [];
  const scopes = Array.isArray(entry.scopes) ? entry.scopes.filter(Boolean) : [];
  const scopesLabel =
    scopes.length > 0
      ? scopes.length > 3
        ? `${scopes.length} scopes`
        : `scopes: ${scopes.join(", ")}`
      : null;
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">
          <span class="${masked ? "redacted" : ""}">${host}</span>
        </div>
        <div class="list-sub">
          ${ip ? html`<span class="${masked ? "redacted" : ""}">${ip}</span> ` : nothing}${mode}
          ${entry.version ?? ""}
        </div>
        <div class="chip-row">
          <span class="chip">${mode}</span>
          ${roles.map((role) => html`<span class="chip">${role}</span>`)}
          ${scopesLabel ? html`<span class="chip">${scopesLabel}</span>` : nothing}
          ${entry.platform ? html`<span class="chip">${entry.platform}</span>` : nothing}
          ${entry.deviceFamily ? html`<span class="chip">${entry.deviceFamily}</span>` : nothing}
          ${entry.modelIdentifier
            ? html`<span class="chip">${entry.modelIdentifier}</span>`
            : nothing}
          ${entry.version ? html`<span class="chip">${entry.version}</span>` : nothing}
        </div>
      </div>
      <div class="list-meta">
        <div>${formatPresenceAge(entry)}</div>
        <div class="muted">${t("instances.lastInput", { time: lastInput })}</div>
        <div class="muted">${t("instances.reason", { reason: entry.reason ?? "" })}</div>
      </div>
    </div>
  `;
}
