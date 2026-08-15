import { html, nothing } from "lit";
import type { SessionDiscussionInfo } from "../../../../packages/gateway-protocol/src/index.js";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { ChatPaneSessionMenu } from "./chat-pane-session-menu.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.ts";
import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  activatePanel,
  closeSlot,
  fitSidebarLayout,
  openSlot,
} from "./sidebar-layout.ts";

export abstract class ChatPaneDiscussion extends ChatPaneSessionMenu {
  // Probe once per session activation; transient failures stay uncached so the
  // next activation retries instead of permanently hiding the feature.
  protected async probeSessionDiscussion(sessionKey: string) {
    const state = this.state;
    if (
      !state?.connected ||
      !state.client ||
      this.sessionDiscussionStates.has(sessionKey) ||
      // One in-flight probe per key: a rapid A→B→A switch must not start a
      // second probe whose slower twin could later overwrite the fresh result.
      this.sessionDiscussionProbes.has(sessionKey) ||
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "session.discussion.info") !== true
    ) {
      return;
    }
    const generation = this.connectionGeneration;
    this.sessionDiscussionProbes.add(sessionKey);
    try {
      const info = await state.client.request<SessionDiscussionInfo>("session.discussion.info", {
        sessionKey,
        agentId: resolveChatAgentId(state),
      });
      // A reconnect supersedes in-flight probes; a stale result must not
      // overwrite the new source's cache (e.g. an old "none" hiding the action).
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.sessionDiscussionStates.set(sessionKey, info.state);
      this.requestUpdate();
    } catch {
      // Leave unprobed: the action stays hidden and a later switch retries.
    } finally {
      this.sessionDiscussionProbes.delete(sessionKey);
      // A reconnect during this probe skipped its own probe (the key was
      // still held here); retry now so the new source gets a fresh answer.
      if (
        generation !== this.connectionGeneration &&
        this.state?.sessionKey === sessionKey &&
        !this.sessionDiscussionStates.has(sessionKey)
      ) {
        void this.probeSessionDiscussion(sessionKey);
      }
    }
  }

  protected buildSessionDiscussionPanel(
    state: NonNullable<typeof this.state>,
    sessionKey: string,
  ): SessionDiscussionPanelConfig | null {
    if (!state.connected || !state.client) {
      return null;
    }
    const canOpen =
      hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "session.discussion.open") === true;
    const contentGeneration = this.connectionGeneration;
    const cached = this.sessionDiscussionPanels.get(sessionKey);
    if (cached?.generation === contentGeneration && cached.canOpen === canOpen) {
      cached.config.openUrl = this.sessionDiscussionOpenUrls.get(sessionKey) ?? null;
      return cached.config;
    }
    const config: SessionDiscussionPanelConfig = {
      sessionKey,
      canOpen,
      openUrl: this.sessionDiscussionOpenUrls.get(sessionKey) ?? null,
      loadInfo: async (key) => {
        if (!state.connected || !state.client) {
          throw new Error(t("chat.sessionDiscussion.disconnected"));
        }
        return await state.client.request<SessionDiscussionInfo>("session.discussion.info", {
          sessionKey: key,
          agentId: resolveChatAgentId(state),
        });
      },
      openDiscussion: async (key) => {
        if (!state.connected || !state.client) {
          throw new Error(t("chat.sessionDiscussion.disconnected"));
        }
        return await state.client.request<SessionDiscussionInfo>("session.discussion.open", {
          sessionKey: key,
          agentId: resolveChatAgentId(state),
        });
      },
      onStateChange: (key, discussionState, openUrl) => {
        // Panels created under a previous connection may report late; their
        // state belongs to the old provider and must not touch the new cache.
        if (contentGeneration !== this.connectionGeneration) {
          return;
        }
        this.sessionDiscussionStates.set(key, discussionState);
        const isCurrentSession = state.sessionKey.trim() === key;
        if (isCurrentSession) {
          this.sessionDiscussionOpenUrls.set(key, openUrl);
        }
        if (discussionState === "none") {
          this.sessionDiscussionOpenUrls.delete(key);
        }
        if (discussionState === "none" && isCurrentSession) {
          state.updateSidebarLayout(closeSlot(state.sidebarLayout, "discussion"));
          return;
        }
        state.requestUpdate();
      },
    };
    this.sessionDiscussionPanels.set(sessionKey, {
      generation: contentGeneration,
      canOpen,
      config,
    });
    return config;
  }

  protected openSessionDiscussionSlot(): boolean {
    const state = this.state;
    if (!state) {
      return false;
    }
    let opened = openSlot(state.sidebarLayout, "discussion", "right");
    const discussionPanel = opened.columns
      .flatMap((column) => column.panels)
      .find((panel) => panel.slot === "discussion");
    if (discussionPanel) {
      opened = activatePanel(opened, discussionPanel.id);
    }
    const newColumn = opened.columns.find(
      (column) => !state.sidebarLayout.columns.some((current) => current.id === column.id),
    );
    const fitted =
      this.paneWidth >= SIDEBAR_NARROW_BREAKPOINT_PX
        ? (fitSidebarLayout(opened, this.paneWidth, newColumn?.id) ?? opened)
        : opened;
    state.updateSidebarLayout(fitted);
    if (discussionPanel) {
      state.updateSidebarActivePanel(discussionPanel.id);
    }
    return true;
  }

  protected resolveSessionDiscussionAction(): {
    active: boolean;
    label: string;
    onToggle: () => void;
  } | null {
    const state = this.state;
    const sessionKey = state?.sessionKey.trim() ?? "";
    const known = sessionKey ? this.sessionDiscussionStates.get(sessionKey) : undefined;
    if (
      !state?.connected ||
      !state.client ||
      !sessionKey ||
      known === undefined ||
      known === "none" ||
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "session.discussion.info") !== true
    ) {
      return null;
    }
    if (!this.buildSessionDiscussionPanel(state, sessionKey)) {
      return null;
    }
    const active = state.sidebarLayout.columns.some((column) =>
      column.panels.some((panel) => panel.slot === "discussion"),
    );
    const label = t(active ? "chat.sessionDiscussion.hide" : "chat.sessionDiscussion.show");
    return {
      active,
      label,
      onToggle: () =>
        active
          ? state.updateSidebarLayout(closeSlot(state.sidebarLayout, "discussion"))
          : this.openSessionDiscussionSlot(),
    };
  }

  protected renderSessionDiscussionAction(action = this.resolveSessionDiscussionAction()) {
    if (!action) {
      return nothing;
    }
    return html`
      <openclaw-tooltip .content=${action.label}>
        <button
          class="btn btn--ghost btn--icon chat-icon-btn chat-session-discussion-toggle"
          type="button"
          aria-label=${action.label}
          aria-pressed=${String(action.active)}
          @click=${action.onToggle}
        >
          ${icons.messageSquare}
        </button>
      </openclaw-tooltip>
    `;
  }
}
