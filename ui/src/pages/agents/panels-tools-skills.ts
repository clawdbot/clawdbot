// Control UI view renders agents panels tools skills screen content.
import { html, nothing } from "lit";
import { normalizeToolName } from "../../../../src/agents/tool-policy-shared.js";
import type {
  SkillStatusEntry,
  SkillStatusReport,
  ToolsCatalogResult,
  ToolsEffectiveEntry,
  ToolsEffectiveResult,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import {
  type AgentToolEntry,
  type AgentToolSection,
  isAllowedByPolicy,
  matchesList,
  resolveAgentConfig,
  resolveToolProfileOptions,
  resolveToolProfile,
  resolveToolSections,
} from "../../lib/agents/display.ts";
import type { SkillGroup } from "../../lib/skills-grouping.ts";
import { groupSkills } from "../../lib/skills-grouping.ts";
import {
  computeSkillMissing,
  computeSkillReasons,
  renderSkillStatusChips,
} from "../../lib/skills-shared.ts";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeStringEntries,
} from "../../lib/string-coerce.ts";

function renderToolMetaBadges(labels: string[]) {
  if (labels.length === 0) {
    return nothing;
  }
  return html`
    <div class="agent-tool-badges">
      ${labels.map((label) => html`<span class="agent-pill">${label}</span>`)}
    </div>
  `;
}

function buildCatalogBadgeLabels(section: AgentToolSection, tool: AgentToolEntry): string[] {
  const source = tool.source ?? section.source;
  const pluginId = tool.pluginId ?? section.pluginId;
  const badges: string[] = [];
  if (source === "plugin" && pluginId) {
    badges.push(t("agentTools.plugin", { id: pluginId }));
  } else if (source === "core") {
    badges.push(t("agentTools.builtIn"));
  }
  if (tool.optional) {
    badges.push(t("agentTools.optional"));
  }
  return badges;
}

function buildRowStatusBadges(params: {
  section: AgentToolSection;
  tool: AgentToolEntry;
  activeEntry: ToolsEffectiveEntry | null;
}) {
  const badges = buildCatalogBadgeLabels(params.section, params.tool);
  if (params.activeEntry) {
    badges.unshift(t("agentTools.liveNow"));
  }
  return badges;
}

function formatToolPolicyState(params: {
  allowed: boolean;
  baseAllowed: boolean;
  denied: boolean;
}) {
  if (params.denied) {
    return t("agentTools.disabledByOverride");
  }
  if (params.allowed && params.baseAllowed) {
    return t("agentTools.enabledByProfile");
  }
  if (params.allowed) {
    return t("agentTools.enabledByOverride");
  }
  return t("agentTools.notIncluded");
}

function formatToolSourceLabel(section: AgentToolSection, tool: AgentToolEntry) {
  const source = tool.source ?? section.source;
  const pluginId = tool.pluginId ?? section.pluginId;
  if (source === "plugin" && pluginId) {
    return t("agentTools.plugin", { id: pluginId });
  }
  return t("agentTools.builtIn");
}

function formatToolAccessSummary(params: {
  allowed: boolean;
  baseAllowed: boolean;
  denied: boolean;
}) {
  if (params.denied) {
    return t("agentTools.overrideOff");
  }
  if (params.allowed && params.baseAllowed) {
    return t("agentTools.enabled");
  }
  if (params.allowed) {
    return t("agentTools.overrideOn");
  }
  return t("agentTools.profileOff");
}

function formatToolRuntimeSummary(params: {
  activeEntry: ToolsEffectiveEntry | null;
  runtimeSessionMatchesSelectedAgent: boolean;
}) {
  if (params.activeEntry) {
    return t("agentTools.liveNow");
  }
  if (params.runtimeSessionMatchesSelectedAgent) {
    return t("agentTools.notLive");
  }
  return t("agentTools.otherAgent");
}

