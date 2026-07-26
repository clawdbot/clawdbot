import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { SessionAgentStatus } from "../../../packages/gateway-protocol/src/session-icon.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  createQuestionPromptState,
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
  listQuestionPrompts,
  refreshPendingQuestionsWithRetry,
  setQuestionPromptClient,
} from "../app/question-prompt.ts";
import { t } from "../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import {
  SIDEBAR_SESSION_NO_ATTENTION,
  type SidebarKnownSessionAttention,
  type SidebarSessionAttention,
} from "./app-sidebar-session-types.ts";

interface SessionAttentionControllerHost extends ReactiveControllerHost {
  readonly isConnected: boolean;
  readonly sessionAttentionContext: ApplicationContext<RouteId> | undefined;
}

/** Session-scoped question, approval, and failed-run attention ownership. */
export class SessionAttentionController implements ReactiveController {
  private readonly attentionSubscriptions: SubscriptionsController;
  private readonly questionPromptState: ReturnType<typeof createQuestionPromptState>;
  private attentionGateway: ApplicationContext<RouteId>["gateway"] | null = null;
  private attentionGatewayClient: GatewayBrowserClient | null = null;
  private attentionGatewayConnected = false;
  private agentStatusExpiryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private agentStatusExpiryAt: number | null = null;

  constructor(private readonly host: SessionAttentionControllerHost) {
    host.addController(this);
    this.attentionSubscriptions = new SubscriptionsController(host);
    this.questionPromptState = createQuestionPromptState(() => host.requestUpdate());
    this.attentionSubscriptions
      .watch(
        () => host.sessionAttentionContext?.gateway,
        (gateway, notify) => gateway.subscribe(notify),
        (gateway) => this.synchronizeAttentionGateway(gateway),
      )
      .effect(
        () => host.sessionAttentionContext?.gateway,
        (gateway) =>
          gateway.subscribeEvents((event) => {
            handleQuestionPromptEvent(this.questionPromptState, event);
          }),
      )
      .watch(
        () => host.sessionAttentionContext?.overlays,
        (overlays, notify) => overlays.subscribe(notify),
      );
  }

  hostDisconnected(): void {
    this.attentionGateway = null;
    this.attentionGatewayClient = null;
    this.attentionGatewayConnected = false;
    if (this.agentStatusExpiryTimer) {
      globalThis.clearTimeout(this.agentStatusExpiryTimer);
      this.agentStatusExpiryTimer = null;
      this.agentStatusExpiryAt = null;
    }
    disposeQuestionPromptState(this.questionPromptState);
  }

  private synchronizeAttentionGateway(gateway: ApplicationContext<RouteId>["gateway"]) {
    const connected = gateway.snapshot.phase === "connected";
    const client =
      connected &&
      isGatewayMethodAdvertised({ hello: gateway.snapshot.hello }, "question.list") === true &&
      typeof gateway.snapshot.client?.request === "function"
        ? gateway.snapshot.client
        : null;
    if (
      gateway === this.attentionGateway &&
      client === this.attentionGatewayClient &&
      connected === this.attentionGatewayConnected
    ) {
      return;
    }
    this.attentionGateway = gateway;
    this.attentionGatewayClient = client;
    this.attentionGatewayConnected = connected;
    setQuestionPromptClient(this.questionPromptState, client);
    if (client) {
      refreshPendingQuestionsWithRetry(
        this.questionPromptState,
        client,
        () =>
          this.host.isConnected &&
          this.host.sessionAttentionContext?.gateway === gateway &&
          gateway.snapshot.phase === "connected" &&
          gateway.snapshot.client === client,
      );
    }
  }

  resolveSessionAttention(row: GatewaySessionRow): SidebarSessionAttention {
    const knownAttention = this.knownSessionAttention().find((entry) =>
      areUiSessionKeysEquivalent(entry.sessionKey, row.key),
    );
    if (knownAttention) {
      return knownAttention.attention;
    }
    const agentStatus = this.resolveSessionAgentStatus(row);
    if (agentStatus?.attention) {
      return { kind: "agent", note: agentStatus.note, icon: agentStatus.attention };
    }
    if (row.status !== "failed" && row.status !== "timeout") {
      return SIDEBAR_SESSION_NO_ATTENTION;
    }
    const failureAt = row.endedAt ?? row.updatedAt ?? 0;
    if (row.lastReadAt != null && failureAt <= row.lastReadAt) {
      return SIDEBAR_SESSION_NO_ATTENTION;
    }
    const reason =
      row.lastRunError?.trim() ||
      t(
        row.status === "timeout" ? "sessionsView.runErrorTimedOut" : "sessionsView.runErrorUnknown",
      );
    return { kind: "error", reason };
  }

  resolveSessionAgentStatus(row: GatewaySessionRow): SessionAgentStatus | undefined {
    const status = row.agentStatus;
    if (!status || status.expiresAt <= Date.now() || !status.note.trim()) {
      return undefined;
    }
    this.scheduleAgentStatusExpiry(status.expiresAt);
    return status;
  }

  private scheduleAgentStatusExpiry(expiresAt: number): void {
    // The gateway owns expiry; this timer only invalidates an otherwise-idle
    // sidebar so it stops rendering the declaration at the server timestamp.
    if (this.agentStatusExpiryAt !== null && this.agentStatusExpiryAt <= expiresAt) {
      return;
    }
    if (this.agentStatusExpiryTimer) {
      globalThis.clearTimeout(this.agentStatusExpiryTimer);
    }
    this.agentStatusExpiryAt = expiresAt;
    this.agentStatusExpiryTimer = globalThis.setTimeout(
      () => {
        this.agentStatusExpiryTimer = null;
        this.agentStatusExpiryAt = null;
        this.host.requestUpdate();
      },
      Math.max(0, expiresAt - Date.now() + 1),
    );
  }

  knownSessionAttention(): readonly SidebarKnownSessionAttention[] {
    const questions = listQuestionPrompts(this.questionPromptState).flatMap((prompt) =>
      prompt.status === "pending" && prompt.sessionKey !== undefined
        ? [{ sessionKey: prompt.sessionKey, attention: { kind: "question" } as const }]
        : [],
    );
    const approvals = (
      this.host.sessionAttentionContext?.overlays?.snapshot.approvalQueue ?? []
    ).flatMap((approval) =>
      typeof approval.request.sessionKey === "string"
        ? [{ sessionKey: approval.request.sessionKey, attention: { kind: "approval" } as const }]
        : [],
    );
    return [...questions, ...approvals];
  }
}
