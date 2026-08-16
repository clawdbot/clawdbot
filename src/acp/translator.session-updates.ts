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
  }): Promise<void> {
    if (this.stopped) {
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
    options: { record: boolean },
  ): Promise<void> {
    await this.emit({
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
      record: options.record,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: await this.options.getAvailableCommands(),
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
