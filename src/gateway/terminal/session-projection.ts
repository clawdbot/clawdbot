import type { TerminalSession } from "./session-manager.types.js";
import type { TerminalAttachSummary, TerminalSessionSummary } from "./session-types.js";

export function terminalAttachSummary(session: TerminalSession): TerminalAttachSummary {
  return {
    sessionId: session.id,
    agentId: session.agentId,
    cwd: session.cwd,
    shell: session.shell,
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
