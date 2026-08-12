/** Gateway disconnect grace period and pending-prompt reconciliation. */
import type { StopReason } from "@agentclientprotocol/sdk";
import type { GatewayClient } from "../gateway/client.js";
import type {
  AcpAgentWaitResult,
  AcpDisconnectContext,
  AcpPendingPrompt,
} from "./translator.prompt-state.js";

const ACP_GATEWAY_DISCONNECT_GRACE_MS = 5_000;
const ACP_GATEWAY_ACCEPTED_PROMPT_RECOVERY_GRACE_MS = 60_000;

type DisconnectDeadline = "initial" | "accepted-recovery";

export class AcpTranslatorDisconnects {
  private disconnectTimer: NodeJS.Timeout | null = null;
  private activeDisconnectContext: AcpDisconnectContext | null = null;
  private disconnectGeneration = 0;

  constructor(
    private readonly gateway: GatewayClient,
    private readonly pendingPrompts: Map<string, AcpPendingPrompt>,
    private readonly getPendingPrompt: (
      sessionId: string,
      runId: string,
    ) => AcpPendingPrompt | undefined,
    private readonly finishPrompt: (
      sessionId: string,
      pending: AcpPendingPrompt,
      stopReason: StopReason,
    ) => Promise<void>,
    private readonly rejectPendingPrompt: (
      pending: AcpPendingPrompt,
      error: Error,
      options?: { recordDisconnectNotice?: boolean },
    ) => Promise<void>,
    private readonly log: (msg: string) => void,
  ) {}

  get activeContext(): AcpDisconnectContext | null {
    return this.activeDisconnectContext;
  }

  shutdown(): void {
    this.activeDisconnectContext = null;
    this.clearDisconnectTimer();
  }

  handleGatewayReconnect(reconnectReady: Promise<unknown> = Promise.resolve()): void {
    this.log("gateway reconnected");
    const disconnectContext = this.activeDisconnectContext;
    this.activeDisconnectContext = null;
    if (!disconnectContext) {
      return;
    }
    void reconnectReady.then(() => this.reconcilePendingPrompts(disconnectContext.generation));
  }

  handleGatewayDisconnect(reason: string): void {
    this.log(`gateway disconnected: ${reason}`);
    const disconnectContext = {
      generation: this.disconnectGeneration + 1,
      reason,
    };
    this.disconnectGeneration = disconnectContext.generation;
    this.activeDisconnectContext = disconnectContext;
    if (this.pendingPrompts.size === 0) {
      return;
    }
    for (const pending of this.pendingPrompts.values()) {
      pending.disconnectContext = disconnectContext;
    }
    this.armDisconnectTimer(disconnectContext);
  }

  armForActiveContext(): void {
    if (this.activeDisconnectContext && !this.disconnectTimer) {
      this.armDisconnectTimer(this.activeDisconnectContext);
    }
  }

  clearWhenIdle(): void {
    if (this.pendingPrompts.size === 0) {
      this.clearDisconnectTimer();
    }
  }

  private clearDisconnectTimer(): void {
    if (!this.disconnectTimer) {
      return;
    }
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  private armDisconnectTimer(
    disconnectContext: AcpDisconnectContext,
    deadline: DisconnectDeadline = "initial",
  ): void {
    this.clearDisconnectTimer();
    this.disconnectTimer = setTimeout(
      () => {
        this.disconnectTimer = null;
        void this.reconcilePendingPrompts(disconnectContext.generation, deadline);
      },
      deadline === "initial"
        ? ACP_GATEWAY_DISCONNECT_GRACE_MS
        : ACP_GATEWAY_ACCEPTED_PROMPT_RECOVERY_GRACE_MS - ACP_GATEWAY_DISCONNECT_GRACE_MS,
    );
    this.disconnectTimer.unref?.();
  }

  private shouldRejectPendingAtDisconnectDeadline(
    pending: AcpPendingPrompt,
    disconnectContext: AcpDisconnectContext,
    deadline: DisconnectDeadline,
  ): boolean {
    return (
      pending.disconnectContext === disconnectContext &&
      (!pending.sendAccepted || deadline === "accepted-recovery")
    );
  }

  private async reconcilePendingPrompts(
    observedDisconnectGeneration: number,
    deadline?: DisconnectDeadline,
  ): Promise<void> {
    if (this.pendingPrompts.size === 0) {
      if (this.disconnectGeneration === observedDisconnectGeneration) {
        this.clearDisconnectTimer();
      }
      return;
    }

    const pendingEntries = [...this.pendingPrompts.entries()];
    let keepDisconnectTimer = false;
    for (const [sessionId, pending] of pendingEntries) {
      if (this.pendingPrompts.get(sessionId) !== pending) {
        continue;
      }
      if (pending.disconnectContext?.generation !== observedDisconnectGeneration) {
        continue;
      }
      const shouldKeepPending = await this.reconcilePendingPrompt(sessionId, pending, deadline);
      if (shouldKeepPending) {
        keepDisconnectTimer = true;
      }
    }

    if (
      keepDisconnectTimer &&
      deadline === "initial" &&
      this.disconnectGeneration === observedDisconnectGeneration
    ) {
      const disconnectContext = pendingEntries
        .map(([, pending]) => pending.disconnectContext)
        .find((context) => context?.generation === observedDisconnectGeneration);
      if (disconnectContext) {
        this.armDisconnectTimer(disconnectContext, "accepted-recovery");
      }
    } else if (!keepDisconnectTimer && this.disconnectGeneration === observedDisconnectGeneration) {
      this.clearDisconnectTimer();
    }
  }

  private async reconcilePendingPrompt(
    sessionId: string,
    pending: AcpPendingPrompt,
    deadline?: DisconnectDeadline,
  ): Promise<boolean> {
    const disconnectContext = pending.disconnectContext;
    if (!disconnectContext) {
      return false;
    }
    const waitedRunId = pending.idempotencyKey;
    let result: AcpAgentWaitResult | undefined;
    try {
      result = await this.gateway.request(
        "agent.wait",
        {
          runId: waitedRunId,
          timeoutMs: 0,
        },
        { timeoutMs: null },
      );
    } catch (err) {
      this.log(`agent.wait reconcile failed for ${waitedRunId}: ${String(err)}`);
      if (deadline) {
        if (this.shouldRejectPendingAtDisconnectDeadline(pending, disconnectContext, deadline)) {
          await this.rejectPendingPrompt(
            pending,
            new Error(`Gateway disconnected: ${disconnectContext.reason}`),
            { recordDisconnectNotice: true },
          );
          return false;
        }
        return true;
      }
      return true;
    }

    const currentPending = this.getPendingPrompt(sessionId, waitedRunId);
    if (!currentPending) {
      return false;
    }
    if (result?.status === "ok") {
      await this.finishPrompt(sessionId, currentPending, "end_turn");
      return false;
    }
    if (result?.status === "error") {
      void this.finishPrompt(sessionId, currentPending, "end_turn");
      return false;
    }
    if (deadline) {
      if (
        this.shouldRejectPendingAtDisconnectDeadline(currentPending, disconnectContext, deadline)
      ) {
        const currentDisconnectContext = currentPending.disconnectContext;
        if (!currentDisconnectContext) {
          return false;
        }
        await this.rejectPendingPrompt(
          currentPending,
          new Error(`Gateway disconnected: ${currentDisconnectContext.reason}`),
          { recordDisconnectNotice: true },
        );
        return false;
      }
      return true;
    }
    return true;
  }
}
