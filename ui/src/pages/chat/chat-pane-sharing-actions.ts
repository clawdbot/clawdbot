import { buildControlUiPublicSessionSharePath } from "@openclaw/session-url-contract/public-share";
import type { SessionPublicShareSetResult } from "../../../../packages/gateway-protocol/src/index.js";
import type {
  GatewaySessionRow,
  SessionMembersListEvidenceResult as SessionSharingResult,
  SessionVisibility,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import {
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { ChatPaneBase } from "./chat-pane-base.ts";
import type { ChatPaneConnectionScope } from "./chat-pane-shared.ts";
import { resetSessionCompanion } from "./chat-session-companion.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import {
  canManageChatSessionSharing,
  type ChatSessionSharingState,
} from "./components/chat-session-sharing.ts";

type HeaderScope = ChatPaneConnectionScope;
const SESSION_MEMBERS_LIST_METHOD = "session.members.listEvidence";

export abstract class ChatPaneSharingActions extends ChatPaneBase {
  protected readonly clearSessionCompanion = async () => {
    const scope = this.captureConnectionScope();
    const key = scope?.state.sessionKey;
    if (!scope || !key) {
      return;
    }
    const agentId = resolveChatAgentId(scope.state);
    await this.sessionCompanionThreads
      .reset(key, (sessionKey) => resetSessionCompanion(scope.client, sessionKey, agentId), agentId)
      .catch((error: unknown) => {
        if (
          this.presented &&
          this.isConnectionScopeCurrent(scope) &&
          scope.state.sessionKey === key
        ) {
          this.publishHeaderError(error);
        }
      });
  };

  protected setSessionSharingState(cacheKey: string, state: ChatSessionSharingState): void {
    this.sessionSharingStates = new Map(this.sessionSharingStates).set(cacheKey, state);
  }

  protected sessionSharingAgentId(sessionKey: string): string | undefined {
    if (sessionKey !== "global") {
      return parseAgentSessionKey(sessionKey)?.agentId;
    }
    return this.state ? resolveChatAgentId(this.state) : undefined;
  }

  protected sessionSharingCacheKey(sessionKey: string): string {
    return `${this.sessionSharingAgentId(sessionKey) ?? ""}\0${sessionKey}`;
  }

  protected currentSessionSharingRow(
    scope: ChatPaneConnectionScope,
    row: GatewaySessionRow,
  ): GatewaySessionRow | null {
    const current = scope.state.sessionsResult?.sessions.find((candidate) =>
      areUiSessionKeysEquivalent(candidate.key, row.key),
    );
    if (!current || !canManageChatSessionSharing(row) || !canManageChatSessionSharing(current)) {
      return null;
    }
    if (current === row) {
      return current;
    }
    const rowSessionId = row.sessionId?.trim();
    const currentSessionId = current.sessionId?.trim();
    return rowSessionId && currentSessionId && rowSessionId === currentSessionId ? current : null;
  }

  protected async loadSessionSharing(row: GatewaySessionRow, force = false): Promise<void> {
    const scope = this.captureConnectionScope();
    const currentRow = scope ? this.currentSessionSharingRow(scope, row) : null;
    if (
      !scope ||
      !currentRow ||
      !readSessionMethodAccess(scope.context.gateway.snapshot, {
        method: SESSION_MEMBERS_LIST_METHOD,
        requiredScope: "operator.read",
      }).allowed
    ) {
      return;
    }
    const cacheKey = this.sessionSharingCacheKey(currentRow.key);
    const current = this.sessionSharingStates.get(cacheKey);
    if (current?.loading && !force) {
      return;
    }
    // Sharing data (membership + paired identities) is connection-scoped. A
    // gateway/account change bumps the generation and clears this cache, so a
    // request that resolves after the switch must be dropped rather than
    // overwrite the new connection's menu with the previous account's data.
    // Object identity also owns this key's request slot: same-key session
    // replacement or a forced reload must not let an older request win.
    const loadingState = { ...current, loading: true, error: undefined };
    const ownsLoadingState = () => this.sessionSharingStates.get(cacheKey) === loadingState;
    const clearOwnedLoadingState = () => {
      if (!ownsLoadingState()) {
        return;
      }
      const next = new Map(this.sessionSharingStates);
      next.delete(cacheKey);
      this.sessionSharingStates = next;
    };
    this.setSessionSharingState(cacheKey, loadingState);
    try {
      const result = await scope.client.request<SessionSharingResult>(SESSION_MEMBERS_LIST_METHOD, {
        sessionKey: currentRow.key,
        ...(this.sessionSharingAgentId(currentRow.key)
          ? { agentId: this.sessionSharingAgentId(currentRow.key) }
          : {}),
      });
      if (
        !this.ownsHeaderOutcomeScope(scope) ||
        !this.currentSessionSharingRow(scope, currentRow) ||
        !ownsLoadingState()
      ) {
        if (this.isConnectionScopeCurrent(scope)) {
          clearOwnedLoadingState();
        }
        return;
      }
      this.setSessionSharingState(cacheKey, { loading: false, result });
    } catch (error) {
      if (
        !this.ownsHeaderOutcomeScope(scope) ||
        !this.currentSessionSharingRow(scope, currentRow) ||
        !ownsLoadingState()
      ) {
        if (this.isConnectionScopeCurrent(scope)) {
          clearOwnedLoadingState();
        }
        return;
      }
      this.setSessionSharingState(cacheKey, { loading: false, error: formatUiError(error) });
    }
  }

  protected failSharing(scope: HeaderScope, key: string, session: string, error: unknown): void {
    if (!this.ownsHeaderOutcomeScope(scope)) {
      return;
    }
    this.setSessionSharingState(key, {
      ...(this.sessionSharingStates.get(key) ?? { loading: false }),
      loading: false,
      error: formatUiError(error),
    });
    // Sharing errors stay with their session; the visible slot belongs only to the selected session.
    if (areUiSessionKeysEquivalent(this.state?.sessionKey, session)) {
      this.publishHeaderError(error, scope.headerOutcomeOwner);
    }
  }

  protected async setSessionPublicShare(row: GatewaySessionRow, enabled: boolean): Promise<void> {
    const scope = this.captureConnectionScope();
    const currentRow = scope ? this.currentSessionSharingRow(scope, row) : null;
    const expectedSessionId = currentRow?.sessionId;
    if (!scope || !currentRow || !expectedSessionId) {
      return;
    }
    const access = () =>
      readSessionMethodAccess(scope.context.gateway.snapshot, {
        method: "session.publicShare.set",
        requiredScope: "operator.write",
      }).allowed;
    const isCurrent = () =>
      this.ownsHeaderOutcomeScope(scope) &&
      this.currentSessionSharingRow(scope, currentRow)?.sessionId === expectedSessionId &&
      areUiSessionKeysEquivalent(scope.state.sessionKey, currentRow.key);
    const cacheKey = this.sessionSharingCacheKey(currentRow.key);
    const previous = this.sessionSharingStates.get(cacheKey);
    if (!access() || !isCurrent() || previous?.loading) {
      return;
    }
    const pending = { ...previous, loading: true, error: undefined };
    this.setSessionSharingState(cacheKey, pending);
    try {
      if (enabled) {
        const { showConfirmDialog } = await import("../../components/confirm-dialog.ts");
        if (!isCurrent() || !access()) {
          return;
        }
        const confirmed = await showConfirmDialog({
          title: t("chat.sessionSharing.publicConfirmTitle"),
          message: t("chat.sessionSharing.publicConfirmMessage"),
          confirmLabel: t("chat.sessionSharing.publicConfirmEnable"),
          danger: true,
        });
        if (!confirmed) {
          return;
        }
      }
      // Confirmation can outlive a route, connection, or exact session instance.
      // Never publish a replacement session under the previous consent.
      if (!isCurrent() || !access()) {
        return;
      }
      const result = await scope.client.request<SessionPublicShareSetResult>(
        "session.publicShare.set",
        {
          sessionKey: currentRow.key,
          agentId: this.sessionSharingAgentId(currentRow.key),
          expectedSessionId,
          enabled,
        },
      );
      if (!isCurrent()) {
        this.sessionSharingHydrationTargets.delete(cacheKey);
        return;
      }
      this.setSessionSharingState(cacheKey, {
        loading: false,
        ...(previous?.result
          ? { result: { ...previous.result, publicShare: result.publicShare } }
          : {}),
      });
      showToast({
        message: t(
          enabled ? "chat.sessionSharing.publicEnabled" : "chat.sessionSharing.publicDisabled",
        ),
      });
      await this.loadSessionSharing(currentRow, true);
    } catch (error) {
      if (isCurrent()) {
        this.failSharing(scope, cacheKey, currentRow.key, error);
      }
    } finally {
      if (this.sessionSharingStates.get(cacheKey) === pending) {
        this.setSessionSharingState(cacheKey, { ...previous, loading: false });
      }
    }
  }

  protected async copySessionPublicLink(row: GatewaySessionRow): Promise<void> {
    const scope = this.captureConnectionScope();
    const currentRow = scope ? this.currentSessionSharingRow(scope, row) : null;
    if (!scope || !currentRow) {
      return;
    }
    const share = this.sessionSharingStates.get(this.sessionSharingCacheKey(row.key))?.result
      ?.publicShare;
    const expectedSessionId = currentRow.sessionId;
    if (!share || !expectedSessionId) {
      return;
    }
    const isCurrent = () =>
      this.ownsHeaderOutcomeScope(scope) &&
      this.currentSessionSharingRow(scope, currentRow)?.sessionId === expectedSessionId;
    try {
      const gateway = scope.context.gateway;
      const controlUiUrl = gateway.snapshot.hello?.controlUiUrl;
      const linkBase = controlUiUrl ?? scope.client.gatewayUrl ?? gateway.connection.gatewayUrl;
      const url = new URL(linkBase || window.location.href);
      url.protocol = url.protocol.replace(/^ws/u, "http");
      const path = buildControlUiPublicSessionSharePath({
        basePath: controlUiUrl ? url.pathname : scope.context.basePath,
        token: share.token,
      });
      const copied = await copyToClipboard(new URL(path, url.origin).href, isCurrent);
      if (isCurrent()) {
        showToast({ message: t(copied ? "common.copied" : "common.copyFailed") });
      }
    } catch (error) {
      if (isCurrent()) {
        this.publishHeaderError(error);
      }
    }
  }

  protected async setSessionVisibility(
    row: GatewaySessionRow,
    visibility: SessionVisibility,
  ): Promise<void> {
    const scope = this.captureConnectionScope();
    const currentRow = scope ? this.currentSessionSharingRow(scope, row) : null;
    if (!scope || !currentRow || visibility === currentRow.visibility) {
      return;
    }
    const agentId = this.sessionSharingAgentId(currentRow.key);
    const cacheKey = this.sessionSharingCacheKey(currentRow.key);
    const params = {
      sessionKey: currentRow.key,
      visibility,
      ...(agentId ? { agentId } : {}),
    };
    if (
      !readSessionMethodAccess(scope.context.gateway.snapshot, {
        method: "session.visibility.set",
        requiredScope: "operator.write",
      }).allowed
    ) {
      return;
    }
    try {
      await scope.client.request("session.visibility.set", params);
      if (
        !this.ownsHeaderOutcomeScope(scope) ||
        !this.currentSessionSharingRow(scope, currentRow)
      ) {
        return;
      }
      await scope.sessions.refreshReplacement(agentId);
      const refreshedRow = this.currentSessionSharingRow(scope, currentRow);
      if (!this.ownsHeaderOutcomeScope(scope) || !refreshedRow) {
        return;
      }
      await this.loadSessionSharing(refreshedRow, true);
    } catch (error) {
      if (
        !this.ownsHeaderOutcomeScope(scope) ||
        !this.currentSessionSharingRow(scope, currentRow)
      ) {
        return;
      }
      this.failSharing(scope, cacheKey, currentRow.key, error);
    }
  }

  protected async setSessionMember(
    row: GatewaySessionRow,
    identityId: string,
    member: boolean,
  ): Promise<void> {
    const scope = this.captureConnectionScope();
    const currentRow = scope ? this.currentSessionSharingRow(scope, row) : null;
    if (!scope || !currentRow) {
      return;
    }
    const agentId = this.sessionSharingAgentId(currentRow.key);
    const cacheKey = this.sessionSharingCacheKey(currentRow.key);
    const method = member ? "session.members.add" : "session.members.remove";
    const params = {
      sessionKey: currentRow.key,
      identityId,
      ...(agentId ? { agentId } : {}),
    };
    if (
      !readSessionMethodAccess(scope.context.gateway.snapshot, {
        method,
        requiredScope: "operator.write",
      }).allowed
    ) {
      return;
    }
    try {
      await scope.client.request(method, params);
      if (
        !this.ownsHeaderOutcomeScope(scope) ||
        !this.currentSessionSharingRow(scope, currentRow)
      ) {
        return;
      }
      await this.loadSessionSharing(currentRow, true);
      if (
        !this.ownsHeaderOutcomeScope(scope) ||
        !this.currentSessionSharingRow(scope, currentRow)
      ) {
        return;
      }
      await scope.sessions.refreshReplacement(agentId);
    } catch (error) {
      if (
        !this.ownsHeaderOutcomeScope(scope) ||
        !this.currentSessionSharingRow(scope, currentRow)
      ) {
        return;
      }
      this.failSharing(scope, cacheKey, currentRow.key, error);
    }
  }

  protected captureConnectionScope(): ChatPaneConnectionScope | null {
    const state = this.state;
    if (!state?.client) {
      return null;
    }
    const scope = {
      context: this.context,
      state,
      client: state.client,
      generation: this.connectionGeneration,
      headerOutcomeOwner: this.headerOutcomeOwner,
      sessions: this.context.sessions,
    };
    return this.isConnectionScopeCurrent(scope) ? scope : null;
  }

  protected isConnectionScopeCurrent(scope: ChatPaneConnectionScope): boolean {
    return (
      this.isConnected &&
      this.context === scope.context &&
      this.state === scope.state &&
      scope.state.connected &&
      scope.state.client === scope.client &&
      this.connectedClient === scope.client &&
      scope.context.gateway.snapshot.phase === "connected" &&
      scope.context.gateway.snapshot.client === scope.client &&
      this.connectionGeneration === scope.generation
    );
  }

  protected ownsHeaderOutcomeScope(scope: HeaderScope): boolean {
    return this.isConnectionScopeCurrent(scope) && this.ownsHeaderOutcome(scope.headerOutcomeOwner);
  }
}
