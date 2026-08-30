/** Emits ACP session updates and mirrors replayable updates into the event ledger. */
import type {
  AgentSideConnection,
  AvailableCommand,
  PromptRequest,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AcpEventLedger, AcpEventLedgerReplay } from "./event-ledger.js";

/** Session identity used when emitting and recording ACP translator updates. */
type AcpTranslatorSessionRef = {
  sessionId: string;
  sessionKey: string;
  ledgerSessionId?: string;
};

// Session update helper records ACP-visible updates into the replay ledger when requested.
type AcpTranslatorLedgerSessionRef = AcpTranslatorSessionRef & {
  cwd: string;
};

type AcpTranslatorSessionUpdatesOptions = {
  connection: Pick<AgentSideConnection, "sessionUpdate">;
  eventLedger: AcpEventLedger;
  getAvailableCommands: () => Promise<AvailableCommand[]>;
  log: (message: string) => void;
};

function resolveLedgerSessionId(session: { sessionId: string; ledgerSessionId?: string }): string {
  return session.ledgerSessionId ?? session.sessionId;
}

/** Helper that keeps ACP client updates and replay ledger writes in sync. */
export class AcpTranslatorSessionUpdates {
  private stopped = false;
  // Queue each ledger session at emission time so a detached disconnect notice
  // cannot overtake its older update or block unrelated session settlement.
  private ledgerMutationTails = new Map<string, Promise<void>>();

  constructor(private options: AcpTranslatorSessionUpdatesOptions) {}

  stop(): void {
    this.stopped = true;
  }

  /** Pre-fetches available commands so callers can resolve them before arming
  deferred delivery timers. The lazy command-module import yields to the
  event loop; if that yield happens after a snapshot timer is armed, the
  snapshot notification can overtake the RPC response. */
  prepareAvailableCommands(): Promise<AvailableCommand[]> {
    return this.options.getAvailableCommands();
  }

