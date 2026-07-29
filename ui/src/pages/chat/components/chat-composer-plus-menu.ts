import "@awesome.me/webawesome/dist/components/switch/switch.js";
import { html, nothing, type TemplateResult } from "lit";
import { pathForPluginsHubTab, pathForRoute } from "../../../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../../../app/context.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import type { McpServerSummary } from "../../../lib/config/mcp-servers.ts";
import type { SessionToolOverrides } from "../../../lib/sessions/patch.ts";
import {
  nextBooleanToolOverrides,
  nextWebSearchToolOverrides,
  resolveToolOverrideState,
} from "../../../lib/sessions/tool-overrides.ts";
import { clickComposerInput, type ChatAttachmentControlsProps } from "./chat-attachments.ts";

export type ChatComposerPlusMenuView = "root" | "skills" | "connectors" | `tools:${string}`;

export type ChatComposerMenuSkill = {
  key: string;
  name: string;
  enabled: boolean;
  baseEnabled: boolean;
  missingDeps?: boolean;
  blocked?: boolean;
};

type MenuRoute = "mcp" | "plugins" | "skills";

export type ChatComposerPlusMenuProps = {
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
  webSearchBaseEnabled: boolean;
  mutationBlockedReason: string | null;
  canAdmin: boolean;
  adminBlockedReason: string | null;
  addServerDialog?: TemplateResult | typeof nothing;
  onOpenChange: (open: boolean) => void;
  onViewChange: (view: ChatComposerPlusMenuView) => void;
  onLoadSkills: () => void;
  onPatchToolOverrides: (next: SessionToolOverrides | null) => void;
  onNavigate: (routeId: MenuRoute, options?: ApplicationNavigationOptions) => void;
  onAddServer?: () => void;
  onOpenToolAccess?: (serverName: string) => void;
};

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

