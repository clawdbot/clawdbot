// Control UI page renders skills screen content. The list surfaces follow the
// settings design language (ui/docs/design-system/settings-design.md): section
// headings outside one group surface, rows with a control cluster, dot+text
// status instead of pills. The detail/ClawHub dialogs keep their specialized
// markup.
import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { AgentsListResult, SkillStatusEntry, SkillStatusReport } from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import "../../components/modal-dialog.ts";
import {
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsToggle,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { clampText } from "../../lib/format.ts";
import { resolveSafeExternalUrl } from "../../lib/open-external-url.ts";
import { groupSkills, type SkillGroup } from "../../lib/skills-grouping.ts";
import "../../styles/plugins.css";
import "../../styles/sidebar-markdown.css";
import {
  computeSkillMissing,
  computeSkillReasons,
  isSkillAvailable,
  renderSkillStatusChips,
} from "../../lib/skills-shared.ts";
import {
  clawhubVerdictKey,
  type ClawHubSkillSecurityVerdict,
  type ClawHubSearchResult,
  type ClawHubSkillDetail,
  type SkillOperation,
  type SkillMessageMap,
} from "../../lib/skills/index.ts";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";

function safeExternalHref(raw?: string): string | null {
  if (!raw) {
    return null;
  }
  return resolveSafeExternalUrl(raw, window.location.href);
}

export type SkillsStatusFilter = "all" | "ready" | "needs-setup" | "disabled";
export type SkillDetailTab = "overview" | "card";

type SkillsProps = {
  connected: boolean;
  loading: boolean;
  report: SkillStatusReport | null;
  agentsList: AgentsListResult | null;
  selectedAgentId: string | null;
  error: string | null;
  filter: string;
  statusFilter: SkillsStatusFilter;
  edits: Record<string, string>;
  operation: SkillOperation;
  messages: SkillMessageMap;
  detailKey: string | null;
  detailTab: SkillDetailTab;
  clawhubVerdicts: Record<string, ClawHubSkillSecurityVerdict>;
  clawhubVerdictsLoading: boolean;
  clawhubVerdictsError: string | null;
  skillCardContents: Record<string, string>;
  skillCardLoadingKey: string | null;
  skillCardErrors: Record<string, string>;
  clawhubQuery: string;
  clawhubResults: ClawHubSearchResult[] | null;
  clawhubSearchLoading: boolean;
  clawhubSearchError: string | null;
  clawhubDetail: ClawHubSkillDetail | null;
  clawhubDetailSlug: string | null;
  clawhubDetailLoading: boolean;
  clawhubDetailError: string | null;
  clawhubInstallMessage: {
    kind: "success" | "error";
    text: string;
    acknowledgeSlug?: string;
    acknowledgeVersion?: string;
    acknowledgeLabel?: string;
  } | null;
  onFilterChange: (next: string) => void;
  onAgentChange: (agentId: string) => void;
  onStatusFilterChange: (next: SkillsStatusFilter) => void;
  onRefresh: () => void;
  onToggle: (skillKey: string, enabled: boolean) => void;
  onEdit: (skillKey: string, value: string) => void;
  onSaveKey: (skillKey: string) => void;
  onInstall: (skillKey: string, name: string, installId: string) => void;
  onDetailOpen: (skillKey: string) => void;
  onDetailClose: () => void;
  onDetailTabChange: (tab: SkillDetailTab) => void;
  onClawHubQueryChange: (query: string) => void;
  onClawHubDetailOpen: (slug: string) => void;
  onClawHubDetailClose: () => void;
  onClawHubInstall: (slug: string, acknowledgeClawHubRisk?: boolean, version?: string) => void;
};

type StatusTabDef = { id: SkillsStatusFilter; labelKey: string };

const STATUS_TABS: StatusTabDef[] = [
  { id: "all", labelKey: "skillsPage.tabs.all" },
  { id: "ready", labelKey: "skillsPage.tabs.ready" },
  { id: "needs-setup", labelKey: "skillsPage.tabs.needsSetup" },
  { id: "disabled", labelKey: "skillsPage.tabs.disabled" },
];

function skillMatchesStatus(skill: SkillStatusEntry, status: SkillsStatusFilter): boolean {
  switch (status) {
    case "all":
      return true;
    case "ready":
      return !skill.disabled && isSkillAvailable(skill);
    case "needs-setup":
      return !skill.disabled && !isSkillAvailable(skill);
    case "disabled":
      return skill.disabled;
  }
  throw new Error("Unsupported skills status filter");
}

function skillStatusClass(skill: SkillStatusEntry): string {
  if (skill.disabled) {
    return "muted";
  }
  return isSkillAvailable(skill) ? "ok" : "warn";
}

/** Dot+text availability status for a skill row. */
function skillAvailabilityStatus(skill: SkillStatusEntry): TemplateResult {
  if (skill.disabled) {
    return renderSettingsStatus({ kind: "muted", label: t("skillsPage.tabs.disabled") });
  }
  return isSkillAvailable(skill)
    ? renderSettingsStatus({ kind: "ok", label: t("skillsPage.tabs.ready") })
    : renderSettingsStatus({ kind: "warn", label: t("skillsPage.tabs.needsSetup") });
}

function verdictForSkill(skill: SkillStatusEntry, verdicts: SkillsProps["clawhubVerdicts"]) {
  const link = skill.clawhub;
  if (!link || link.status !== "linked" || !link.valid) {
    return null;
  }
  return (
    verdicts[
      clawhubVerdictKey({
        registry: link.registry,
        slug: link.slug,
        version: link.installedVersion,
      })
    ] ?? null
  );
}

function verdictLabel(verdict: ClawHubSkillSecurityVerdict | null | undefined): string {
  if (!verdict) {
    return t("skillsPage.verdict.unavailable");
  }
  const status = verdict.securityStatus?.trim() || null;
  if (verdict.ok && verdict.decision === "pass") {
    return status === "clean" || !status ? t("skillsPage.verdict.clean") : status;
  }
  if (status === "pending" || status === "not-run") {
    return t("skillsPage.verdict.pending");
  }
  if (status === "malicious") {
    return t("skillsPage.verdict.blocked");
  }
  if (status === "suspicious") {
    return t("skillsPage.verdict.review");
  }
  return t("skillsPage.verdict.unavailable");
}

function verdictChipClass(verdict: ClawHubSkillSecurityVerdict | null | undefined): string {
  if (!verdict) {
    return "chip-warn";
  }
  if (verdict.ok && verdict.decision === "pass") {
    return "chip-ok";
  }
  const status = verdict.securityStatus?.trim() || null;
  return status === "pending" || status === "not-run" ? "chip" : "chip-warn";
}

function verdictStatusKind(
  verdict: ClawHubSkillSecurityVerdict | null | undefined,
): "ok" | "warn" | "muted" {
  if (!verdict) {
    return "warn";
  }
  if (verdict.ok && verdict.decision === "pass") {
    return "ok";
  }
  const status = verdict.securityStatus?.trim() || null;
  return status === "pending" || status === "not-run" ? "muted" : "warn";
}

type SkillsAgentOption = AgentsListResult["agents"][number];

function agentOptionLabel(agent: SkillsAgentOption, defaultId: string | undefined): string {
  const baseName = agent.identity?.name?.trim() || agent.name?.trim() || agent.id;
  return agent.id === defaultId ? t("skillsPage.defaultAgent", { name: baseName }) : baseName;
}

function skillControlsLocked(props: SkillsProps): boolean {
  return props.loading || props.operation !== null;
}

function activeSkillMutation(props: SkillsProps, skillKey: string): boolean {
  return props.operation?.kind === "skill" && props.operation.skillKey === skillKey;
}

function activeClawHubMutation(props: SkillsProps, slug: string): boolean {
  return props.operation?.kind === "clawhub" && props.operation.slug === slug;
}

export function renderSkills(props: SkillsProps) {
  const skills = props.report?.skills ?? [];

  const statusCounts: Record<SkillsStatusFilter, number> = {
    all: skills.length,
    ready: 0,
    "needs-setup": 0,
    disabled: 0,
  };
  for (const s of skills) {
    if (s.disabled) {
      statusCounts.disabled++;
    } else if (isSkillAvailable(s)) {
      statusCounts.ready++;
    } else {
      statusCounts["needs-setup"]++;
    }
  }

  const afterStatus =
    props.statusFilter === "all"
      ? skills
      : skills.filter((s) => skillMatchesStatus(s, props.statusFilter));

  const filter = normalizeLowercaseStringOrEmpty(props.filter);
  const filtered = filter
    ? afterStatus.filter((skill) =>
        normalizeLowercaseStringOrEmpty(
          [skill.name, skill.description, skill.source].join(" "),
        ).includes(filter),
      )
    : afterStatus;
  const groups = groupSkills(filtered);

  const detailSkill = props.detailKey
    ? (skills.find((s) => s.skillKey === props.detailKey) ?? null)
    : null;

  return html`
    ${renderSettingsPage(
      html`
        ${renderSkillsToolbar(props, statusCounts, filtered.length)}
        ${props.error
          ? html`<div class="callout danger" role="alert">${props.error}</div>`
          : nothing}
        ${renderClawHubSection(props)}
        ${filtered.length === 0
          ? renderSettingsEmpty(
              !props.connected && !props.report
                ? t("skillsPage.disconnected")
                : t("skillsPage.empty"),
            )
          : groups.map((group) => renderSkillGroup(group, props))}
      `,
      { wide: true },
    )}
    ${detailSkill ? renderSkillDetail(detailSkill, props) : nothing}
    ${props.clawhubDetailSlug ? renderClawHubDetailDialog(props) : nothing}
  `;
}

/** Collapsible skill group: settings-section look, but a <details>/<summary>
 * shell so each group keeps the pre-migration expand/collapse interaction. */
function renderSkillGroup(group: SkillGroup, props: SkillsProps) {
  return html`
    <details class="settings-section skills-group" open>
      <summary class="settings-section__header skills-group__summary">
        <h2 class="settings-section__heading">
          ${group.label} <span class="settings-count">${group.skills.length}</span>
        </h2>
        <span class="skills-group__chevron" aria-hidden="true">${icons.chevronDown}</span>
      </summary>
      <div class="settings-group">
        ${repeat(
          group.skills,
          (skill) => skill.skillKey,
          (skill) => renderSkill(skill, props),
        )}
      </div>
    </details>
  `;
}

function renderSkillsToolbar(
  props: SkillsProps,
  statusCounts: Record<SkillsStatusFilter, number>,
  shownCount: number,
) {
  const agents = listSelectableAgents(props.agentsList?.agents ?? []);
  const selectedAgentId = agents.some((agent) => agent.id === props.selectedAgentId)
    ? (props.selectedAgentId ?? "")
    : agents.some((agent) => agent.id === props.agentsList?.defaultId)
      ? (props.agentsList?.defaultId ?? "")
      : (agents[0]?.id ?? "");
  return html`
    <div class="plugins-toolbar plugins-toolbar--fields">
      ${renderSettingsSegmented<SkillsStatusFilter>({
        value: props.statusFilter,
        ariaLabel: t("skillsPage.title"),
        options: STATUS_TABS.map((tab) => ({
          value: tab.id,
          label: html`${t(tab.labelKey)}
            <span class="settings-count">${statusCounts[tab.id]}</span>`,
        })),
        onChange: (value) => props.onStatusFilterChange(value),
      })}
      ${agents.length > 0
        ? html`
            <label class="plugins-field skills-toolbar__agent">
              <span>${t("usage.filters.agent")}</span>
              <select
                name="skills-agent"
                class="settings-select"
                .value=${selectedAgentId}
                ?disabled=${skillControlsLocked(props) || !props.connected || agents.length < 2}
                @change=${(e: Event) => props.onAgentChange((e.target as HTMLSelectElement).value)}
              >
                ${agents.map(
                  (agent) => html`
                    <option value=${agent.id} ?selected=${agent.id === selectedAgentId}>
                      ${agentOptionLabel(agent, props.agentsList?.defaultId)}
                    </option>
                  `,
                )}
              </select>
            </label>
          `
        : nothing}
      <label class="plugins-field skills-toolbar__search">
        <span>${t("common.search")}</span>
        <input
          class="settings-input"
          .value=${props.filter}
          @input=${(e: Event) => props.onFilterChange((e.target as HTMLInputElement).value)}
          placeholder=${t("skillsPage.filterPlaceholder")}
          autocomplete="off"
          name="skills-filter"
        />
      </label>
      <span class="plugins-toolbar__hint">
        ${t("skillsPage.shown", { count: String(shownCount) })}
      </span>
      <button
        type="button"
        class="btn"
        ?disabled=${skillControlsLocked(props) || !props.connected}
        @click=${props.onRefresh}
      >
        ${props.loading ? t("common.loading") : t("common.refresh")}
      </button>
    </div>
  `;
}

function renderClawHubSection(props: SkillsProps) {
  return renderSettingsSection(
    {
      title: t("skillsPage.clawHub"),
      description: t("skillsPage.clawHubSubtitle"),
    },
    html`
      <div class="settings-row">
        <input
          class="settings-input plugins-row-input"
          .value=${props.clawhubQuery}
          @input=${(e: Event) => props.onClawHubQueryChange((e.target as HTMLInputElement).value)}
          placeholder=${t("skillsPage.searchClawHub")}
          autocomplete="off"
          name="clawhub-search"
        />
        ${props.clawhubSearchLoading
          ? html`<span class="plugins-toolbar__hint">${t("skillsPage.searching")}</span>`
          : nothing}
      </div>
      ${props.clawhubSearchError
        ? html`<div class="callout danger plugins-group-message">${props.clawhubSearchError}</div>`
        : nothing}
      ${props.clawhubInstallMessage
        ? html`<div
            class="callout ${props.clawhubInstallMessage.kind === "error"
              ? "danger"
              : "success"} plugins-group-message"
          >
            <div
              style="max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;"
            >
              ${props.clawhubInstallMessage.text}
            </div>
            ${props.clawhubInstallMessage.acknowledgeSlug
              ? html`<button
                  type="button"
                  class="btn btn--sm"
                  style="margin-top: 10px; white-space: normal;"
                  ?disabled=${skillControlsLocked(props)}
                  @click=${() =>
                    props.onClawHubInstall(
                      props.clawhubInstallMessage?.acknowledgeSlug ?? "",
                      true,
                      props.clawhubInstallMessage?.acknowledgeVersion,
                    )}
                >
                  ${props.clawhubInstallMessage.acknowledgeLabel ?? t("skillsPage.acknowledgeRisk")}
                </button>`
              : nothing}
          </div>`
        : nothing}
      ${renderClawHubResults(props)}
    `,
  );
}

