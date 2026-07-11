/** Gateway-owned recorder joining trusted run, tool, and message lifecycle streams. */
import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  createAgentEventAuditRecorder,
  type AgentEventAuditRecorder,
} from "./agent-event-audit.js";
import type { AuditMessageMode } from "./audit-config.js";
import { createAuditEventWriter, type AuditEventWriter } from "./audit-event-writer.js";
import type { TrustedMessageAuditEvent } from "./message-audit-events.js";

const log = createSubsystemLogger("audit/events");
let persistenceFailureWarned = false;

export type AuditEventRecorder = AgentEventAuditRecorder & {
  recordMessage: (event: TrustedMessageAuditEvent) => void;
};

export function createAuditEventRecorder(options: {
  messageMode: AuditMessageMode;
  writer?: AuditEventWriter;
  stateDir?: string;
  terminalSettleMs?: number;
}): AuditEventRecorder {
  let nextAcceptedMessageSequence = 0;
  const writer =
    options.writer ??
    createAuditEventWriter({
      ...(options.stateDir ? { stateDir: options.stateDir } : {}),
      onError: (error) => {
        if (!persistenceFailureWarned) {
          persistenceFailureWarned = true;
          log.warn(`audit event persistence failed: ${error}`);
        }
      },
    });
  const agentRecorder = createAgentEventAuditRecorder({
    writer,
    ...(options.terminalSettleMs !== undefined
      ? { terminalSettleMs: options.terminalSettleMs }
      : {}),
  });

  return {
    ...agentRecorder,
    recordMessage: (event) => {
      if (options.messageMode === "off") {
        return;
      }
      if (options.messageMode === "direct" && event.conversationKind !== "direct") {
        return;
      }
      nextAcceptedMessageSequence += 1;
      writer.record({
        ...event,
        sourceId: event.sourceId?.trim() || `message:${randomUUID()}`,
        sourceSequence: nextAcceptedMessageSequence,
      });
    },
  };
}

export function resetAuditEventRecorderForTest(): void {
  persistenceFailureWarned = false;
}
