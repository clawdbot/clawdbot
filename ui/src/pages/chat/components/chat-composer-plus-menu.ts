import "@awesome.me/webawesome/dist/components/switch/switch.js";
import { html, nothing, type TemplateResult } from "lit";
import type { ToolsEffectiveEntry, ToolsEffectiveResult } from "../../../api/types.ts";
import { pathForPluginsHubTab, pathForRoute } from "../../../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../../../app/context.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import type { McpServerSummary } from "../../../lib/config/mcp-servers.ts";
import { formatUiExternalText } from "../../../lib/format-error.ts";
import type { SessionToolOverrides } from "../../../lib/sessions/patch.ts";
import {
  countSessionToolOverrides,
  nextBooleanToolOverrides,
  nextMcpToolsDenyOverrides,
  nextWebSearchToolOverrides,
  readOwnEntry,
  resolveToolOverrideState,
} from "../../../lib/sessions/tool-overrides.ts";
import {
  handleChatAttachmentMenuSelection,
  renderChatAttachmentMenuOptions,
  renderChatAttachmentMenuTrigger,
  type ChatAttachmentControlsProps,
} from "./chat-attachments.ts";
import { renderVoiceAttachmentMenuOptions } from "./chat-voice-attachment-menu.ts";

export type ChatComposerPlusMenuView = "root" | "skills" | "connectors" | `tools:${string}`;

export type ChatComposerMenuSkill = {
  key: string;
  name: string;
  enabled: boolean;
  baseEnabled: boolean;
  missingDeps?: boolean;
  blocked?: boolean;
};

type ChatComposerRootToggle = {
  value: string;
  label: string;
  icon?: TemplateResult;
  checked: boolean;
  disabled: boolean;
  title?: string;
  onChange: (checked: boolean) => void;
};

type MenuRoute = "mcp" | "plugins" | "skills";

type ChatComposerPlusMenuProps = {
  attachments: ChatAttachmentControlsProps;
  showCapabilities: boolean;
  basePath: string;
  disabled: boolean;
  open: boolean;
  view: ChatComposerPlusMenuView;
  toolOverrides: SessionToolOverrides | null | undefined;
  skills: readonly ChatComposerMenuSkill[] | null;
  skillsLoading: boolean;
  skillsError: boolean;
  mcpServers: readonly McpServerSummary[];
  toolsEffectiveResult: ToolsEffectiveResult | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveError: boolean;
  toolAccessMutationBlockedReason: string | null;
  webSearchBaseEnabled: boolean;
  mutationBlockedReason: string | null;
  canAdmin: boolean;
  adminBlockedReason: string | null;
  rootToggles?: readonly ChatComposerRootToggle[];
  voiceActive: boolean;
  addServerDialog?: TemplateResult | typeof nothing;
  onOpenChange: (open: boolean) => void;
  onViewChange: (view: ChatComposerPlusMenuView) => void;
  onLoadSkills: () => void;
  onPatchToolOverrides: (next: SessionToolOverrides | null) => void;
  onNavigate: (routeId: MenuRoute, options?: ApplicationNavigationOptions) => void;
  onAddServer?: () => void;
  onEnsureToolAccess?: (serverName: string) => void;
  onOpenToolAccess?: (serverName: string) => void;
};

export type ChatComposerCapabilityMenuProps = Omit<
  ChatComposerPlusMenuProps,
  | "attachments"
  | "disabled"
  | "open"
  | "view"
  | "toolOverrides"
  | "onOpenChange"
  | "onViewChange"
  | "showCapabilities"
  | "rootToggles"
  | "voiceActive"
>;

function menuDivider(): TemplateResult {
  return html`<div class="agent-chat__capability-menu-divider" role="separator"></div>`;
}

function internalLink(href: string, label: string): TemplateResult {
  return html`<a
    class="agent-chat__capability-menu-link"
    href=${href}
    tabindex="-1"
    @click=${(event: MouseEvent) => event.preventDefault()}
    >${label}</a
  >`;
}

function renderBackRow() {
  return html`
    <wa-dropdown-item class="agent-chat__capability-menu-item" value="back">
      <span slot="icon" aria-hidden="true">${icons.arrowLeft}</span>
      <span>${t("chat.composer.menu.back")}</span>
    </wa-dropdown-item>
    ${menuDivider()}
  `;
}

