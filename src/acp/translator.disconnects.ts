/** Gateway disconnect grace period and pending-prompt reconciliation. */
import type { StopReason } from "@agentclientprotocol/sdk";
import type { GatewayClient } from "../gateway/client.js";
import type {
  AcpAgentWaitResult,
  AcpDisconnectContext,
  AcpPendingPrompt,
} from "./translator.prompt-state.js";

const ACP_GATEWAY_DISCONNECT_GRACE_MS = 5_000;

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

  handleGatewayReconnect(): void {
    this.log("gateway reconnected");
    const disconnectContext = this.activeDisconnectContext;
    this.activeDisconnectContext = null;
    if (!disconnectContext) {
      return;
    }
    void this.reconcilePendingPrompts(disconnectContext.generation, false);
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

  private armDisconnectTimer(disconnectContext: AcpDisconnectContext): void {
    this.clearDisconnectTimer();
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null;
      void this.reconcilePendingPrompts(disconnectContext.generation, true);
    }, ACP_GATEWAY_DISCONNECT_GRACE_MS);
    this.disconnectTimer.unref?.();
  }

  private clearPendingDisconnectState(
    pending: AcpPendingPrompt,
    disconnectContext: AcpDisconnectContext,
  ): void {
    if (pending.disconnectContext !== disconnectContext) {
      return;
    }
    pending.disconnectContext = undefined;
  }

  private shouldRejectPendingAtDisconnectDeadline(
    pending: AcpPendingPrompt,
    disconnectContext: AcpDisconnectContext,
  ): boolean {
    return (
      pending.disconnectContext === disconnectContext &&
      (!pending.sendAccepted ||
        this.activeDisconnectContext?.generation === disconnectContext.generation)
    );
  }

  private async reconcilePendingPrompts(
    observedDisconnectGeneration: number,
    deadlineExpired: boolean,
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
      const shouldKeepPending = await this.reconcilePendingPrompt(
        sessionId,
        pending,
        deadlineExpired,
      );
      if (shouldKeepPending) {
        keepDisconnectTimer = true;
      }
    }

    if (!keepDisconnectTimer && this.disconnectGeneration === observedDisconnectGeneration) {
      this.clearDisconnectTimer();
    }
  }

  private async reconcilePendingPrompt(
    sessionId: string,
    pending: AcpPendingPrompt,
    deadlineExpired: boolean,
  ): Promise<boolean> {
    const disconnectContext = pending.disconnectContext;
    if (!disconnectContext) {
      return false;
    }
    let result: AcpAgentWaitResult | undefined;
    try {
      result = await this.gateway.request(
        "agent.wait",
        {
          runId: pending.idempotencyKey,
          timeoutMs: 0,
        },
        { timeoutMs: null },
      );
    } catch (err) {
      this.log(`agent.wait reconcile failed for ${pending.idempotencyKey}: ${String(err)}`);
      if (deadlineExpired) {
        if (this.shouldRejectPendingAtDisconnectDeadline(pending, disconnectContext)) {
          await this.rejectPendingPrompt(
            pending,
            new Error(`Gateway disconnected: ${disconnectContext.reason}`),
            { recordDisconnectNotice: true },
          );
          return false;
        }
        this.clearPendingDisconnectState(pending, disconnectContext);
        return false;
      }
      return true;
    }

    const currentPending = this.getPendingPrompt(sessionId, pending.idempotencyKey);
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
    if (deadlineExpired) {
      if (this.shouldRejectPendingAtDisconnectDeadline(currentPending, disconnectContext)) {
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
      this.clearPendingDisconnectState(currentPending, disconnectContext);
      return false;
    }
    return true;
  }
}