function toToolAnchorId(toolId: string) {
  const safe = normalizeToolName(toolId).replace(/[^a-z0-9_-]+/g, "-");
  return `agent-tool-${safe}`;
}

function flattenEffectiveTools(groups: ToolsEffectiveResult["groups"] | null | undefined) {
  return (groups ?? []).flatMap((group) => group.tools);
}

const MAX_RUNTIME_TOOL_CHIPS = 12;

function handleToolGroupToggle(event: Event) {
  const group = event.currentTarget;
  if (!(group instanceof HTMLDetailsElement) || group.open) {
    return;
  }
  for (const tool of group.querySelectorAll<HTMLDetailsElement>(".agent-tool-card[open]")) {
    tool.open = false;
  }
}

function handleRuntimeToolJump(event: Event, anchorId: string) {
  const target = document.getElementById(anchorId);
  if (!(target instanceof HTMLDetailsElement)) {
    return;
  }

  event.preventDefault();
  const parentGroup = target.closest<HTMLDetailsElement>(".agent-tools-group");
  if (parentGroup) {
    parentGroup.open = true;
  }
  target.open = true;

  const nextUrl = new URL(window.location.href);
  nextUrl.hash = anchorId;
  window.history.replaceState(null, "", nextUrl);

  requestAnimationFrame(() => {
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView?.({
      block: "center",
      behavior: reducedMotion ? "auto" : "smooth",
    });
    target.querySelector<HTMLElement>("summary")?.focus();
  });
}

function renderEffectiveToolNotices(result: ToolsEffectiveResult | null) {
  const notices = result?.notices ?? [];
  if (notices.length === 0) {
    return nothing;
  }
  return html`
    <div class="agent-tools-notices">
      ${notices.map(
        (notice) => html`
          <div
            class="callout ${notice.severity === "warning" ? "warning" : "info"}"
            style="margin-top: 12px"
          >
            ${notice.message}
          </div>
        `,
      )}
    </div>
  `;
}

function renderEffectiveToolBadge(tool: {
  source: "core" | "plugin" | "channel" | "mcp";
  pluginId?: string;
  channelId?: string;
}) {
  if (tool.source === "plugin") {
    return tool.pluginId
      ? t("agentTools.connectedSource", { id: tool.pluginId })
      : t("agentTools.connected");
  }
  if (tool.source === "channel") {
    return tool.channelId
      ? t("agentTools.channelSource", { id: tool.channelId })
      : t("agentTools.channel");
  }
  if (tool.source === "mcp") {
    return "MCP";
  }
  return t("agentTools.builtIn");
}

