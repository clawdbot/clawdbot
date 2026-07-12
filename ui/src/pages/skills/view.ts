// Control UI page renders skills screen content.
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { AgentsListResult, SkillStatusEntry, SkillStatusReport } from "../../api/types.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { t } from "../../i18n/index.ts";
import { clampText } from "../../lib/format.ts";
import { resolveSafeExternalUrl } from "../../lib/open-external-url.ts";
import { groupSkills } from "../../lib/skills-grouping.ts";
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

function showDialogWhenClosed(el?: Element) {
  if (!(el instanceof HTMLDialogElement) || el.open) {
    return;
  }
  if (el.isConnected) {
    el.showModal();
  } else {
    queueMicrotask(() => {
      if (el.isConnected && !el.open) {
        el.showModal();
      }
    });
  }
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
  const agents = props.agentsList?.agents ?? [];
  const selectedAgentId =
    props.selectedAgentId ?? props.agentsList?.defaultId ?? agents[0]?.id ?? "";

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
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${t("skillsPage.title")}</div>
          <div class="card-sub">${t("skillsPage.subtitle")}</div>
        </div>
        <button
          class="btn"
          ?disabled=${skillControlsLocked(props) || !props.connected}
          @click=${props.onRefresh}
        >
          ${props.loading ? t("common.loading") : t("common.refresh")}
        </button>
      </div>

      <div class="agent-tabs" style="margin-top: 14px;">
        ${STATUS_TABS.map(
          (tab) => html`
            <button
              class="agent-tab ${props.statusFilter === tab.id ? "active" : ""}"
              @click=${() => props.onStatusFilterChange(tab.id)}
            >
              ${t(tab.labelKey)}<span class="agent-tab-count">${statusCounts[tab.id]}</span>
            </button>
          `,
        )}
      </div>

      <div
        class="filters"
        style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 12px;"
      >
        ${agents.length > 0
          ? html`
              <label class="field" style="min-width: 180px;">
                <span>${t("usage.filters.agent")}</span>
                <select
                  name="skills-agent"
                  .value=${selectedAgentId}
                  ?disabled=${skillControlsLocked(props) || !props.connected || agents.length < 2}
                  @change=${(e: Event) =>
                    props.onAgentChange((e.target as HTMLSelectElement).value)}
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
        <label class="field" style="flex: 1; min-width: 180px;">
          <span>${t("common.search")}</span>
          <input
            .value=${props.filter}
            @input=${(e: Event) => props.onFilterChange((e.target as HTMLInputElement).value)}
            placeholder=${t("skillsPage.filterPlaceholder")}
            autocomplete="off"
            name="skills-filter"
          />
        </label>
        <div class="muted">${t("skillsPage.shown", { count: String(filtered.length) })}</div>
      </div>

      <div style="margin-top: 16px; border-top: 1px solid var(--border); padding-top: 16px;">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
          <div style="font-weight: 600;">${t("skillsPage.clawHub")}</div>
          <div class="muted" style="font-size: 13px;">${t("skillsPage.clawHubSubtitle")}</div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
          <label class="field" style="flex: 1; min-width: 180px;">
            <input
              .value=${props.clawhubQuery}
              @input=${(e: Event) =>
                props.onClawHubQueryChange((e.target as HTMLInputElement).value)}
              placeholder=${t("skillsPage.searchClawHub")}
              autocomplete="off"
              name="clawhub-search"
            />
          </label>
          ${props.clawhubSearchLoading
            ? html`<span class="muted">${t("skillsPage.searching")}</span>`
            : nothing}
        </div>
        ${props.clawhubSearchError
          ? html`<div class="callout danger" style="margin-top: 8px;">
              ${props.clawhubSearchError}
            </div>`
          : nothing}
        ${props.clawhubInstallMessage
          ? html`<div
              class="callout ${props.clawhubInstallMessage.kind === "error" ? "danger" : "success"}"
              style="margin-top: 8px;"
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
                    ${props.clawhubInstallMessage.acknowledgeLabel ??
                    t("skillsPage.acknowledgeRisk")}
                  </button>`
                : nothing}
            </div>`
          : nothing}
        ${renderClawHubResults(props)}
      </div>

      ${props.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
        : nothing}
      ${filtered.length === 0
        ? html`
            <div class="muted" style="margin-top: 16px">
              ${!props.connected && !props.report
                ? t("skillsPage.disconnected")
                : t("skillsPage.empty")}
            </div>
          `
        : html`
            <div class="agent-skills-groups" style="margin-top: 16px;">
              ${groups.map((group) => {
                return html`
                  <details class="agent-skills-group" open>
                    <summary class="agent-skills-header">
                      <span>${group.label}</span>
                      <span class="muted">${group.skills.length}</span>
                    </summary>
                    <div class="list skills-grid">
                      ${repeat(
                        group.skills,
                        (skill) => skill.skillKey,
                        (skill) => renderSkill(skill, props),
                      )}
                    </div>
                  </details>
                `;
              })}
            </div>
          `}
    </section>

    ${detailSkill ? renderSkillDetail(detailSkill, props) : nothing}
    ${props.clawhubDetailSlug ? renderClawHubDetailDialog(props) : nothing}
  `;
}

function renderClawHubResults(props: SkillsProps) {
  const results = props.clawhubResults;
  if (!results) {
    return nothing;
  }
  if (results.length === 0) {
    return html`<div class="muted" style="margin-top: 8px;">
      ${t("skillsPage.noClawHubResults")}
    </div>`;
  }
  return html`
    <div class="list" style="margin-top: 8px;">
      ${results.map(
        (r) => html`
          <div
            class="list-item list-item-clickable"
            @click=${() => props.onClawHubDetailOpen(r.slug)}
          >
            <div class="list-main">
              <div class="list-title">${r.displayName}</div>
              <div class="list-sub">${r.summary ? clampText(r.summary, 120) : r.slug}</div>
            </div>
            <div class="list-meta" style="display: flex; align-items: center; gap: 8px;">
              ${r.version
                ? html`<span class="muted" style="font-size: 12px;">v${r.version}</span>`
                : nothing}
              <button
                class="btn btn--sm"
                ?disabled=${skillControlsLocked(props)}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  props.onClawHubInstall(r.slug);
                }}
              >
                ${activeClawHubMutation(props, r.slug)
                  ? t("skillsPage.installing")
                  : t("skillsPage.install")}
              </button>
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

function renderClawHubDetailDialog(props: SkillsProps) {
  const detail = props.clawhubDetail;

  return html`
    <dialog
      class="md-preview-dialog"
      ${ref(showDialogWhenClosed)}
      @click=${(e: Event) => {
        const dialog = e.currentTarget as HTMLDialogElement;
        if (e.target === dialog) {
          dialog.close();
        }
      }}
      @close=${props.onClawHubDetailClose}
    >
      <div class="md-preview-dialog__panel">
        <div class="md-preview-dialog__header">
          <div class="md-preview-dialog__title">
            ${detail?.skill?.displayName ?? props.clawhubDetailSlug}
          </div>
          <button
            class="btn btn--sm"
            @click=${(e: Event) => {
              (e.currentTarget as HTMLElement).closest("dialog")?.close();
            }}
          >
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
    </dialog>
  `;
}

function renderSkill(skill: SkillStatusEntry, props: SkillsProps) {
  const locked = skillControlsLocked(props);
  const dotClass = skillStatusClass(skill);
  const verdict = verdictForSkill(skill, props.clawhubVerdicts);

  return html`
    <div class="list-item list-item-clickable" @click=${() => props.onDetailOpen(skill.skillKey)}>
      <div class="list-main">
        <div class="list-title" style="display: flex; align-items: center; gap: 8px;">
          <span class="statusDot ${dotClass}"></span>
          ${skill.emoji ? html`<span>${skill.emoji}</span>` : nothing}
          <span>${skill.name}</span>
        </div>
        <div class="list-sub">${clampText(skill.description, 140)}</div>
      </div>
      <div
        class="list-meta"
        style="display: flex; align-items: center; justify-content: flex-end; gap: 10px;"
      >
        ${skill.clawhub?.status === "linked"
          ? html`<span class="chip ${verdictChipClass(verdict)}">${verdictLabel(verdict)}</span>`
          : skill.clawhub?.status === "invalid"
            ? html`<span class="chip chip-warn">${t("skillsPage.invalidLink")}</span>`
            : nothing}
        <label class="skill-toggle-wrap" @click=${(e: Event) => e.stopPropagation()}>
          <input
            type="checkbox"
            class="skill-toggle"
            .checked=${!skill.disabled}
            ?disabled=${locked}
            @change=${(e: Event) => {
              e.stopPropagation();
              props.onToggle(skill.skillKey, skill.disabled);
            }}
          />
        </label>
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
    <dialog
      class="md-preview-dialog"
      ${ref(showDialogWhenClosed)}
      @click=${(e: Event) => {
        const dialog = e.currentTarget as HTMLDialogElement;
        if (e.target === dialog) {
          dialog.close();
        }
      }}
      @close=${props.onDetailClose}
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
          <button
            class="btn btn--sm"
            @click=${(e: Event) => {
              (e.currentTarget as HTMLElement).closest("dialog")?.close();
            }}
          >
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
            <label class="skill-toggle-wrap">
              <input
                type="checkbox"
                class="skill-toggle"
                .checked=${!skill.disabled}
                ?disabled=${locked}
                @change=${() => props.onToggle(skill.skillKey, skill.disabled)}
              />
            </label>
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
    </dialog>
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