  async startLedgerSession(
    session: AcpTranslatorLedgerSessionRef,
    options: { complete: boolean; reset?: boolean },
  ): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      await this.options.eventLedger.startSession({
        sessionId: resolveLedgerSessionId(session),
        sessionKey: session.sessionKey,
        cwd: session.cwd,
        complete: options.complete,
        ...(options.reset ? { reset: true } : {}),
      });
    } catch (err) {
      this.options.log(
        `event ledger session start failed for ${session.sessionId}: ${String(err)}`,
      );
    }
  }

  async readLedgerReplay(params: {
    sessionId: string;
    sessionKey: string;
  }): Promise<AcpEventLedgerReplay> {
    if (this.stopped) {
      return { complete: false, events: [] };
    }
    try {
      return await this.options.eventLedger.readReplay(params);
    } catch (err) {
      this.options.log(`event ledger replay fallback for ${params.sessionId}: ${String(err)}`);
      return { complete: false, events: [] };
    }
  }

  async readLedgerReplayBySessionId(sessionId: string): Promise<AcpEventLedgerReplay> {
    if (this.stopped) {
      return { complete: false, events: [] };
    }
    try {
      return await this.options.eventLedger.readReplayBySessionId({ sessionId });
    } catch (err) {
      this.options.log(`event ledger exact replay fallback for ${sessionId}: ${String(err)}`);
      return { complete: false, events: [] };
    }
  }

  async readLedgerReplayBySessionKey(sessionKey: string): Promise<AcpEventLedgerReplay> {
    if (this.stopped) {
      return { complete: false, events: [] };
    }
    try {
      return await this.options.eventLedger.readReplayBySessionKey({ sessionKey });
    } catch (err) {
      this.options.log(
        `event ledger session-key replay fallback for ${sessionKey}: ${String(err)}`,
      );
      return { complete: false, events: [] };
    }
  }

  async recordUserPrompt(
    session: AcpTranslatorSessionRef,
    runId: string,
    prompt: PromptRequest["prompt"],
  ): Promise<void> {
    await this.enqueueLedgerMutation(resolveLedgerSessionId(session), async () => {
      if (this.stopped) {
        return;
      }
      try {
        await this.options.eventLedger.recordUserPrompt({
          sessionId: resolveLedgerSessionId(session),
          sessionKey: session.sessionKey,
          runId,
          prompt,
        });
      } catch (err) {
        this.options.log(
          `event ledger prompt record failed for ${session.sessionId}: ${String(err)}`,
        );
        await this.markLedgerIncomplete(session);
      }
    });
  }

  async emit(params: {
    sessionId: string;
    sessionKey?: string;
    ledgerSessionId?: string;
    runId?: string;
    update: SessionUpdate;
    record?: boolean;
    waitForDelivery?: boolean;
    // Defer only the wire delivery past the current synchronous return so the
    // caller's JSON-RPC result reaches the client before this notification.
    // The ledger write is still awaited before emit resolves, so follow-up
    // reads see the recorded update immediately. The guard fences the deferred
    // callback against a close-then-resume-same-ID race: if the captured
    // session instance no longer matches the store's current instance, the
    // notification is suppressed instead of leaking into a new lifecycle.
    deferDelivery?: boolean;
    deliveryGuard?: () => boolean;
  }): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (params.deferDelivery) {
      const recording =
        params.record && params.sessionKey
          ? this.recordLedgerUpdate({
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              ...(params.ledgerSessionId ? { ledgerSessionId: params.ledgerSessionId } : {}),
              ...(params.runId ? { runId: params.runId } : {}),
              update: params.update,
            })
          : undefined;
      await recording;
      const guard = params.deliveryGuard;
      setTimeout(() => {
        if (this.stopped || (guard && !guard())) {
          return;
        }
        void this.options.connection
          .sessionUpdate({ sessionId: params.sessionId, update: params.update })
          .catch((err: unknown) => {
            this.options.log(
              `session update delivery failed for ${params.sessionId}: ${String(err)}`,
            );
          });
      }, 0);
      return;
    }
    const delivery = this.options.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: params.update,
    });
    const recording =
      params.record && params.sessionKey
        ? this.recordLedgerUpdate({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            ...(params.ledgerSessionId ? { ledgerSessionId: params.ledgerSessionId } : {}),
            ...(params.runId ? { runId: params.runId } : {}),
            update: params.update,
          })
        : undefined;
    if (params.waitForDelivery === false) {
      void delivery.catch((err: unknown) => {
        this.options.log(`session update delivery failed for ${params.sessionId}: ${String(err)}`);
      });
    } else {
      await delivery;
    }
    await recording;
  }

  async sendAvailableCommands(
    session: AcpTranslatorSessionRef,
    options: {
      record: boolean;
      deferDelivery?: boolean;
      deliveryGuard?: () => boolean;
      availableCommands?: AvailableCommand[];
    },
  ): Promise<void> {
    const availableCommands =
      options.availableCommands ?? (await this.options.getAvailableCommands());
    await this.emit({
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
      record: options.record,
      deferDelivery: options.deferDelivery,
      ...(options.deliveryGuard ? { deliveryGuard: options.deliveryGuard } : {}),
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands,
      },
    });
  }

  private async recordLedgerUpdate(params: {
    sessionId: string;
    sessionKey: string;
    ledgerSessionId?: string;
    runId?: string;
    update: SessionUpdate;
  }): Promise<void> {
    await this.enqueueLedgerMutation(params.ledgerSessionId ?? params.sessionId, async () => {
      if (this.stopped) {
        return;
      }
      try {
        await this.options.eventLedger.recordUpdate({
          sessionId: params.ledgerSessionId ?? params.sessionId,
          sessionKey: params.sessionKey,
          ...(params.runId ? { runId: params.runId } : {}),
          update: params.update,
        });
      } catch (err) {
        this.options.log(
          `event ledger update record failed for ${params.sessionId}: ${String(err)}`,
        );
        await this.markLedgerIncomplete({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          ...(params.ledgerSessionId ? { ledgerSessionId: params.ledgerSessionId } : {}),
        });
      }
    });
  }

  private enqueueLedgerMutation(
    ledgerSessionId: string,
    mutation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.ledgerMutationTails.get(ledgerSessionId) ?? Promise.resolve();
    const pending = previous.then(mutation, mutation);
    const tail = pending.catch(() => {});
    this.ledgerMutationTails.set(ledgerSessionId, tail);
    void tail.then(() => {
      if (this.ledgerMutationTails.get(ledgerSessionId) === tail) {
        this.ledgerMutationTails.delete(ledgerSessionId);
      }
    });
    return pending;
  }

  private async markLedgerIncomplete(session: AcpTranslatorSessionRef): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      await this.options.eventLedger.markIncomplete({
        sessionId: resolveLedgerSessionId(session),
        sessionKey: session.sessionKey,
      });
    } catch (err) {
      this.options.log(
        `event ledger incomplete mark failed for ${session.sessionId}: ${String(err)}`,
      );
    }
  }
}