function renderRootView(props: ChatComposerPlusMenuProps) {
  const connectorCount = props.mcpServers.filter((server) =>
    resolveToolOverrideState(server.enabled, props.toolOverrides?.mcpServers?.[server.name]),
  ).length;
  const hasSkillOverrides = Object.keys(props.toolOverrides?.skills ?? {}).length > 0;
  const enabledSkillCount = props.skills?.filter((skill) => skill.enabled).length ?? 0;
  const webSearchEnabled = resolveToolOverrideState(
    props.webSearchBaseEnabled,
    props.toolOverrides?.webSearch,
  );
  const attachments = html`
    <wa-dropdown-item class="agent-chat__attach-menu-option" value="camera">
      <span slot="icon" aria-hidden="true">${icons.camera}</span>
      <span>${t("chat.composer.takePhoto")}</span>
    </wa-dropdown-item>
    <wa-dropdown-item class="agent-chat__attach-menu-option" value="photo">
      <span slot="icon" aria-hidden="true">${icons.image}</span>
      <span>${t("chat.composer.attachPhoto")}</span>
    </wa-dropdown-item>
    <wa-dropdown-item class="agent-chat__attach-menu-option" value="file">
      <span slot="icon" aria-hidden="true">${icons.paperclip}</span>
      <span>${t("chat.composer.attachFileOption")}</span>
    </wa-dropdown-item>
  `;
  if (!props.showCapabilities) {
    return attachments;
  }
  // Core gates managed and Codex-native search. Config sniffing misses env/native providers;
  // without a provider, this session override is a harmless no-op.
  return html`
    ${attachments} ${menuDivider()}
    <wa-dropdown-item class="agent-chat__capability-menu-item" value="open-skills">
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
    <wa-dropdown-item
      class="agent-chat__capability-menu-item"
      type="checkbox"
      value="toggle-web-search"
      .checked=${webSearchEnabled}
      ?disabled=${props.mutationBlockedReason !== null}
      title=${props.mutationBlockedReason ?? ""}
    >
      <span slot="icon" aria-hidden="true">${icons.globe}</span>
      <span>${t("chat.composer.menu.webSearch")}</span>
    </wa-dropdown-item>
    ${menuDivider()}
    <wa-dropdown-item class="agent-chat__capability-menu-item" value="manage-plugins">
      <span slot="icon" aria-hidden="true">${icons.puzzle}</span>
      ${internalLink(
        pathForRoute("plugins", props.basePath),
        t("chat.composer.menu.managePlugins"),
      )}
    </wa-dropdown-item>
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
            const rowDisabled = skill.missingDeps || skill.blocked || disabledReason !== null;
            const title = skill.missingDeps
              ? t("chat.composer.menu.depsMissing")
              : skill.blocked
                ? t("chat.composer.menu.skillBlocked")
                : disabledReason;
            return html`
              <wa-dropdown-item
                class="agent-chat__capability-menu-item agent-chat__capability-menu-toggle"
                value=${`skill:${index}`}
                ?disabled=${rowDisabled}
                title=${title ?? ""}
              >
                <span class="agent-chat__capability-menu-label">
                  <span>${skill.name}</span>
                  ${skill.missingDeps
                    ? html`<span class="agent-chat__capability-menu-note"
                        >${t("chat.composer.menu.depsMissing")}</span
                      >`
                    : skill.blocked
                      ? html`<span class="agent-chat__capability-menu-note"
                          >${t("chat.composer.menu.skillBlocked")}</span
                        >`
                      : nothing}
                </span>
                <wa-switch
                  slot="details"
                  class="agent-chat__capability-menu-switch"
                  size="s"
                  tabindex="-1"
                  .checked=${skill.enabled}
                  ?disabled=${rowDisabled}
                  aria-label=${skill.name}
                ></wa-switch>
              </wa-dropdown-item>
            `;
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
          const override = props.toolOverrides?.mcpServers?.[server.name];
          const enabled = resolveToolOverrideState(server.enabled, override);
          return html`
            <wa-dropdown-item
              class="agent-chat__capability-menu-item agent-chat__capability-menu-toggle"
              value=${`connector:${index}`}
              ?disabled=${disabledReason !== null}
              title=${disabledReason ?? ""}
            >
              <span class="agent-chat__capability-menu-label">
                <span>${server.name}</span>
                <span class="agent-chat__capability-menu-note">
                  ${enabled ? t("common.enabled") : t("common.disabled")}
                  ${override !== undefined
                    ? html`<span class="agent-chat__capability-menu-session-tag"
                        >${t("chat.composer.menu.sessionTag")}</span
                      >`
                    : nothing}
                </span>
              </span>
              <wa-switch
                slot="details"
                class="agent-chat__capability-menu-switch"
                size="s"
                tabindex="-1"
                .checked=${enabled}
                ?disabled=${disabledReason !== null}
                aria-label=${server.name}
              ></wa-switch>
            </wa-dropdown-item>
            ${props.onOpenToolAccess
              ? html`<wa-dropdown-item
                  class="agent-chat__capability-menu-item agent-chat__capability-menu-subrow"
                  value=${`tools:${index}`}
                >
                  <span slot="icon" aria-hidden="true">${icons.wrench}</span>
                  <span>${t("chat.composer.menu.toolAccess")}</span>
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

function handleMenuSelection(
  event: CustomEvent<{ item: { value?: string } }>,
  props: ChatComposerPlusMenuProps,
) {
  const value = event.detail.item.value ?? "";
  const menu = event.currentTarget as HTMLElement;
  const changeView = (view: ChatComposerPlusMenuView) => {
    props.onViewChange(view);
    requestAnimationFrame(() =>
      menu.querySelector<HTMLElement>("wa-dropdown-item:not([disabled])")?.focus(),
    );
  };
  if (value === "camera" || value === "photo" || value === "file") {
    clickComposerInput(menu, `.agent-chat__${value === "file" ? "file" : value}-input`);
    return;
  }
  if (value === "back") {
    event.preventDefault();
    changeView("root");
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
        props.toolOverrides?.mcpServers?.[server.name],
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
    const server = props.mcpServers[Number(value.slice("tools:".length))];
    if (server) {
      props.onOpenToolAccess?.(server.name);
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

export function renderChatComposerPlusMenu(props: ChatComposerPlusMenuProps) {
  const view = props.showCapabilities ? props.view : "root";
  const content =
    view === "skills"
      ? renderSkillView(props)
      : view === "connectors"
        ? renderConnectorView(props)
        : renderRootView(props);
  return html`
    <wa-dropdown
      class="agent-chat__attach-menu agent-chat__capability-menu"
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
      <button
        slot="trigger"
        type="button"
        class="agent-chat__input-btn agent-chat__input-btn--attach"
        aria-label=${t("chat.composer.addAttachment")}
        ?disabled=${props.disabled}
        title=${t("chat.composer.addAttachment")}
        @pointerdown=${(event: PointerEvent) => {
          const composer = (event.currentTarget as HTMLElement)
            .closest(".agent-chat__composer-shell")
            ?.querySelector("textarea");
          if (document.activeElement === composer) {
            event.preventDefault();
          }
        }}
      >
        ${icons.plus}
      </button>
      ${content}
    </wa-dropdown>
    ${props.addServerDialog ?? nothing}
  `;
}