function renderCapabilityToggleRow(options: {
  value: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  title: string | null | undefined;
  icon?: TemplateResult;
  note?: TemplateResult | typeof nothing;
  checkbox?: boolean;
}) {
  return html`
    <wa-dropdown-item
      class="agent-chat__capability-menu-item agent-chat__capability-menu-toggle"
      value=${options.value}
      type=${options.checkbox ? "checkbox" : "normal"}
      .checked=${options.checked}
      ?disabled=${options.disabled}
      title=${options.title ?? ""}
    >
      ${options.icon ? html`<span slot="icon" aria-hidden="true">${options.icon}</span>` : nothing}
      <span class="agent-chat__capability-menu-label">
        <span>${options.label}</span>
        ${options.note ?? nothing}
      </span>
      ${options.checkbox
        ? nothing
        : html`<wa-switch
            slot="details"
            class="agent-chat__capability-menu-switch"
            size="s"
            tabindex="-1"
            .checked=${options.checked}
            ?disabled=${options.disabled}
            aria-label=${options.label}
          ></wa-switch>`}
    </wa-dropdown-item>
  `;
}

function renderRootView(props: ChatComposerPlusMenuProps) {
  const overrideCount = countSessionToolOverrides(props.toolOverrides);
  const connectorCount = props.mcpServers.filter((server) =>
    resolveToolOverrideState(
      server.enabled,
      readOwnEntry(props.toolOverrides?.mcpServers, server.name),
    ),
  ).length;
  const hasSkillOverrides = Object.keys(props.toolOverrides?.skills ?? {}).length > 0;
  const enabledSkillCount = props.skills?.filter((skill) => skill.enabled).length ?? 0;
  const webSearchEnabled = resolveToolOverrideState(
    props.webSearchBaseEnabled,
    props.toolOverrides?.webSearch,
  );
  const attachments = props.voiceActive
    ? renderVoiceAttachmentMenuOptions()
    : renderChatAttachmentMenuOptions(icons.paperclip);
  const rootToggles = props.rootToggles ?? [];
  if (!props.showCapabilities && rootToggles.length === 0) {
    return attachments;
  }
  // Core gates managed and Codex-native search. Config sniffing misses env/native providers;
  // without a provider, this session override is a harmless no-op.
  return html`
    ${attachments} ${menuDivider()}
    ${rootToggles.map((toggle) =>
      renderCapabilityToggleRow({
        value: toggle.value,
        label: toggle.label,
        icon: toggle.icon,
        checked: toggle.checked,
        disabled: toggle.disabled,
        title: toggle.title,
      }),
    )}
    ${props.showCapabilities
      ? html`<wa-dropdown-item class="agent-chat__capability-menu-item" value="open-skills">
            <span slot="icon" aria-hidden="true">${icons.book}</span>
            <span>${t("chat.composer.menu.skills")}</span>
            <span slot="details" class="agent-chat__capability-menu-details">
              ${hasSkillOverrides
                ? html`<span class="agent-chat__capability-menu-badge"
                    >${t("chat.composer.menu.enabledCount", {
                      count: String(enabledSkillCount),
                    })}</span
                  >`
                : nothing}
              <span class="agent-chat__capability-menu-chevron" aria-hidden="true"
                >${icons.chevronRight}</span
              >
            </span>
          </wa-dropdown-item>
          <wa-dropdown-item class="agent-chat__capability-menu-item" value="open-connectors">
            <span slot="icon" aria-hidden="true">${icons.puzzle}</span>
            <span>${t("chat.composer.menu.connectors")}</span>
            <span slot="details" class="agent-chat__capability-menu-details">
              <span class="agent-chat__capability-menu-badge">${connectorCount}</span>
              <span class="agent-chat__capability-menu-chevron" aria-hidden="true"
                >${icons.chevronRight}</span
              >
            </span>
          </wa-dropdown-item>
          ${renderCapabilityToggleRow({
            value: "toggle-web-search",
            label: t("chat.composer.menu.webSearch"),
            checked: webSearchEnabled,
            disabled: props.mutationBlockedReason !== null,
            title: props.mutationBlockedReason,
            icon: icons.globe,
            checkbox: true,
          })}
          ${menuDivider()}
          <wa-dropdown-item class="agent-chat__capability-menu-item" value="manage-plugins">
            <span slot="icon" aria-hidden="true">${icons.puzzle}</span>
            ${internalLink(
              pathForRoute("plugins", props.basePath),
              t("chat.composer.menu.managePlugins"),
            )}
          </wa-dropdown-item>
          ${overrideCount > 0
            ? html`
                <wa-dropdown-item
                  class="agent-chat__capability-menu-item agent-chat__capability-menu-overrides"
                  value="clear-overrides"
                  ?disabled=${props.mutationBlockedReason !== null}
                  title=${props.mutationBlockedReason ?? ""}
                >
                  <span slot="icon" aria-hidden="true">${icons.settings}</span>
                  <span
                    >${t(
                      overrideCount === 1
                        ? "chat.composer.overrides.countOne"
                        : "chat.composer.overrides.count",
                      { count: String(overrideCount) },
                    )}</span
                  >
                  <span
                    slot="details"
                    class="agent-chat__capability-menu-clear-overrides"
                    aria-hidden="true"
                    >${icons.x}</span
                  >
                </wa-dropdown-item>
              `
            : nothing}`
      : nothing}
  `;
}