function renderClawHubResults(props: SkillsProps) {
  const results = props.clawhubResults;
  if (!results) {
    return nothing;
  }
  if (results.length === 0) {
    return renderSettingsEmpty(t("skillsPage.noClawHubResults"));
  }
  return html`
    ${results.map(
      (r) => html`
        <div class="settings-row plugins-item plugins-item--clickable">
          <button
            type="button"
            class="settings-row__text plugins-item__detail-button"
            aria-label=${t("skillsPage.openDetails", { name: r.displayName })}
            @click=${() => props.onClawHubDetailOpen(r.slug)}
          >
            <span class="settings-row__title">${r.displayName}</span>
            <span class="settings-row__desc">
              ${r.summary ? clampText(r.summary, 120) : r.slug}
            </span>
          </button>
          <div class="settings-row__control">
            ${r.version ? renderSettingsValue(`v${r.version}`) : nothing}
            <button
              class="btn btn--sm"
              ?disabled=${skillControlsLocked(props)}
              @click=${() => props.onClawHubInstall(r.slug)}
            >
              ${activeClawHubMutation(props, r.slug)
                ? t("skillsPage.installing")
                : t("skillsPage.install")}
            </button>
          </div>
        </div>
      `,
    )}
  `;
}

function renderClawHubDetailDialog(props: SkillsProps) {
  const detail = props.clawhubDetail;

  return html`
    <openclaw-modal-dialog
      label=${detail?.skill?.displayName ?? props.clawhubDetailSlug ?? t("skillsPage.notFound")}
      style="--openclaw-modal-width: min(1040px, calc(100vw - 32px));"
      @modal-cancel=${props.onClawHubDetailClose}
    >
      <div class="md-preview-dialog__panel">
        <div class="md-preview-dialog__header">
          <div class="md-preview-dialog__title">
            ${detail?.skill?.displayName ?? props.clawhubDetailSlug}
          </div>
          <button class="btn btn--sm" @click=${props.onClawHubDetailClose}>
            ${t("skillsPage.close")}
          </button>
        </div>
        <div class="md-preview-dialog__body" style="display: grid; gap: 16px;">
          ${props.clawhubDetailLoading
            ? html`<div class="muted">${t("common.loading")}</div>`
            : props.clawhubDetailError
              ? html`<div class="callout danger">${props.clawhubDetailError}</div>`
              : detail?.skill
                ? html`
                    <div style="font-size: 14px; line-height: 1.5;">
                      ${detail.skill.summary ?? ""}
                    </div>
                    ${detail.owner?.displayName
                      ? html`<div class="muted" style="font-size: 13px;">
                          ${t("skillsPage.by")}
                          ${detail.owner.displayName}${detail.owner.handle
                            ? html` (@${detail.owner.handle})`
                            : nothing}
                        </div>`
                      : nothing}
                    ${detail.latestVersion
                      ? html`<div class="muted" style="font-size: 13px;">
                          ${t("skillsPage.latest", { version: detail.latestVersion.version })}
                        </div>`
                      : nothing}
                    ${detail.latestVersion?.changelog
                      ? html`<div
                          style="font-size: 13px; border-top: 1px solid var(--border); padding-top: 12px; white-space: pre-wrap;"
                        >
                          ${detail.latestVersion.changelog}
                        </div>`
                      : nothing}
                    ${detail.metadata?.os
                      ? html`<div class="muted" style="font-size: 12px;">
                          ${t("skillsPage.platforms", { platforms: detail.metadata.os.join(", ") })}
                        </div>`
                      : nothing}
                    <button
                      class="btn primary"
                      ?disabled=${skillControlsLocked(props)}
                      @click=${() => {
                        if (props.clawhubDetailSlug) {
                          props.onClawHubInstall(props.clawhubDetailSlug);
                        }
                      }}
                    >
                      ${activeClawHubMutation(props, props.clawhubDetailSlug ?? "")
                        ? t("skillsPage.installing")
                        : t("skillsPage.installNamed", { name: detail.skill.displayName })}
                    </button>
                  `
                : html`<div class="muted">${t("skillsPage.notFound")}</div>`}
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}

function renderSkill(skill: SkillStatusEntry, props: SkillsProps) {
  const locked = skillControlsLocked(props);
  const verdict = verdictForSkill(skill, props.clawhubVerdicts);

  return html`
    <div class="settings-row plugins-item plugins-item--clickable">
      <button
        type="button"
        class="settings-row__text plugins-item__detail-button"
        aria-label=${t("skillsPage.openDetails", { name: skill.name })}
        @click=${() => props.onDetailOpen(skill.skillKey)}
      >
        <span class="settings-row__title">
          ${skill.emoji ? html`<span>${skill.emoji}</span> ` : nothing}${skill.name}
        </span>
        <span class="settings-row__desc">${clampText(skill.description, 140)}</span>
      </button>
      <div class="settings-row__control">
        ${skillAvailabilityStatus(skill)}
        ${skill.clawhub?.status === "linked"
          ? renderSettingsStatus({ kind: verdictStatusKind(verdict), label: verdictLabel(verdict) })
          : skill.clawhub?.status === "invalid"
            ? renderSettingsStatus({ kind: "warn", label: t("skillsPage.invalidLink") })
            : nothing}
        ${renderSettingsToggle({
          checked: !skill.disabled,
          disabled: locked,
          ariaLabel: t("skillsPage.enabledNamed", { name: skill.name }),
          onChange: () => props.onToggle(skill.skillKey, skill.disabled),
        })}
      </div>
    </div>
  `;
}

function renderSkillDetail(skill: SkillStatusEntry, props: SkillsProps) {
  const locked = skillControlsLocked(props);
  const active = activeSkillMutation(props, skill.skillKey);
  const editValue = props.edits[skill.skillKey] ?? "";
  const message = props.messages[skill.skillKey] ?? null;
  const installOption = skill.install[0];
  const canInstall = installOption !== undefined && skill.missing.bins.length > 0;
  const showBundledBadge = Boolean(skill.bundled && skill.source !== "openclaw-bundled");
  const missing = computeSkillMissing(skill);
  const reasons = computeSkillReasons(skill);
  const verdict = verdictForSkill(skill, props.clawhubVerdicts);
  const detailTab: SkillDetailTab =
    props.detailTab === "card" && skill.skillCard?.present ? "card" : "overview";

  return html`
    <openclaw-modal-dialog
      label=${skill.name}
      style="--openclaw-modal-width: min(1040px, calc(100vw - 32px));"
      @modal-cancel=${props.onDetailClose}
    >
      <div class="md-preview-dialog__panel">
        <div class="md-preview-dialog__header">
          <div
            class="md-preview-dialog__title"
            style="display: flex; align-items: center; gap: 8px;"
          >
            <span class="statusDot ${skillStatusClass(skill)}"></span>
            ${skill.emoji ? html`<span style="font-size: 18px;">${skill.emoji}</span>` : nothing}
            <span>${skill.name}</span>
          </div>
          <button class="btn btn--sm" @click=${props.onDetailClose}>
            ${t("skillsPage.close")}
          </button>
        </div>
        <div class="md-preview-dialog__body" style="display: grid; gap: 16px;">
          <div>
            <div style="font-size: 14px; line-height: 1.5; color: var(--text);">
              ${skill.description}
            </div>
            ${renderSkillStatusChips({ skill, showBundledBadge })}
          </div>

          ${skill.clawhub || skill.skillCard?.present
            ? html`
                <div class="agent-tabs">
                  <button
                    class="agent-tab ${detailTab === "overview" ? "active" : ""}"
                    @click=${() => props.onDetailTabChange("overview")}
                  >
                    ${t("skillsPage.overview")}
                  </button>
                  ${skill.skillCard?.present
                    ? html`<button
                        class="agent-tab ${detailTab === "card" ? "active" : ""}"
                        @click=${() => props.onDetailTabChange("card")}
                      >
                        ${t("skillsPage.skillCard")}
                      </button>`
                    : nothing}
                </div>
              `
            : nothing}
          ${detailTab === "overview"
            ? renderInstalledClawHubOverview(skill, props, verdict)
            : renderInstalledSkillCard(skill, props)}
          ${missing.length > 0
            ? html`
                <div
                  class="callout"
                  style="border-color: var(--warn-subtle); background: var(--warn-subtle); color: var(--warn);"
                >
                  <div style="font-weight: 600; margin-bottom: 4px;">
                    ${t("skillsPage.missingRequirements")}
                  </div>
                  <div>${missing.join(", ")}</div>
                </div>
              `
            : nothing}
          ${reasons.length > 0
            ? html`
                <div class="muted" style="font-size: 13px;">
                  ${t("skillsPage.reason", { reasons: reasons.join(", ") })}
                </div>
              `
            : nothing}

          <div style="display: flex; align-items: center; gap: 12px;">
            ${renderSettingsToggle({
              checked: !skill.disabled,
              disabled: locked,
              ariaLabel: skill.name,
              onChange: () => props.onToggle(skill.skillKey, skill.disabled),
            })}
            <span style="font-size: 13px; font-weight: 500;">
              ${skill.disabled ? t("skillsPage.disabled") : t("skillsPage.enabled")}
            </span>
            ${canInstall
              ? html`<button
                  class="btn"
                  ?disabled=${locked}
                  @click=${() =>
                    installOption && props.onInstall(skill.skillKey, skill.name, installOption.id)}
                >
                  ${active ? t("skillsPage.installing") : installOption?.label}
                </button>`
              : nothing}
          </div>

          ${message
            ? html`<div class="callout ${message.kind === "error" ? "danger" : "success"}">
                ${message.message}
              </div>`
            : nothing}
          ${skill.primaryEnv
            ? html`
                <div style="display: grid; gap: 8px;">
                  <div class="field">
                    <span
                      >${t("skillsPage.apiKey")}
                      <span class="muted" style="font-weight: normal; font-size: 0.88em;"
                        >(${skill.primaryEnv})</span
                      ></span
                    >
                    <input
                      type="password"
                      ?disabled=${locked}
                      .value=${editValue}
                      @input=${(e: Event) =>
                        props.onEdit(skill.skillKey, (e.target as HTMLInputElement).value)}
                    />
                  </div>
                  ${(() => {
                    const href = safeExternalHref(skill.homepage);
                    return href
                      ? html`<div class="muted" style="font-size: 13px;">
                          ${t("skillsPage.getKey")}
                          <a href="${href}" target="_blank" rel="noopener noreferrer"
                            >${skill.homepage}</a
                          >
                        </div>`
                      : nothing;
                  })()}
                  <button
                    class="btn primary"
                    ?disabled=${locked}
                    @click=${() => props.onSaveKey(skill.skillKey)}
                  >
                    ${t("skillsPage.saveKey")}
                  </button>
                </div>
              `
            : nothing}

          <div
            style="border-top: 1px solid var(--border); padding-top: 12px; display: grid; gap: 6px; font-size: 12px; color: var(--muted);"
          >
            <div>
              <span style="font-weight: 600;">${t("skillsPage.source")}</span> ${skill.source}
            </div>
            <div style="font-family: var(--mono); word-break: break-all;">${skill.filePath}</div>
            ${(() => {
              const safeHref = safeExternalHref(skill.homepage);
              return safeHref
                ? html`<div>
                    <a href="${safeHref}" target="_blank" rel="noopener noreferrer"
                      >${skill.homepage}</a
                    >
                  </div>`
                : nothing;
            })()}
          </div>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}

