import { html, nothing, type TemplateResult } from "lit";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ControlUiSessionPullRequest } from "../../../../src/gateway/control-ui-contract.js";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { resolveAssistantAttachmentAuthToken } from "./chat-pane-state.ts";
import type { ChatSessionCompanionThread } from "./chat-session-companion.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type {
  SidebarPanelDefinition,
  SidebarPanelTemplates,
} from "./components/chat-sidebar-region-types.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.ts";
import type { SidebarSlotId } from "./sidebar-layout-types.ts";

type SidebarPanelDefinitionParams = {
  state: ChatPageHost;
  agentId: string | null;
  desktopAvailable: boolean;
  hasBoard: boolean;
  chat: TemplateResult;
  workspace: TemplateResult | typeof nothing;
  tasks: TemplateResult | typeof nothing;
  detail: TemplateResult | null;
  digest: SessionObserverDigest | null;
  activeRunId: string | null;
  startedAt: number | undefined;
  lastReadAt: number | undefined;
  pullRequests: ControlUiSessionPullRequest[];
  companion: ChatSessionCompanionThread;
  onCompanionSubmit: (question: string) => void;
  onCompanionDraftChange: (draft: string) => void;
  onCompanionVisibilityChange: (visible: boolean) => void;
  discussion: SessionDiscussionPanelConfig | null;
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

/**
 * Header actions contributed by the panels that own content actions. Panels
 * have no header of their own in the tabbed model, so anything acting on the
 * active panel — the destructive side-chat clear, the discussion's external
 * link — is only reachable through the shared side-panel header.
 */
export function sidePanelHeaderActions(params: {
  connected: boolean;
  pendingQuestion: string | null;
  discussionOpenUrl: string | null;
  onClearCompanion: () => void;
}): SidebarPanelTemplates {
  return {
    ...(params.discussionOpenUrl
      ? {
          discussion: html`<a
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
    companion: html`<wa-dropdown
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
  };
}

/** One ordered declaration for every chat side-panel slot. */
export function sidebarPanelDefinitions(
  params?: SidebarPanelDefinitionParams,
): SidebarPanelDefinition[] {
  const state = params?.state;
  const terminalAvailable = state?.terminalAvailable === true;
  const browserAvailable = state?.browserPanelAvailable === true;
  const desktopAvailable = params?.desktopAvailable === true;
  const definePanel = (
    slot: SidebarSlotId,
    textKey: SidebarPanelTextKey,
    icon: TemplateResult,
    content: TemplateResult | typeof nothing | null,
    options?: { available?: boolean; shortcut?: string },
  ): SidebarPanelDefinition => ({
    slot,
    label: t(`chat.sidePanel.${textKey}`),
    icon,
    available: options?.available ?? params !== undefined,
    content,
    empty: { description: t(`chat.sidePanel.${textKey}Empty`) },
    ...(options?.shortcut ? { shortcut: options.shortcut } : {}),
  });
  const terminal =
    state && terminalAvailable
      ? html`<openclaw-terminal-panel
          embedded
          .client=${state.connected ? state.client : null}
          .available=${state.terminalAvailable}
          .agentId=${params?.agentId ?? null}
          .themeMode=${document.documentElement.dataset.theme === "light" ? "light" : "dark"}
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
          .basePath=${state.basePath}
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
        .planStatus=${state?.planStatus ?? null}
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
  return [
    definePanel("detail", "review", icons.diff, params?.detail ?? null),
    definePanel("terminal", "terminal", icons.terminal, terminal, {
      available: terminalAvailable,
      shortcut: "Ctrl+`",
    }),
    definePanel("browser", "browser", icons.globe, browser, { available: browserAvailable }),
    definePanel("workspace", "files", icons.fileText, params?.workspace ?? null, {
      shortcut: "⇧⌘B",
    }),
    definePanel("companion", "companion", icons.bot, companion),
    definePanel("tasks", "tasks", icons.listChecks, params?.tasks ?? null),
    definePanel("desktop", "desktop", icons.monitor, desktop, { available: desktopAvailable }),
    definePanel("discussion", "discussion", icons.messageSquare, discussion, {
      available: discussion !== null,
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