function renderSkillView(props: ChatComposerPlusMenuProps) {
  const disabledReason = props.mutationBlockedReason;
  const rows = props.skillsLoading
    ? html`<div class="agent-chat__capability-menu-state" role="status">
        ${t("chat.composer.menu.loadingSkills")}
      </div>`
    : props.skillsError
      ? html`<div class="agent-chat__capability-menu-state" role="alert">
          ${t("chat.composer.menu.skillsLoadFailed")}
        </div>`
      : !props.skills || props.skills.length === 0
        ? html`<div class="agent-chat__capability-menu-state">
            ${t("chat.composer.menu.noSkills")}
          </div>`
        : props.skills.map((skill, index) => {
            const title = skill.missingDeps
              ? t("chat.composer.menu.depsMissing")
              : skill.blocked
                ? t("chat.composer.menu.skillBlocked")
                : disabledReason;
            return renderCapabilityToggleRow({
              value: `skill:${index}`,
              label: skill.name,
              checked: skill.enabled,
              disabled: skill.missingDeps || skill.blocked || disabledReason !== null,
              title,
              note:
                skill.missingDeps || skill.blocked
                  ? html`<span class="agent-chat__capability-menu-note">${title}</span>`
                  : nothing,
            });
          });
  return html`
    ${renderBackRow()} ${rows} ${menuDivider()}
    <wa-dropdown-item class="agent-chat__capability-menu-item" value="manage-skills">
      ${internalLink(pathForRoute("skills", props.basePath), t("chat.composer.menu.manageSkills"))}
    </wa-dropdown-item>
  `;
}

function renderConnectorView(props: ChatComposerPlusMenuProps) {
  const disabledReason = props.mutationBlockedReason;
  const rows =
    props.mcpServers.length === 0
      ? html`<div class="agent-chat__capability-menu-state">
          ${t("chat.composer.menu.noConnectors")}
        </div>`
      : props.mcpServers.map((server, index) => {
          const override = readOwnEntry(props.toolOverrides?.mcpServers, server.name);
          const enabled = resolveToolOverrideState(server.enabled, override);
          return html`
            ${renderCapabilityToggleRow({
              value: `connector:${index}`,
              label: server.name,
              checked: enabled,
              disabled: disabledReason !== null,
              title: disabledReason,
              note: html`<span class="agent-chat__capability-menu-note">
                ${enabled ? t("common.enabled") : t("common.disabled")}
                ${override !== undefined
                  ? html`<span class="agent-chat__capability-menu-session-tag"
                      >${t("chat.composer.menu.sessionTag")}</span
                    >`
                  : nothing}
              </span>`,
            })}
            ${props.onOpenToolAccess
              ? html`<wa-dropdown-item
                  class="agent-chat__capability-menu-item agent-chat__capability-menu-subrow"
                  value=${`tools:${index}`}
                >
                  <span slot="icon" aria-hidden="true">${icons.wrench}</span>
                  <span>${t("chat.composer.menu.toolAccess.label")}</span>
                </wa-dropdown-item>`
              : nothing}
          `;
        });
  const adminDisabled = !props.canAdmin;
  return html`
    ${renderBackRow()} ${rows} ${menuDivider()}
    ${props.onAddServer
      ? html`<wa-dropdown-item
          class="agent-chat__capability-menu-item"
          value="add-server"
          ?disabled=${adminDisabled}
          title=${adminDisabled ? (props.adminBlockedReason ?? "") : ""}
        >
          <span slot="icon" aria-hidden="true">${icons.plus}</span>
          <span>${t("chat.composer.menu.addMcpServer")}</span>
        </wa-dropdown-item>`
      : nothing}
    <wa-dropdown-item
      class="agent-chat__capability-menu-item"
      value="browse-connectors"
      ?disabled=${adminDisabled}
      title=${adminDisabled ? (props.adminBlockedReason ?? "") : ""}
    >
      <span slot="icon" aria-hidden="true">${icons.search}</span>
      ${internalLink(
        pathForPluginsHubTab("discover", props.basePath),
        t("chat.composer.menu.browseConnectors"),
      )}
    </wa-dropdown-item>
  `;
}

