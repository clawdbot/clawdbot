import { html, nothing, type TemplateResult } from "lit";
import type { ProgressCard } from "../../../../packages/gateway-protocol/src/schema/progress-card.js";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ControlUiSessionPullRequest } from "../../../../src/gateway/control-ui-contract.js";
import { desktopFocusPath } from "../../components/desktop/desktop-focus-window.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../../lib/keyboard-shortcut-catalog.ts";
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
  desktopPresented: boolean;
  desktopRefreshOnPresentation: boolean;
  desktopAvailable: boolean;
  hasBoard: boolean;
  chat: TemplateResult;
  workspace: TemplateResult | typeof nothing;
  tasks: TemplateResult | typeof nothing;
  detailOpen: boolean;
  renderDetail: (content: SidebarContent) => TemplateResult;
  digest: SessionObserverDigest | null;
  activeRunId: string | null;
  startedAt: number | undefined;
  lastReadAt: number | undefined;
  pullRequests: ControlUiSessionPullRequest[];
  progressCard: ProgressCard | null;
  onDismissProgressCard?: (card: ProgressCard) => void;
  companion: ChatSessionCompanionThread;
  onCompanionSubmit: (question: string) => void;
  onCompanionDraftChange: (draft: string) => void;
  onCompanionVisibilityChange: (visible: boolean) => void;
  connected: boolean;
  pendingQuestion: string | null;
  onClearCompanion: () => void;
  discussion: SessionDiscussionPanelConfig | null;
  discussionOpenUrl: string | null;
  discussionSourceGeneration: number;
};

type SidebarPanelTextKey =
  | "boardChat"
  | "browser"
  | "companion"
  | "desktop"
  | "discussion"
  | "files"
  | "review"
  | "tasks"
  | "terminal";

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
  const desktopFocusHref = state ? desktopFocusPath(state.basePath) : null;
  const definePanel = (
    slot: SidebarSlotId,
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
        .progressCard=${params.progressCard}
        .onDismissProgressCard=${params.onDismissProgressCard}
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
  const detailContent =
    state?.sidebarContent ??
    (state && params?.detailOpen ? resolveSessionDiffSidebarContent(state) : null);
  const workspaceContent =
    attachmentContent && params
      ? params.renderDetail(attachmentContent)
      : (params?.workspace ?? null);
  return [
    definePanel(
      "detail",
      "review",
      icons.diff,
      detailContent && params ? params.renderDetail(detailContent) : null,
    ),
    definePanel("terminal", "terminal", icons.terminal, terminal, {
      available: terminalAvailable,
      shortcut: formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.terminalPanel),
    }),
    definePanel("browser", "browser", icons.globe, browser, { available: browserAvailable }),
    definePanel("workspace", "files", icons.fileText, workspaceContent, {
      shortcut: formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.workspaceFiles),
    }),
    definePanel(
      "companion",
      "companion",
      icons.bot,
      companion,
      params
        ? {
            headerAction: html`<wa-dropdown
              class="chat-session-rail__menu"
              placement="bottom-end"
              @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
                if (event.detail.item.value === "clear") {
                  params.onClearCompanion();
                }
              }}
            >
              <button
                slot="trigger"
                class="rail-header__action"
                type="button"
                aria-label=${t("chat.rail.moreActions")}
                aria-haspopup="menu"
                aria-expanded="false"
              >
                ${icons.moreHorizontal}
              </button>
              <wa-dropdown-item
                value="clear"
                ?disabled=${!params.connected || params.pendingQuestion !== null}
              >
                ${t("chat.rail.clear")}
              </wa-dropdown-item>
            </wa-dropdown>`,
          }
        : undefined,
    ),
    definePanel("tasks", "tasks", icons.listChecks, params?.tasks ?? null),
    definePanel("desktop", "desktop", icons.monitor, desktop, {
      available: desktopAvailable,
      ...(desktopFocusHref
        ? {
            headerAction: html`<a
              class="rail-header__action"
              href=${desktopFocusHref}
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
      available: discussion !== null,
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
    definePanel("chat", "boardChat", icons.messageSquare, params?.chat ?? null, {
      available: params?.hasBoard === true,
    }),
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
