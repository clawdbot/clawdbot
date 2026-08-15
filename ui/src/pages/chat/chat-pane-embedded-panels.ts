import { html } from "lit";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ControlUiSessionPullRequest } from "../../../../src/gateway/control-ui-contract.js";
import { resolveAssistantAttachmentAuthToken } from "./chat-pane-state.ts";
import type { ChatSessionCompanionThread } from "./chat-session-companion.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { SidebarPanelTemplates } from "./components/chat-sidebar-region-types.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.ts";
import type { SidebarSlotId } from "./sidebar-layout-types.ts";

/**
 * Templates for the gateway-backed surfaces embedded in the side panel.
 * Each surface appears only while its capability is advertised, so a closed
 * tab can never reopen into a dead panel.
 */
export function embeddedSurfaceTemplates(params: {
  state: ChatPageHost;
  agentId: string | null;
  desktopAvailable: boolean;
  deferTerminalRestore: boolean;
}): Partial<SidebarPanelTemplates> {
  const { state } = params;
  return {
    ...(state.terminalAvailable
      ? {
          terminal: html`<openclaw-terminal-panel
            embedded
            .deferInitialRestore=${params.deferTerminalRestore}
            .client=${state.connected ? state.client : null}
            .available=${state.terminalAvailable}
            .agentId=${params.agentId}
            .themeMode=${document.documentElement.dataset.theme === "light" ? "light" : "dark"}
            .basePath=${state.basePath}
          ></openclaw-terminal-panel>`,
        }
      : {}),
    ...(state.browserPanelAvailable
      ? {
          browser: html`<openclaw-browser-panel
            embedded
            data-chat-autotype-exempt
            .client=${state.connected ? state.client : null}
            .available=${state.browserPanelAvailable}
            .basePath=${state.basePath}
            .authToken=${resolveAssistantAttachmentAuthToken(state)}
          ></openclaw-browser-panel>`,
        }
      : {}),
    ...(params.desktopAvailable
      ? {
          desktop: html`<openclaw-desktop-panel
            embedded
            data-chat-autotype-exempt
            .client=${state.connected ? state.client : null}
            .available=${params.desktopAvailable}
          ></openclaw-desktop-panel>`,
        }
      : {}),
  };
}

/** Side-chat companion rail, embedded as a regular side-panel tab. */
export function companionRailTemplate(params: {
  state: ChatPageHost;
  digest: SessionObserverDigest | null;
  activeRunId: string | null;
  startedAt: number | undefined;
  lastReadAt: number | undefined;
  pullRequests: ControlUiSessionPullRequest[];
  companion: ChatSessionCompanionThread;
  onSubmit: (question: string) => void;
  onDraftChange: (draft: string) => void;
  onClear: () => void;
  onVisibilityChange: (visible: boolean) => void;
}) {
  const { state } = params;
  return html`<openclaw-chat-session-rail
    embedded
    .sessionKey=${state.sessionKey}
    .digest=${params.digest}
    .running=${Boolean(params.activeRunId)}
    .activeRunId=${params.activeRunId}
    .startedAt=${params.startedAt}
    .lastReadAt=${params.lastReadAt}
    .planStatus=${state.planStatus ?? null}
    .pullRequests=${params.pullRequests}
    .companion=${params.companion}
    .connected=${state.connected}
    .onSubmit=${params.onSubmit}
    .onDraftChange=${params.onDraftChange}
    .onClear=${params.onClear}
    .onVisibilityChange=${params.onVisibilityChange}
  ></openclaw-chat-session-rail>`;
}

/** Discussion tab template; absent while the session has no discussion. */
export function discussionPanelTemplate(
  discussion: SessionDiscussionPanelConfig | null,
  sourceGeneration: number,
): Partial<SidebarPanelTemplates> {
  if (!discussion) {
    return {};
  }
  return {
    discussion: html`<openclaw-session-discussion
      .sessionKey=${discussion.sessionKey}
      .canOpen=${discussion.canOpen}
      .sourceGeneration=${sourceGeneration}
      .loadInfo=${discussion.loadInfo}
      .openDiscussion=${discussion.openDiscussion}
      .onStateChange=${discussion.onStateChange}
    ></openclaw-session-discussion>`,
  };
}

/** Slot order for the add-tab menu; capability-gated surfaces are hidden. */
export function availableSidebarSlots(params: {
  state: ChatPageHost;
  desktopAvailable: boolean;
  hasDiscussion: boolean;
  hasBoard: boolean;
}): SidebarSlotId[] {
  return [
    "detail",
    ...(params.state.terminalAvailable ? (["terminal"] as const) : []),
    ...(params.state.browserPanelAvailable ? (["browser"] as const) : []),
    "workspace",
    "companion",
    "tasks",
    ...(params.desktopAvailable ? (["desktop"] as const) : []),
    ...(params.hasDiscussion ? (["discussion"] as const) : []),
    ...(params.hasBoard ? (["chat"] as const) : []),
  ];
}
