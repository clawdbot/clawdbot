import type {
  AgentSideConnection,
  AvailableCommand,
  PromptRequest,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AcpEventLedger, AcpEventLedgerReplay } from "./event-ledger.js";

export type AcpTranslatorSessionRef = {
  sessionId: string;
  sessionKey: string;
  ledgerSessionId?: string;
};

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

export class AcpTranslatorSessionUpdates {
  constructor(private options: AcpTranslatorSessionUpdatesOptions) {}

  async startLedgerSession(
    session: AcpTranslatorLedgerSessionRef,
    options: { complete: boolean; reset?: boolean },
  ): Promise<void> {
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
    try {
      return await this.options.eventLedger.readReplay(params);
    } catch (err) {
      this.options.log(`event ledger replay fallback for ${params.sessionId}: ${String(err)}`);
      return { complete: false, events: [] };
    }
  }

  async readLedgerReplayBySessionId(sessionId: string): Promise<AcpEventLedgerReplay> {
    try {
      return await this.options.eventLedger.readReplayBySessionId({ sessionId });
    } catch (err) {
      this.options.log(`event ledger exact replay fallback for ${sessionId}: ${String(err)}`);
      return { complete: false, events: [] };
    }
  }

  async readLedgerReplayBySessionKey(sessionKey: string): Promise<AcpEventLedgerReplay> {
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
  }

  async emit(params: {
    sessionId: string;
    sessionKey?: string;
    ledgerSessionId?: string;
    runId?: string;
    update: SessionUpdate;
    record?: boolean;
  }): Promise<void> {
    await this.options.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: params.update,
    });
    if (params.record && params.sessionKey) {
      await this.recordLedgerUpdate({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        ...(params.ledgerSessionId ? { ledgerSessionId: params.ledgerSessionId } : {}),
        ...(params.runId ? { runId: params.runId } : {}),
        update: params.update,
      });
    }
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
    try {
      await this.options.eventLedger.recordUpdate({
        sessionId: params.ledgerSessionId ?? params.sessionId,
        sessionKey: params.sessionKey,
        ...(params.runId ? { runId: params.runId } : {}),
        update: params.update,
      });
    } catch (err) {
      this.options.log(`event ledger update record failed for ${params.sessionId}: ${String(err)}`);
      await this.markLedgerIncomplete({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        ...(params.ledgerSessionId ? { ledgerSessionId: params.ledgerSessionId } : {}),
      });
    }
  }

  private async markLedgerIncomplete(session: AcpTranslatorSessionRef): Promise<void> {
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
