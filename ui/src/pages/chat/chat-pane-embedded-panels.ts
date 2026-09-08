import type { ControlUiFocusBuildTarget } from "@openclaw/session-url-contract";
import { html, nothing, type TemplateResult } from "lit";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ControlUiSessionPullRequest } from "../../../../src/gateway/control-ui-contract.js";
import type { ControlUiPanel } from "../../../../src/plugin-sdk/control-ui.js";
import { isBrowserPanelAvailable } from "../../app/panel-availability.ts";
import type { BrowserTabSelection } from "../../components/browser/browser-target.ts";
import { icons } from "../../components/icons.ts";
import { renderPanelLoadingSkeleton } from "../../components/panel-loading-skeleton.ts";
import { t } from "../../i18n/index.ts";
import { formatKeyboardShortcutCombo } from "../../lib/keyboard-shortcut-catalog.ts";
import type { ControlUiRegistration } from "../../plugins/control-ui-capability.ts";
import { renderPluginContribution } from "../../plugins/control-ui-view.ts";
import { SIDEBAR_PANEL_SHORTCUTS } from "./chat-pane-panel-shortcuts.ts";
import { resolveAssistantAttachmentAuthToken } from "./chat-pane-state.ts";
import type { ChatSessionCompanionThread } from "./chat-session-companion.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveSessionDiffSidebarContent } from "./components/chat-session-workspace.ts";
import type {
  SidebarPanelDefinition,
  SidebarPanelTemplates,
} from "./components/chat-sidebar-region-types.ts";
import type { SidebarContent } from "./components/chat-sidebar.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.ts";
import type { SidebarSlotId } from "./sidebar-layout-types.ts";

type SidebarPanelDefinitionParams = {
  state: ChatPageHost;
  themeMode: "dark" | "light";
  agentId: string | null;
  browserPresented: boolean;
  browserRefreshOnPresentation: boolean;
  preferredBrowserTab?: BrowserTabSelection;
  desktopPresented: boolean;
  desktopRefreshOnPresentation: boolean;
  desktopAvailable: boolean;
  desktopSource: string | null;
  desktopFocusHref: string;
  onDesktopFocusTargetChange: (
    target: Extract<ControlUiFocusBuildTarget, { kind: "desktop" }>,
  ) => void;
  dashboard: TemplateResult | typeof nothing;
  workspace: TemplateResult | typeof nothing;
  tasks: TemplateResult | typeof nothing;
  renderDetail: (content: SidebarContent) => TemplateResult;
  digest: SessionObserverDigest | null;
  activeRunId: string | null;
  startedAt: number | undefined;
  lastReadAt: number | undefined;
  pullRequests: ControlUiSessionPullRequest[];
  companion: ChatSessionCompanionThread;
  onCompanionSubmit: (question: string) => void;
  onCompanionDraftChange: (draft: string) => void;
  onCompanionVisibilityChange: (visible: boolean) => void;
  connected: boolean;
  pendingQuestion: string | null;
  onClearCompanion: () => void;
  onRefreshTasks: () => void;
  tasksLoading: boolean;
  discussion: SessionDiscussionPanelConfig | null;
  discussionAvailable: boolean;
  discussionOpenUrl: string | null;
  discussionSourceGeneration: number;
  pluginPanels: ControlUiRegistration<ControlUiPanel>[];
  isPluginPanelPresented: (slot: SidebarSlotId) => boolean;
};

type SidebarPanelTextKey =
  | Exclude<SidebarSlotId, `plugin:${string}` | "detail" | "workspace">
  | "review"
  | "files";

function panelExternalLink(href: string | null | undefined, label: string) {
  return href
    ? html`<a
        class="rail-header__action"
        href=${href}
        target="_blank"
        rel="noopener"
        aria-label=${label}
        title=${label}
        >${icons.externalLink}</a
      >`
    : undefined;
}