export function renderAgentTools(params: {
  agentId: string;
  configForm: Record<string, unknown> | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  toolsCatalogLoading: boolean;
  toolsCatalogError: string | null;
  toolsCatalogResult: ToolsCatalogResult | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveError: string | null;
  toolsEffectiveResult: ToolsEffectiveResult | null;
  runtimeSessionKey: string;
  runtimeSessionMatchesSelectedAgent: boolean;
  onProfileChange: (agentId: string, profile: string | null, clearAllow: boolean) => void;
  onOverridesChange: (agentId: string, alsoAllow: string[], deny: string[]) => void;
  onConfigReload: () => void;
  onConfigSave: () => void;
}) {
  const config = resolveAgentConfig(params.configForm, params.agentId);
  const agentTools = config.entry?.tools ?? {};
  const globalTools = config.globalTools ?? {};
  const profile = agentTools.profile ?? globalTools.profile ?? "full";
  const profileOptions = resolveToolProfileOptions(params.toolsCatalogResult);
  const toolSections = resolveToolSections(params.toolsCatalogResult);
  const profileSource = agentTools.profile
    ? t("agentTools.profileSourceAgent")
    : globalTools.profile
      ? t("agentTools.profileSourceGlobal")
      : t("agentTools.profileSourceDefault");
  const hasAgentAllow = Array.isArray(agentTools.allow) && agentTools.allow.length > 0;
  const hasGlobalAllow = Array.isArray(globalTools.allow) && globalTools.allow.length > 0;
  const editable =
    Boolean(params.configForm) &&
    !params.configLoading &&
    !params.configSaving &&
    !hasAgentAllow &&
    !(params.toolsCatalogLoading && !params.toolsCatalogResult && !params.toolsCatalogError);
  const alsoAllow = hasAgentAllow
    ? []
    : Array.isArray(agentTools.alsoAllow)
      ? agentTools.alsoAllow
      : [];
  const deny = hasAgentAllow ? [] : Array.isArray(agentTools.deny) ? agentTools.deny : [];
  const basePolicy = hasAgentAllow
    ? { allow: agentTools.allow ?? [], deny: agentTools.deny ?? [] }
    : (resolveToolProfile(profile) ?? undefined);
  const toolIds = toolSections.flatMap((section) => section.tools.map((tool) => tool.id));

  const resolveAllowed = (toolId: string) => {
    const baseAllowed = isAllowedByPolicy(toolId, basePolicy);
    const extraAllowed = matchesList(toolId, alsoAllow);
    const denied = matchesList(toolId, deny);
    const allowed = (baseAllowed || extraAllowed) && !denied;
    return {
      allowed,
      baseAllowed,
      denied,
    };
  };
  const enabledCount = toolIds.filter((toolId) => resolveAllowed(toolId).allowed).length;
  const effectiveTools =
    params.runtimeSessionMatchesSelectedAgent && !params.toolsEffectiveError
      ? flattenEffectiveTools(params.toolsEffectiveResult?.groups)
      : [];
  const uniqueEffectiveTools = Array.from(
    new Map(effectiveTools.map((tool) => [normalizeToolName(tool.id), tool])).values(),
  );
  const visibleEffectiveTools = uniqueEffectiveTools.slice(0, MAX_RUNTIME_TOOL_CHIPS);
  const hiddenEffectiveToolCount = Math.max(
    0,
    uniqueEffectiveTools.length - visibleEffectiveTools.length,
  );
  const liveToolCount = uniqueEffectiveTools.length;
  const activeToolMap = new Map(
    effectiveTools.map((tool) => [normalizeToolName(tool.id), tool] as const),
  );
  const activeToolIds = new Set(activeToolMap.keys());

  const sortSectionTools = (tools: AgentToolEntry[]) =>
    tools.toSorted((left, right) => {
      const leftId = normalizeToolName(left.id);
      const rightId = normalizeToolName(right.id);
      const leftActive = activeToolIds.has(leftId) ? 1 : 0;
      const rightActive = activeToolIds.has(rightId) ? 1 : 0;
      if (leftActive !== rightActive) {
        return rightActive - leftActive;
      }
      const leftAllowed = resolveAllowed(left.id).allowed ? 1 : 0;
      const rightAllowed = resolveAllowed(right.id).allowed ? 1 : 0;
      if (leftAllowed !== rightAllowed) {
        return rightAllowed - leftAllowed;
      }
      return left.label.localeCompare(right.label);
    });

  const updateTool = (toolId: string, nextEnabled: boolean) => {
    const nextAllow = new Set(
      alsoAllow.map((entry) => normalizeToolName(entry)).filter((entry) => entry.length > 0),
    );
    const nextDeny = new Set(
      deny.map((entry) => normalizeToolName(entry)).filter((entry) => entry.length > 0),
    );
    const baseAllowed = resolveAllowed(toolId).baseAllowed;
    const normalized = normalizeToolName(toolId);
    if (nextEnabled) {
      nextDeny.delete(normalized);
      if (!baseAllowed) {
        nextAllow.add(normalized);
      }
    } else {
      nextAllow.delete(normalized);
      nextDeny.add(normalized);
    }
    params.onOverridesChange(params.agentId, [...nextAllow], [...nextDeny]);
  };

  const updateAll = (nextEnabled: boolean) => {
    const nextAllow = new Set(
      alsoAllow.map((entry) => normalizeToolName(entry)).filter((entry) => entry.length > 0),
    );
    const nextDeny = new Set(
      deny.map((entry) => normalizeToolName(entry)).filter((entry) => entry.length > 0),
    );
    for (const toolId of toolIds) {
      const baseAllowed = resolveAllowed(toolId).baseAllowed;
      const normalized = normalizeToolName(toolId);
      if (nextEnabled) {
        nextDeny.delete(normalized);
        if (!baseAllowed) {
          nextAllow.add(normalized);
        }
      } else {
        nextAllow.delete(normalized);
        nextDeny.add(normalized);
      }
    }
    params.onOverridesChange(params.agentId, [...nextAllow], [...nextDeny]);
  };

  return html`
    <section class="card">
      <div class="agent-tools-header">
        <div class="agent-tools-header__intro">
          <div class="card-title">${t("agentTools.title")}</div>
          <div class="card-sub">
            ${t("agentTools.subtitle")}
            <span class="mono"
              >${t("agentTools.enabledSummary", {
                enabled: String(enabledCount),
                total: String(toolIds.length),
              })}</span
            >
          </div>
        </div>
        <div class="agent-tools-header__actions">
          <button class="btn btn--sm" ?disabled=${!editable} @click=${() => updateAll(true)}>
            ${t("agentTools.enableAll")}
          </button>
          <button class="btn btn--sm" ?disabled=${!editable} @click=${() => updateAll(false)}>
            ${t("agentTools.disableAll")}
          </button>
          <button
            class="btn btn--sm"
            ?disabled=${params.configLoading}
            @click=${params.onConfigReload}
          >
            ${t("common.reloadConfig")}
          </button>
          <button
            class="btn btn--sm primary"
            ?disabled=${params.configSaving || !params.configDirty}
            @click=${params.onConfigSave}
          >
            ${params.configSaving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>

      ${!params.configForm
        ? html`
            <div class="callout info" style="margin-top: 12px">${t("agentTools.loadConfig")}</div>
          `
        : nothing}
      ${hasAgentAllow
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("agentTools.explicitAllowlist")}
            </div>
          `
        : nothing}
      ${hasGlobalAllow
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("agentTools.globalAllowlist")}
            </div>
          `
        : nothing}
      ${params.toolsCatalogLoading && !params.toolsCatalogResult && !params.toolsCatalogError
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("agentTools.loadingCatalog")}
            </div>
          `
        : nothing}
      ${params.toolsCatalogError
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("agentTools.catalogFallback")}
            </div>
          `
        : nothing}

      <div class="agent-tools-overview">
        <div class="agent-tools-overview__primary">
          <div class="agent-tools-pane">
            <div class="label">${t("agentTools.availableNow")}</div>
            <div class="card-sub">
              ${t("agentTools.availableNowSubtitle")}
              <span class="mono">${params.runtimeSessionKey || t("agentTools.noSession")}</span>
            </div>
            ${renderEffectiveToolNotices(params.toolsEffectiveResult)}
            ${!params.runtimeSessionMatchesSelectedAgent
              ? html`
                  <div class="callout info" style="margin-top: 12px">
                    ${t("agentTools.switchAgent")}
                  </div>
                `
              : params.toolsEffectiveLoading &&
                  !params.toolsEffectiveResult &&
                  !params.toolsEffectiveError
                ? html`
                    <div class="callout info" style="margin-top: 12px">
                      ${t("agentTools.loadingAvailable")}
                    </div>
                  `
                : params.toolsEffectiveError
                  ? html`
                      <div class="callout info" style="margin-top: 12px">
                        ${t("agentTools.availableError")}
                      </div>
                    `
                  : (params.toolsEffectiveResult?.groups?.length ?? 0) === 0
                    ? html`
                        <div class="callout info" style="margin-top: 12px">
                          ${t("agentTools.noAvailable")}
                        </div>
                      `
                    : html`
                        <div class="agent-tools-runtime">
                          ${visibleEffectiveTools.map((tool) => {
                            const anchorId = toToolAnchorId(tool.id);
                            return html`
                              <a
                                class="agent-tools-runtime-chip"
                                href="#${anchorId}"
                                @click=${(event: Event) => handleRuntimeToolJump(event, anchorId)}
                              >
                                <span class="mono" translate="no">${tool.label}</span>
                                <span class="agent-tools-runtime-chip__meta"
                                  >${renderEffectiveToolBadge(tool)}</span
                                >
                              </a>
                            `;
                          })}
                          ${hiddenEffectiveToolCount > 0
                            ? html`
                                <span
                                  class="agent-tools-runtime-chip agent-tools-runtime-chip--more"
                                  title=${t("agentTools.moreLiveTitle", {
                                    count: String(hiddenEffectiveToolCount),
                                  })}
                                >
                                  ${t("agentTools.moreLive", {
                                    count: String(hiddenEffectiveToolCount),
                                  })}
                                </span>
                              `
                            : nothing}
                        </div>
                      `}
          </div>

          <div class="agent-tools-pane">
            <div class="label">${t("agentTools.quickPresets")}</div>
            <div class="agent-tools-buttons">
              ${profileOptions.map(
                (option) => html`
                  <button
                    class="btn btn--sm ${profile === option.id ? "active" : ""}"
                    ?disabled=${!editable}
                    @click=${() => params.onProfileChange(params.agentId, option.id, true)}
                  >
                    ${option.label}
                  </button>
                `,
              )}
              <button
                class="btn btn--sm"
                ?disabled=${!editable}
                @click=${() => params.onProfileChange(params.agentId, null, false)}
              >
                ${t("agentTools.inherit")}
              </button>
            </div>
          </div>
        </div>

        <div class="agent-tools-facts">
          <div class="agent-tools-fact">
            <div class="label">${t("agentTools.profile")}</div>
            <div class="mono">${profile}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">${t("agentTools.source")}</div>
            <div>${profileSource}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">${t("agentTools.enabled")}</div>
            <div class="mono">${enabledCount}/${toolIds.length}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">${t("agentTools.live")}</div>
            <div class="mono">${liveToolCount}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">${t("agentTools.status")}</div>
            <div class="mono">
              ${params.configSaving
                ? t("agentTools.statusSaving")
                : params.configDirty
                  ? t("agentTools.statusUnsaved")
                  : t("agentTools.statusSaved")}
            </div>
          </div>
        </div>
      </div>

      <div class="agent-tools-grid">
        ${toolSections.map((section) => {
          const sortedTools = sortSectionTools(section.tools);
          const enabledSectionCount = section.tools.filter(
            (tool) => resolveAllowed(tool.id).allowed,
          ).length;
          const activeSectionCount = section.tools.filter((tool) =>
            activeToolIds.has(normalizeToolName(tool.id)),
          ).length;
          const previewTools = sortedTools.slice(0, 4);
          const remainingPreviewCount = Math.max(0, sortedTools.length - previewTools.length);
          return html`
            <details class="agent-tools-group" @toggle=${handleToolGroupToggle}>
              <summary class="agent-tools-group__summary">
                <span class="agent-tools-group__summary-main">
                  <span class="agent-tools-group__title">
                    ${section.label}
                    ${section.source === "plugin" && section.pluginId
                      ? html`<span class="agent-pill"
                          >${t("agentTools.plugin", { id: section.pluginId })}</span
                        >`
                      : nothing}
                  </span>
                  <span
                    class="agent-tools-group__preview"
                    aria-label=${t("agentTools.toolPreview")}
                  >
                    ${previewTools.map(
                      (tool) =>
                        html`<span class="mono" translate="no" title=${tool.label}
                          >${tool.label}</span
                        >`,
                    )}
                    ${remainingPreviewCount > 0
                      ? html`<span
                          >${t("agentTools.more", {
                            count: String(remainingPreviewCount),
                          })}</span
                        >`
                      : nothing}
                  </span>
                </span>
                <span class="agent-tools-group__counts">
                  <span
                    >${t(section.tools.length === 1 ? "agentTools.toolsOne" : "agentTools.tools", {
                      count: String(section.tools.length),
                    })}</span
                  >
                  <span
                    >${t(
                      enabledSectionCount === 1
                        ? "agentTools.enabledToolsOne"
                        : "agentTools.enabledTools",
                      { count: String(enabledSectionCount) },
                    )}</span
                  >
                  ${activeSectionCount > 0
                    ? html`<span
                        >${t(
                          activeSectionCount === 1
                            ? "agentTools.liveToolsOne"
                            : "agentTools.liveTools",
                          { count: String(activeSectionCount) },
                        )}</span
                      >`
                    : nothing}
                </span>
              </summary>
              <div class="agent-tools-list agent-tools-list--stacked">
                ${sortedTools.map((tool) => {
                  const anchorId = toToolAnchorId(tool.id);
                  const resolved = resolveAllowed(tool.id);
                  const activeEntry = activeToolMap.get(normalizeToolName(tool.id)) ?? null;
                  const defaultProfiles = tool.defaultProfiles ?? [];
                  const rowBadges = buildRowStatusBadges({
                    section,
                    tool,
                    activeEntry,
                  });
                  const accessSummary = formatToolAccessSummary(resolved);
                  const runtimeSummary = formatToolRuntimeSummary({
                    activeEntry,
                    runtimeSessionMatchesSelectedAgent: params.runtimeSessionMatchesSelectedAgent,
                  });
                  return html`
                    <details class="agent-tool-card" id=${anchorId}>
                      <summary class="agent-tool-summary">
                        <div class="agent-tool-summary__main">
                          <div class="agent-tool-summary__title-row">
                            <span class="agent-tool-title mono" translate="no">${tool.label}</span>
                          </div>
                          <div class="agent-tool-sub">${tool.description}</div>
                        </div>
                        <dl class="agent-tool-summary__facts">
                          <div class="agent-tool-summary__fact">
                            <dt class="label">${t("agentTools.access")}</dt>
                            <dd>${accessSummary}</dd>
                          </div>
                          <div class="agent-tool-summary__fact">
                            <dt class="label">${t("agentTools.session")}</dt>
                            <dd>${runtimeSummary}</dd>
                          </div>
                        </dl>
                        <div class="agent-tool-summary__badges">
                          ${renderToolMetaBadges(rowBadges)}
                        </div>
                        <label
                          class="cfg-toggle agent-tool-toggle"
                          @click=${(event: Event) => event.stopPropagation()}
                          @keydown=${(event: KeyboardEvent) => event.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            .checked=${resolved.allowed}
                            ?disabled=${!editable}
                            aria-label=${t(
                              resolved.allowed
                                ? "agentTools.disableNamed"
                                : "agentTools.enableNamed",
                              { name: tool.label },
                            )}
                            @change=${(e: Event) =>
                              updateTool(tool.id, (e.target as HTMLInputElement).checked)}
                          />
                          <span class="cfg-toggle__track"></span>
                        </label>
                      </summary>
                      <div class="agent-tool-details">
                        <div class="agent-tool-details-strip">
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">${t("agentTools.access")}</div>
                            <div>${formatToolPolicyState(resolved)}</div>
                          </div>
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">${t("agentTools.source")}</div>
                            <div>${formatToolSourceLabel(section, tool)}</div>
                          </div>
                          ${defaultProfiles.length > 0
                            ? html`
                                <div class="agent-tool-detail agent-tool-detail--inline">
                                  <div class="label">${t("agentTools.defaultPresets")}</div>
                                  <div class="agent-tool-badges">
                                    ${defaultProfiles.map(
                                      (profileId) =>
                                        html`<span class="agent-pill">${profileId}</span>`,
                                    )}
                                  </div>
                                </div>
                              `
                            : nothing}
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">${t("agentTools.session")}</div>
                            <div>
                              ${activeEntry
                                ? t("agentTools.availableVia", {
                                    source: renderEffectiveToolBadge(activeEntry),
                                  })
                                : params.runtimeSessionMatchesSelectedAgent
                                  ? t("agentTools.unavailableSession")
                                  : t("agentTools.inspectAgent")}
                            </div>
                          </div>
                          <a class="agent-tool-jump" href="#${anchorId}">
                            ${t("agentTools.linkTool")}
                          </a>
                        </div>
                      </div>
                    </details>
                  `;
                })}
              </div>
            </details>
          `;
        })}
      </div>
    </section>
  `;
}

