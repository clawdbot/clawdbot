import type { TerminalSession } from "./session-manager.types.js";
import type { TerminalAttachSummary, TerminalSessionSummary } from "./session-types.js";

export function terminalAttachSummary(session: TerminalSession): TerminalAttachSummary {
  const {
    attached: _attached,
    createdAtMs: _createdAtMs,
    ...summary
  } = terminalSessionSummary(session);
  return {
    ...summary,
    buffer: session.buffer.snapshot(),
    seq: session.output.endOffset,
  };
}

export function terminalSessionSummary(session: TerminalSession): TerminalSessionSummary {
  const owner: TerminalSessionSummary["owner"] =
    session.owner?.kind === "agent" ? `agent:${session.owner.agentSessionKey}` : "conn";
  return {
    sessionId: session.id,
    agentId: session.agentId,
    shell: session.shell,
    ...(session.title ? { title: session.title } : {}),
    cwd: session.cwd,
    attached:
      session.owner?.kind === "conn" ||
      (session.owner?.kind === "agent" && session.viewers.size > 0),
    owner,
    createdAtMs: session.createdAtMs,
  };
}

export function terminalSessionRecipientIds(session: TerminalSession): string[] {
  const connIds = new Set(session.viewers);
  if (session.owner?.kind === "conn") {
    connIds.add(session.owner.connId);
  }
  return [...connIds];
}