/** One ordered declaration for every chat side-panel slot. */
export function sidebarPanelDefinitions(
  params?: SidebarPanelDefinitionParams,
): SidebarPanelDefinition[] {
  const state = params?.state;
  // Metadata-only definitions have no pane context, so they describe types without offering tabs.
  const panelContext = params && {
    ...params,
    dashboardAvailable: () => params.dashboard !== nothing,
  };
  const definePanel = (
    slot: Exclude<SidebarSlotId, `plugin:${string}`>,
    textKey: SidebarPanelTextKey,
    icon: TemplateResult,
    content: TemplateResult | typeof nothing | null,
    headerAction?: TemplateResult,
  ): SidebarPanelDefinition => ({
    slot,
    label: t(`chat.sidePanel.${textKey}`),
    icon,
    available: Boolean(panelContext && SIDEBAR_PANEL_SHORTCUTS[slot]?.available(panelContext)),
    content,
    loading: renderPanelLoadingSkeleton(
      textKey === "conversation" || textKey === "companion"
        ? "chat"
        : textKey === "dashboard"
          ? "board"
          : textKey,
      t("common.loading"),
    ),
    empty: { description: t(`chat.sidePanel.${textKey}Empty`) },
    headerAction,
    shortcut: SIDEBAR_PANEL_SHORTCUTS[slot]
      ? formatKeyboardShortcutCombo(SIDEBAR_PANEL_SHORTCUTS[slot].combo)
      : undefined,
  });
  const terminal = state?.terminalAvailable
    ? html`<openclaw-terminal-panel
        embedded
        .client=${state.connected ? state.client : null}
        .available=${state.terminalAvailable}
        .agentId=${params?.agentId ?? null}
        .sessionKey=${state.sessionKey}
        .themeMode=${params?.themeMode ?? "dark"}
        .basePath=${state.basePath}
      ></openclaw-terminal-panel>`
    : null;
  const browser = state?.browserPanelAvailable
    ? html`<openclaw-browser-panel
        embedded
        data-chat-autotype-exempt
        .client=${state.connected ? state.client : null}
        .available=${state.browserPanelAvailable}
        .remoteAvailable=${isBrowserPanelAvailable({
          phase: state.connected ? "connected" : "offline",
          hello: state.hello,
        })}
        .presented=${params?.browserPresented ?? false}
        .refreshOnPresentation=${params?.browserRefreshOnPresentation ?? true}
        .sessionKey=${state.sessionKey}
        .preferredTab=${params?.preferredBrowserTab}
        .resourceBasePath=${state.resourceBasePath}
        .authToken=${resolveAssistantAttachmentAuthToken(state)}
      ></openclaw-browser-panel>`
    : null;
  const companion = params
    ? html`<openclaw-chat-session-rail
        embedded
        .sessionKey=${state?.sessionKey}
        .digest=${params.digest}
        .running=${Boolean(params.activeRunId)}
        .activeRunId=${params.activeRunId}
        .startedAt=${params.startedAt}
        .lastReadAt=${params.lastReadAt}
        .pullRequests=${params.pullRequests}
        .companion=${params.companion}
        .connected=${state?.connected === true}
        .onSubmit=${params.onCompanionSubmit}
        .onDraftChange=${params.onCompanionDraftChange}
        .onVisibilityChange=${params.onCompanionVisibilityChange}
      ></openclaw-chat-session-rail>`
    : null;
  const desktop =
    state && params?.desktopAvailable
      ? html`<openclaw-desktop-panel
          embedded
          data-chat-autotype-exempt
          .client=${state.connected ? state.client : null}
          .available=${params.desktopAvailable}
          .presented=${params?.desktopPresented ?? false}
          .refreshOnPresentation=${params?.desktopRefreshOnPresentation ?? true}
          .requestedSource=${params?.desktopSource ?? null}
          .sessionKey=${state.sessionKey}
          .onFocusTargetChange=${params?.onDesktopFocusTargetChange}
        ></openclaw-desktop-panel>`
      : null;
  const discussion = params?.discussion
    ? html`<openclaw-session-discussion
        .sessionKey=${params.discussion.sessionKey}
        .canOpen=${params.discussion.canOpen}
        .sourceGeneration=${params.discussionSourceGeneration}
        .loadInfo=${params.discussion.loadInfo}
        .openDiscussion=${params.discussion.openDiscussion}
        .onStateChange=${params.discussion.onStateChange}
      ></openclaw-session-discussion>`
    : null;
  const attachmentContent = state?.attachmentSidebarContent ?? null;
  // The region owns mounting and visibility. Hidden Review tabs must keep the
  // same cached diff loader so their live content and selection survive.
  const detailContent =
    state?.sidebarContent ?? (state ? resolveSessionDiffSidebarContent(state) : null);
  const workspaceContent =
    attachmentContent && params
      ? params.renderDetail(attachmentContent)
      : (params?.workspace ?? null);
  const pluginPanels = new Map<SidebarSlotId, ControlUiRegistration<ControlUiPanel> | undefined>(
    (params?.pluginPanels ?? []).map((entry) => [`plugin:${entry.key}`, entry]),
  );
  // Saved tabs outlive registrations, including during reconnect and activation.
  for (const column of state?.sidebarLayout.columns ?? []) {
    for (const { slot } of column.panels) {
      if (slot.startsWith("plugin:") && !pluginPanels.has(slot)) {
        pluginPanels.set(slot, undefined);
      }
    }
  }
  return [
    definePanel("conversation", "conversation", icons.messageSquare, nothing),
    definePanel(
      "detail",
      "review",
      icons.diff,
      detailContent?.kind === "loading"
        ? renderPanelLoadingSkeleton("review", t("common.loading"))
        : detailContent && params
          ? params.renderDetail(detailContent)
          : null,
    ),
    definePanel("terminal", "terminal", icons.terminal, terminal),
    definePanel("browser", "browser", icons.globe, browser),
    definePanel("workspace", "files", icons.fileText, workspaceContent),
    definePanel(
      "companion",
      "companion",
      icons.messageSquarePlus,
      companion,
      params
        ? html`<openclaw-tooltip .content=${t("chat.rail.clear")}>
            <button
              class="rail-header__action chat-session-rail__clear"
              type="button"
              aria-label=${t("chat.rail.clear")}
              ?disabled=${!params.connected || params.pendingQuestion !== null}
              @click=${params.onClearCompanion}
            >
              ${icons.trash}
            </button>
          </openclaw-tooltip>`
        : undefined,
    ),
    definePanel(
      "tasks",
      "tasks",
      icons.listChecks,
      params?.tasks ?? null,
      params
        ? html`<openclaw-tooltip .content=${t("chat.backgroundTasks.refresh")}>
            <button
              class="rail-header__action chat-tasks-rail__refresh"
              type="button"
              aria-label=${t("chat.backgroundTasks.refresh")}
              ?disabled=${!params.connected || params.tasksLoading}
              @click=${params.onRefreshTasks}
            >
              ${
                params.tasksLoading
                  ? html`<span class="btn__spinner" aria-hidden="true"></span>`
                  : icons.refresh
              }
            </button>
          </openclaw-tooltip>`
        : undefined,
    ),
    definePanel(
      "desktop",
      "desktop",
      icons.monitor,
      desktop,
      panelExternalLink(params?.desktopFocusHref, t("desktop.openWindow")),
    ),
    definePanel(
      "discussion",
      "discussion",
      icons.messageSquare,
      discussion,
      panelExternalLink(params?.discussionOpenUrl, t("chat.sessionDiscussion.openExternal")),
    ),
    definePanel("dashboard", "dashboard", icons.layoutDashboard, params?.dashboard ?? null),
    ...[...pluginPanels].map(([slot, entry]): SidebarPanelDefinition => ({
      slot,
      label: entry?.value.label ?? slot.slice("plugin:".length),
      icon: icons.puzzle,
      available: entry !== undefined,
      content: entry
        ? renderPluginContribution(
            "panels",
            entry.key,
            { sessionKey: state?.sessionKey ?? "", agentId: params?.agentId ?? undefined },
            nothing,
            params?.isPluginPanelPresented(slot),
          )
        : null,
      loading: renderPanelLoadingSkeleton("files", t("common.loading")),
      empty: { description: entry?.value.label ?? t("pluginTabs.unavailableSubtitle") },
    })),
  ];
}

export function availableSidebarSlots(definitions: SidebarPanelDefinition[]): SidebarSlotId[] {
  return definitions
    .filter((definition) => definition.available)
    .map((definition) => definition.slot);
}

export function sidebarPanelTemplates(
  definitions: SidebarPanelDefinition[],
  field: "content" | "headerAction" = "content",
): SidebarPanelTemplates {
  const templates: SidebarPanelTemplates = {};
  for (const definition of definitions) {
    const template = definition[field];
    if (template != null) {
      templates[definition.slot] = template;
    }
  }
  return templates;
}