function toolsForServer(
  result: ToolsEffectiveResult | null,
  serverName: string,
): (ToolsEffectiveEntry & { mcpToolName: string })[] {
  return (result?.groups ?? [])
    .flatMap((group) => group.tools)
    .filter(
      (tool): tool is ToolsEffectiveEntry & { mcpToolName: string } =>
        tool.source === "mcp" && tool.mcpServer === serverName && Boolean(tool.mcpToolName),
    );
}

const MCP_DISCOVERY_NOTICE_IDS = new Set([
  "mcp-not-yet-connected",
  "mcp-not-yet-listed",
  "mcp-stale-catalog",
]);

function mcpDiscoveryNotice(result: ToolsEffectiveResult | null, serverName: string) {
  return result?.notices?.find(
    (notice) =>
      MCP_DISCOVERY_NOTICE_IDS.has(notice.id) && notice.servers?.includes(serverName) === true,
  );
}

function isToolDenied(props: ChatComposerPlusMenuProps, tool: ToolsEffectiveEntry): boolean {
  const serverName = tool.mcpServer;
  const rawToolName = tool.mcpToolName;
  if (!serverName || !rawToolName) {
    return false;
  }
  if (props.toolOverrides != null) {
    return (
      readOwnEntry(props.toolOverrides.mcpToolsDeny, serverName)?.includes(rawToolName) ?? false
    );
  }
  return tool.deniedBySession === true;
}

function renderToolAccessView(props: ChatComposerPlusMenuProps, serverName: string) {
  const tools = toolsForServer(props.toolsEffectiveResult, serverName);
  const discoveryNotice =
    tools.length === 0 ? mcpDiscoveryNotice(props.toolsEffectiveResult, serverName) : null;
  const enabledCount = tools.filter((tool) => !isToolDenied(props, tool)).length;
  const summary = t(
    tools.length === 1
      ? "chat.composer.menu.toolAccess.summaryOne"
      : "chat.composer.menu.toolAccess.summary",
    { enabled: String(enabledCount), total: String(tools.length) },
  );
  const rows = props.toolsEffectiveLoading
    ? html`<div class="agent-chat__capability-menu-state" role="status">
        ${t("chat.composer.menu.toolAccess.loading")}
      </div>`
    : props.toolsEffectiveError
      ? html`<div class="agent-chat__capability-menu-state" role="alert">
          ${t("chat.composer.menu.toolAccess.loadFailed")}
        </div>`
      : discoveryNotice
        ? html`<div class="agent-chat__capability-menu-state" role="status">
            ${formatUiExternalText(discoveryNotice.message)}
          </div>`
        : tools.length === 0
          ? html`<div class="agent-chat__capability-menu-state">
              ${t("chat.composer.menu.toolAccess.noTools")}
            </div>`
          : tools.map((tool, index) => {
              const rawToolName = tool.mcpToolName;
              const label = tool.label?.trim();
              const denied = isToolDenied(props, tool);
              return renderCapabilityToggleRow({
                value: `mcp-tool:${index}`,
                label: rawToolName,
                checked: !denied,
                disabled: props.toolAccessMutationBlockedReason !== null,
                title: props.toolAccessMutationBlockedReason,
                note:
                  label && label !== rawToolName
                    ? html`<span class="agent-chat__capability-menu-note">${label}</span>`
                    : nothing,
              });
            });
  return html`
    ${renderBackRow()}
    <div class="agent-chat__capability-menu-state">
      <span class="agent-chat__capability-menu-label">
        <strong translate="no">${serverName}</strong>
        ${tools.length > 0
          ? html`<span class="agent-chat__capability-menu-note">${summary}</span>`
          : nothing}
      </span>
    </div>
    ${rows}
  `;
}