function renderInstalledClawHubOverview(
  skill: SkillStatusEntry,
  props: SkillsProps,
  verdict: ClawHubSkillSecurityVerdict | null,
) {
  const link = skill.clawhub;
  if (!link) {
    return nothing;
  }
  if (link.status === "invalid") {
    return html`<div class="callout danger">
      <div style="font-weight: 600; margin-bottom: 4px;">${t("skillsPage.invalidLink")}</div>
      <div>${link.reason}</div>
    </div>`;
  }
  const auditHref = safeExternalHref(verdict?.securityAuditUrl ?? undefined);
  const reasonText = verdict?.reasons?.length ? verdict.reasons.join(", ") : null;
  return html`
    <div
      class="callout"
      style="display: grid; gap: 8px; border-color: var(--border); background: var(--panel-2);"
    >
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
        <span class="chip ${verdictChipClass(verdict)}">${verdictLabel(verdict)}</span>
        <span class="muted" style="font-size: 12px;">${link.slug}@${link.installedVersion}</span>
        ${props.clawhubVerdictsLoading
          ? html`<span class="muted">${t("skillsPage.refreshing")}</span>`
          : nothing}
      </div>
      ${props.clawhubVerdictsError
        ? html`<div class="muted" style="font-size: 13px;">${props.clawhubVerdictsError}</div>`
        : reasonText
          ? html`<div class="muted" style="font-size: 13px;">${reasonText}</div>`
          : nothing}
      ${auditHref
        ? html`<div style="font-size: 13px;">
            <a href="${auditHref}" target="_blank" rel="noopener noreferrer"
              >${t("skillsPage.fullSecurityReport")}</a
            >
          </div>`
        : nothing}
    </div>
  `;
}

function renderInstalledSkillCard(skill: SkillStatusEntry, props: SkillsProps) {
  const card = skill.skillCard;
  if (!card?.present) {
    return nothing;
  }
  const content = props.skillCardContents[skill.skillKey];
  if (content === undefined) {
    const error = props.skillCardErrors[skill.skillKey];
    if (error) {
      return html`<div class="callout danger">${error}</div>`;
    }
    return html`<div class="muted" style="font-size: 13px;">
      ${props.skillCardLoadingKey === skill.skillKey
        ? t("skillsPage.loadingSkillCard")
        : t("skillsPage.skillCardNotLoaded")}
    </div>`;
  }
  return html`
    <article class="sidebar-markdown" style="max-width: 100%; overflow-wrap: anywhere;">
      ${unsafeHTML(toSanitizedMarkdownHtml(content))}
    </article>
  `;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