export function renderAgentSkills(params: {
  agentId: string;
  report: SkillStatusReport | null;
  loading: boolean;
  error: string | null;
  activeAgentId: string | null;
  configForm: Record<string, unknown> | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  filter: string;
  onFilterChange: (next: string) => void;
  onRefresh: () => void;
  onToggle: (agentId: string, skillName: string, enabled: boolean) => void;
  onClear: (agentId: string) => void;
  onDisableAll: (agentId: string) => void;
  onConfigReload: () => void;
  onConfigSave: () => void;
}) {
  const editable = Boolean(params.configForm) && !params.configLoading && !params.configSaving;
  const config = resolveAgentConfig(params.configForm, params.agentId);
  const allowlist = Array.isArray(config.entry?.skills) ? config.entry?.skills : undefined;
  const allowSet = new Set(normalizeStringEntries(allowlist ?? []));
  const usingAllowlist = allowlist !== undefined;
  const reportReady = Boolean(params.report && params.activeAgentId === params.agentId);
  const rawSkills = reportReady ? (params.report?.skills ?? []) : [];
  const filter = normalizeLowercaseStringOrEmpty(params.filter);
  const filtered = filter
    ? rawSkills.filter((skill) =>
        normalizeLowercaseStringOrEmpty(
          [skill.name, skill.description, skill.source].join(" "),
        ).includes(filter),
      )
    : rawSkills;
  const groups = groupSkills(filtered);
  const enabledCount = usingAllowlist
    ? rawSkills.filter((skill) => allowSet.has(skill.name)).length
    : rawSkills.length;
  const totalCount = rawSkills.length;

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; flex-wrap: wrap;">
        <div style="min-width: 0;">
          <div class="card-title">${t("agents.skillsPanel.title")}</div>
          <div class="card-sub">
            ${t("agents.skillsPanel.subtitle")}
            ${totalCount > 0
              ? html`<span class="mono">${enabledCount}/${totalCount}</span>`
              : nothing}
          </div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap;">
          <div
            class="row"
            style="gap: 4px; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 2px;"
          >
            <button
              class="btn btn--sm"
              ?disabled=${!editable}
              @click=${() => params.onClear(params.agentId)}
            >
              ${t("agentTools.enableAll")}
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!editable}
              @click=${() => params.onDisableAll(params.agentId)}
            >
              ${t("agentTools.disableAll")}
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!editable || !usingAllowlist}
              @click=${() => params.onClear(params.agentId)}
            >
              ${t("common.reset")}
            </button>
          </div>
          <button
            class="btn btn--sm"
            ?disabled=${params.configLoading}
            @click=${params.onConfigReload}
          >
            ${t("common.reloadConfig")}
          </button>
          <button class="btn btn--sm" ?disabled=${params.loading} @click=${params.onRefresh}>
            ${params.loading ? t("common.loading") : t("common.refresh")}
          </button>
          <button
            class="btn btn--sm primary"
            ?disabled=${params.configSaving || !params.configDirty}
            @click=${params.onConfigSave}
          >
            ${params.configSaving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>

      ${!params.configForm
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("agents.skillsPanel.loadConfig")}
            </div>
          `
        : nothing}
      ${usingAllowlist
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("agents.skillsPanel.customAllowlist")}
            </div>
          `
        : html`
            <div class="callout info" style="margin-top: 12px">
              ${t("agents.skillsPanel.allEnabled")}
            </div>
          `}
      ${!reportReady && !params.loading
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("agents.skillsPanel.loadAgent")}
            </div>
          `
        : nothing}
      ${params.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${params.error}</div>`
        : nothing}

      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="flex: 1;">
          <span>${t("agents.skillsPanel.filter")}</span>
          <input
            .value=${params.filter}
            @input=${(e: Event) => params.onFilterChange((e.target as HTMLInputElement).value)}
            placeholder=${t("agents.skillsPanel.searchPlaceholder")}
            autocomplete="off"
            name="agent-skills-filter"
          />
        </label>
        <div class="muted">
          ${t("agents.skillsPanel.shown", { count: String(filtered.length) })}
        </div>
      </div>

      ${filtered.length === 0
        ? html` <div class="muted" style="margin-top: 16px">${t("agents.skillsPanel.empty")}</div> `
        : html`
            <div class="agent-skills-groups" style="margin-top: 16px;">
              ${groups.map((group) =>
                renderAgentSkillGroup(group, {
                  agentId: params.agentId,
                  allowSet,
                  usingAllowlist,
                  editable,
                  onToggle: params.onToggle,
                }),
              )}
            </div>
          `}
    </section>
  `;
}

function renderAgentSkillGroup(
  group: SkillGroup,
  params: {
    agentId: string;
    allowSet: Set<string>;
    usingAllowlist: boolean;
    editable: boolean;
    onToggle: (agentId: string, skillName: string, enabled: boolean) => void;
  },
) {
  const collapsedByDefault = group.id === "workspace" || group.id === "built-in";
  return html`
    <details class="agent-skills-group" ?open=${!collapsedByDefault}>
      <summary class="agent-skills-header">
        <span>${group.label}</span>
        <span class="muted">${group.skills.length}</span>
      </summary>
      <div class="list skills-grid">
        ${group.skills.map((skill) =>
          renderAgentSkillRow(skill, {
            agentId: params.agentId,
            allowSet: params.allowSet,
            usingAllowlist: params.usingAllowlist,
            editable: params.editable,
            onToggle: params.onToggle,
          }),
        )}
      </div>
    </details>
  `;
}

function renderAgentSkillRow(
  skill: SkillStatusEntry,
  params: {
    agentId: string;
    allowSet: Set<string>;
    usingAllowlist: boolean;
    editable: boolean;
    onToggle: (agentId: string, skillName: string, enabled: boolean) => void;
  },
) {
  const enabled = params.usingAllowlist ? params.allowSet.has(skill.name) : true;
  const missing = computeSkillMissing(skill);
  const reasons = computeSkillReasons(skill);
  return html`
    <div class="list-item agent-skill-row">
      <div class="list-main">
        <div class="list-title">${skill.emoji ? `${skill.emoji} ` : ""}${skill.name}</div>
        <div class="list-sub">${skill.description}</div>
        ${renderSkillStatusChips({ skill })}
        ${missing.length > 0
          ? html`<div class="muted" style="margin-top: 6px;">
              ${t("agents.skillsPanel.missing", { items: missing.join(", ") })}
            </div>`
          : nothing}
        ${reasons.length > 0
          ? html`<div class="muted" style="margin-top: 6px;">
              ${t("agents.skillsPanel.reason", { items: reasons.join(", ") })}
            </div>`
          : nothing}
      </div>
      <div class="list-meta">
        <label class="cfg-toggle">
          <input
            type="checkbox"
            .checked=${enabled}
            ?disabled=${!params.editable}
            @change=${(e: Event) =>
              params.onToggle(params.agentId, skill.name, (e.target as HTMLInputElement).checked)}
          />
          <span class="cfg-toggle__track"></span>
        </label>
      </div>
    </div>
  `;
}