function handleMenuSelection(
  event: CustomEvent<{ item: { value?: string } }>,
  props: ChatComposerPlusMenuProps,
) {
  const value = event.detail.item.value ?? "";
  if (handleChatAttachmentMenuSelection(event)) {
    return;
  }
  const rootToggle = props.rootToggles?.find((toggle) => toggle.value === value);
  if (rootToggle) {
    event.preventDefault();
    if (!rootToggle.disabled) {
      rootToggle.onChange(!rootToggle.checked);
    }
    return;
  }
  const menu = event.currentTarget as HTMLElement;
  const changeView = (view: ChatComposerPlusMenuView) => {
    props.onViewChange(view);
    requestAnimationFrame(() =>
      menu.querySelector<HTMLElement>("wa-dropdown-item:not([disabled])")?.focus(),
    );
  };
  if (value === "back") {
    event.preventDefault();
    changeView(props.view.startsWith("tools:") ? "connectors" : "root");
    return;
  }
  if (value === "open-skills" || value === "open-connectors") {
    event.preventDefault();
    changeView(value === "open-skills" ? "skills" : "connectors");
    return;
  }
  if (value === "toggle-web-search") {
    event.preventDefault();
    if (props.mutationBlockedReason) {
      return;
    }
    const enabled = resolveToolOverrideState(
      props.webSearchBaseEnabled,
      props.toolOverrides?.webSearch,
    );
    props.onPatchToolOverrides(
      nextWebSearchToolOverrides(props.toolOverrides, !enabled, props.webSearchBaseEnabled),
    );
    return;
  }
  if (value === "clear-overrides") {
    event.preventDefault();
    if (!props.mutationBlockedReason) {
      props.onPatchToolOverrides(null);
    }
    return;
  }
  if (value.startsWith("skill:")) {
    event.preventDefault();
    const skill = props.skills?.[Number(value.slice("skill:".length))];
    if (skill && !skill.missingDeps && !skill.blocked && !props.mutationBlockedReason) {
      props.onPatchToolOverrides(
        nextBooleanToolOverrides(
          props.toolOverrides,
          "skills",
          skill.key,
          !skill.enabled,
          skill.baseEnabled,
        ),
      );
    }
    return;
  }
  if (value.startsWith("connector:")) {
    event.preventDefault();
    const server = props.mcpServers[Number(value.slice("connector:".length))];
    if (server && !props.mutationBlockedReason) {
      const enabled = resolveToolOverrideState(
        server.enabled,
        readOwnEntry(props.toolOverrides?.mcpServers, server.name),
      );
      props.onPatchToolOverrides(
        nextBooleanToolOverrides(
          props.toolOverrides,
          "mcpServers",
          server.name,
          !enabled,
          server.enabled,
        ),
      );
    }
    return;
  }
  if (value.startsWith("tools:")) {
    event.preventDefault();
    const server = props.mcpServers[Number(value.slice("tools:".length))];
    if (server) {
      props.onOpenToolAccess?.(server.name);
      changeView(`tools:${server.name}`);
    }
    return;
  }
  if (value.startsWith("mcp-tool:") && props.view.startsWith("tools:")) {
    event.preventDefault();
    if (props.toolAccessMutationBlockedReason) {
      return;
    }
    const serverName = props.view.slice("tools:".length);
    const tool = toolsForServer(props.toolsEffectiveResult, serverName)[
      Number(value.slice("mcp-tool:".length))
    ];
    if (tool?.mcpToolName) {
      props.onPatchToolOverrides(
        nextMcpToolsDenyOverrides(
          props.toolOverrides,
          serverName,
          tool.mcpToolName,
          !isToolDenied(props, tool),
        ),
      );
    }
    return;
  }
  if (value === "add-server") {
    props.onAddServer?.();
    return;
  }
  if (value === "manage-skills") {
    props.onNavigate("skills");
  } else if (value === "manage-plugins") {
    props.onNavigate("plugins");
  } else if (value === "browse-connectors") {
    props.onNavigate("plugins", {
      pathname: pathForPluginsHubTab("discover", props.basePath),
    });
  }
}

