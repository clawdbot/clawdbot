import type { ControlUiFocusBuildTarget } from "@openclaw/session-url-contract";
import { html, nothing, type TemplateResult } from "lit";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ControlUiSessionPullRequest } from "../../../../src/gateway/control-ui-contract.js";
import type { ControlUiPanel } from "../../../../src/plugin-sdk/control-ui.js";
import type { BrowserTabSelection } from "../../components/browser/browser-target.ts";
import { icons } from "../../components/icons.ts";
import {
  renderPanelLoadingSkeleton,
  type PanelLoadingSkeletonVariant,
} from "../../components/panel-loading-skeleton.ts";
import { t } from "../../i18n/index.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../../lib/keyboard-shortcut-catalog.ts";
import type { ControlUiRegistration } from "../../plugins/control-ui-capability.ts";
import { renderPluginContribution } from "../../plugins/control-ui-view.ts";
import { resolveAssistantAttachmentAuthToken } from "./chat-pane-state.ts";
import type { ChatSessionCompanionThread } from "./chat-session-companion.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  isSessionWorkspaceItemLoading,
  resolveSessionDiffSidebarContent,
} from "./components/chat-session-workspace.ts";
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
  | "browser"
  | "conversation"
  | "companion"
  | "dashboard"
  | "desktop"
  | "discussion"
  | "files"
  | "review"
  | "tasks"
  | "terminal";

const SIDEBAR_PANEL_LOADING_VARIANTS = {
  browser: "browser",
  conversation: "chat",
  companion: "chat",
  dashboard: "review",
  desktop: "desktop",
  detail: "review",
  discussion: "discussion",
  tasks: "tasks",
  terminal: "terminal",
  workspace: "files",
} satisfies Record<Exclude<SidebarSlotId, `plugin:${string}`>, PanelLoadingSkeletonVariant>;

/** One ordered declaration for every chat side-panel slot. */
export function sidebarPanelDefinitions(
  params?: SidebarPanelDefinitionParams,
): SidebarPanelDefinition[] {
  const state = params?.state;
  // Metadata-only definitions have no pane context, so they describe types without offering tabs.
  const hasPaneContext = params !== undefined;
  const terminalAvailable = state?.terminalAvailable === true;
  const browserAvailable = state?.browserPanelAvailable === true;
  const desktopAvailable = params?.desktopAvailable === true;
  const definePanel = (
    slot: Exclude<SidebarSlotId, `plugin:${string}`>,
    textKey: SidebarPanelTextKey,
    icon: TemplateResult,
    content: TemplateResult | typeof nothing | null,
    options?: { available?: boolean; headerAction?: TemplateResult; shortcut?: string },
  ): SidebarPanelDefinition => ({
    slot,
    label: t(`chat.sidePanel.${textKey}`),
    icon,
    available: options?.available ?? hasPaneContext,
    content,
    loading: renderPanelLoadingSkeleton(SIDEBAR_PANEL_LOADING_VARIANTS[slot], t("common.loading")),
    empty: { description: t(`chat.sidePanel.${textKey}Empty`) },
    ...(options?.headerAction ? { headerAction: options.headerAction } : {}),
    ...(options?.shortcut ? { shortcut: options.shortcut } : {}),
  });
  const terminal =
    state && terminalAvailable
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
  const browser =
    state && browserAvailable
      ? html`<openclaw-browser-panel
          embedded
          data-chat-autotype-exempt
          .client=${state.connected ? state.client : null}
          .available=${state.browserPanelAvailable}
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
    state && desktopAvailable
      ? html`<openclaw-desktop-panel
          embedded
          data-chat-autotype-exempt
          .client=${state.connected ? state.client : null}
          .available=${desktopAvailable}
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
  const detailLoading = state ? isSessionWorkspaceItemLoading(state) : false;
  // The region owns mounting and visibility. Hidden Review tabs must keep the
  // same cached diff loader so their live content and selection survive.
  const detailContent =
    state?.sidebarContent ??
    (state && !detailLoading ? resolveSessionDiffSidebarContent(state) : null);
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
    definePanel("conversation", "conversation", icons.messageSquare, nothing, { available: false }),
    definePanel(
      "detail",
      "review",
      icons.diff,
      detailLoading
        ? renderPanelLoadingSkeleton("review", t("common.loading"))
        : detailContent && params
          ? params.renderDetail(detailContent)
          : null,
    ),
    definePanel("terminal", "terminal", icons.terminal, terminal, {
      available: terminalAvailable,
      shortcut: formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.terminalPanel),
    }),
    definePanel("browser", "browser", icons.globe, browser, { available: browserAvailable }),
    definePanel("workspace", "files", icons.fileText, workspaceContent, {
      shortcut: formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.workspaceFiles),
    }),
    definePanel("companion", "companion", icons.messageSquarePlus, companion, {
      shortcut: formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.sideChat),
      ...(params
        ? {
            headerAction: html`<openclaw-tooltip .content=${t("chat.rail.clear")}>
              <button
                class="rail-header__action chat-session-rail__clear"
                type="button"
                aria-label=${t("chat.rail.clear")}
                ?disabled=${!params.connected || params.pendingQuestion !== null}
                @click=${params.onClearCompanion}
              >
                ${icons.trash}
              </button>
            </openclaw-tooltip>`,
          }
        : {}),
    }),
    definePanel("tasks", "tasks", icons.listChecks, params?.tasks ?? null, {
      headerAction: params
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
    }),
    definePanel("desktop", "desktop", icons.monitor, desktop, {
      available: desktopAvailable,
      ...(params?.desktopFocusHref
        ? {
            headerAction: html`<a
              class="rail-header__action"
              href=${params.desktopFocusHref}
              target="_blank"
              rel="noopener"
              aria-label=${t("desktop.openWindow")}
              title=${t("desktop.openWindow")}
              >${icons.externalLink}</a
            >`,
          }
        : {}),
    }),
    definePanel("discussion", "discussion", icons.messageSquare, discussion, {
      available: discussion !== null && params?.discussionAvailable === true,
      ...(params?.discussionOpenUrl
        ? {
            headerAction: html`<a
              class="rail-header__action"
              href=${params.discussionOpenUrl}
              target="_blank"
              rel="noopener"
              aria-label=${t("chat.sessionDiscussion.openExternal")}
              title=${t("chat.sessionDiscussion.openExternal")}
              >${icons.externalLink}</a
            >`,
          }
        : {}),
    }),
    definePanel("dashboard", "dashboard", icons.layoutDashboard, params?.dashboard ?? null, {
      available: params?.dashboard !== nothing,
    }),
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
): SidebarPanelTemplates {
  const templates: SidebarPanelTemplates = {};
  for (const definition of definitions) {
    if (definition.content !== null) {
      templates[definition.slot] = definition.content;
    }
  }
  return templates;
}

export function sidebarPanelActions(definitions: SidebarPanelDefinition[]): SidebarPanelTemplates {
  const actions: SidebarPanelTemplates = {};
  for (const definition of definitions) {
    if (definition.headerAction) {
      actions[definition.slot] = definition.headerAction;
    }
  }
  return actions;
}