function renderChatComposerPlusMenuContent(props: ChatComposerPlusMenuProps) {
  const hasOverrides = countSessionToolOverrides(props.toolOverrides) > 0;
  const view = props.showCapabilities ? props.view : "root";
  if (view.startsWith("tools:")) {
    props.onEnsureToolAccess?.(view.slice("tools:".length));
  }
  const content =
    view === "skills"
      ? renderSkillView(props)
      : view === "connectors"
        ? renderConnectorView(props)
        : view.startsWith("tools:")
          ? renderToolAccessView(props, view.slice("tools:".length))
          : renderRootView(props);
  return html`
    <wa-dropdown
      class="agent-chat__attach-menu agent-chat__capability-menu ${props.voiceActive
        ? "agent-chat__attach-menu--voice"
        : ""}"
      placement="top-start"
      aria-label=${t("chat.composer.addAttachment")}
      .open=${props.open}
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) =>
        handleMenuSelection(event, props)}
      @wa-show=${() => {
        if (!props.open) {
          props.onOpenChange(true);
        }
        props.onLoadSkills();
      }}
      @wa-hide=${() => {
        if (props.open) {
          props.onOpenChange(false);
        }
      }}
      data-view=${view}
    >
      ${renderChatAttachmentMenuTrigger(props.disabled, hasOverrides)}
      ${props.voiceActive
        ? html`<div class="agent-chat__attach-menu-heading">
            ${t("chat.composer.addToMessage")}
          </div>`
        : nothing}
      ${content}
    </wa-dropdown>
    ${props.addServerDialog ?? nothing}
  `;
}

export function renderChatComposerPlusMenu(props: {
  attachments: ChatAttachmentControlsProps;
  capabilityMenu?: ChatComposerCapabilityMenuProps;
  disabled: boolean;
  open: boolean;
  view: ChatComposerPlusMenuView;
  toolOverrides: SessionToolOverrides | null | undefined;
  rootToggles?: readonly ChatComposerRootToggle[];
  voiceActive?: boolean;
  onOpenChange: (open: boolean) => void;
  onViewChange: (view: ChatComposerPlusMenuView) => void;
}) {
  const capabilityMenu = props.capabilityMenu;
  const voiceActive = props.voiceActive === true;
  return renderChatComposerPlusMenuContent({
    attachments: props.attachments,
    showCapabilities: capabilityMenu !== undefined && !voiceActive,
    basePath: capabilityMenu?.basePath ?? "",
    disabled: props.disabled,
    open: props.open,
    view: props.view,
    toolOverrides: props.toolOverrides,
    skills: capabilityMenu?.skills ?? null,
    skillsLoading: capabilityMenu?.skillsLoading ?? false,
    skillsError: capabilityMenu?.skillsError ?? false,
    mcpServers: capabilityMenu?.mcpServers ?? [],
    toolsEffectiveResult: capabilityMenu?.toolsEffectiveResult ?? null,
    toolsEffectiveLoading: capabilityMenu?.toolsEffectiveLoading ?? false,
    toolsEffectiveError: capabilityMenu?.toolsEffectiveError ?? false,
    toolAccessMutationBlockedReason: capabilityMenu?.toolAccessMutationBlockedReason ?? null,
    webSearchBaseEnabled: capabilityMenu?.webSearchBaseEnabled ?? true,
    mutationBlockedReason: capabilityMenu?.mutationBlockedReason ?? null,
    canAdmin: capabilityMenu?.canAdmin ?? false,
    adminBlockedReason: capabilityMenu?.adminBlockedReason ?? null,
    rootToggles: props.rootToggles,
    voiceActive,
    addServerDialog: capabilityMenu?.addServerDialog,
    onOpenChange: props.onOpenChange,
    onViewChange: props.onViewChange,
    onLoadSkills: capabilityMenu?.onLoadSkills ?? (() => {}),
    onPatchToolOverrides: capabilityMenu?.onPatchToolOverrides ?? (() => {}),
    onNavigate: capabilityMenu?.onNavigate ?? (() => {}),
    onAddServer: capabilityMenu?.onAddServer,
    onEnsureToolAccess: capabilityMenu?.onEnsureToolAccess,
    onOpenToolAccess: capabilityMenu?.onOpenToolAccess,
  });
}
