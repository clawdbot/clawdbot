import { callGateway } from "../../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

const COMMAND = "/approve";

// Exec approval decisions
const EXEC_DECISION_ALIASES: Record<string, "allow-once" | "allow-always" | "deny"> = {
  allow: "allow-once",
  once: "allow-once",
  "allow-once": "allow-once",
  allowonce: "allow-once",
  always: "allow-always",
  "allow-always": "allow-always",
  allowalways: "allow-always",
  deny: "deny",
  reject: "deny",
  block: "deny",
};

// Message approval decisions (simpler - just allow/deny)
const MESSAGE_DECISION_ALIASES: Record<string, "allow" | "deny"> = {
  allow: "allow",
  yes: "allow",
  ok: "allow",
  approve: "allow",
  deny: "deny",
  no: "deny",
  reject: "deny",
  block: "deny",
};

type ParsedExecApproveCommand =
  | { ok: true; type: "exec"; id: string; decision: "allow-once" | "allow-always" | "deny" }
  | { ok: false; error: string };

type ParsedMessageApproveCommand =
  | { ok: true; type: "message"; id: string; decision: "allow" | "deny" }
  | { ok: false; error: string };

type ParsedApproveCommand = ParsedExecApproveCommand | ParsedMessageApproveCommand;

function isMessageApprovalId(id: string): boolean {
  // Message approval IDs start with "msg-"
  return id.toLowerCase().startsWith("msg-");
}

function parseApproveCommand(raw: string): ParsedApproveCommand | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(COMMAND)) return null;
  const rest = trimmed.slice(COMMAND.length).trim();
  if (!rest) {
    return {
      ok: false,
      error:
        "Usage: /approve <id> allow|deny (for message) or allow-once|allow-always|deny (for exec)",
    };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return {
      ok: false,
      error:
        "Usage: /approve <id> allow|deny (for message) or allow-once|allow-always|deny (for exec)",
    };
  }

  const first = tokens[0].toLowerCase();
  const second = tokens[1].toLowerCase();

  // Determine if this is a message approval based on ID prefix
  const idFirst = !EXEC_DECISION_ALIASES[first] && !MESSAGE_DECISION_ALIASES[first];
  const id = idFirst ? tokens[0] : tokens.slice(1).join(" ").trim();
  const decisionToken = idFirst ? second : first;

  if (isMessageApprovalId(id)) {
    // Message approval
    const decision = MESSAGE_DECISION_ALIASES[decisionToken];
    if (!decision) {
      return { ok: false, error: "Usage: /approve <id> allow|deny" };
    }
    return { ok: true, type: "message", id, decision };
  }

  // Exec approval
  const execDecision = EXEC_DECISION_ALIASES[decisionToken];
  if (execDecision) {
    return { ok: true, type: "exec", id, decision: execDecision };
  }

  // If the decision token matches message decisions but ID doesn't have msg- prefix,
  // still try to resolve as exec with allow -> allow-once mapping
  const msgDecision = MESSAGE_DECISION_ALIASES[decisionToken];
  if (msgDecision === "allow") {
    return { ok: true, type: "exec", id, decision: "allow-once" };
  }
  if (msgDecision === "deny") {
    return { ok: true, type: "exec", id, decision: "deny" };
  }

  return { ok: false, error: "Usage: /approve <id> allow-once|allow-always|deny" };
}

function buildResolvedByLabel(params: Parameters<CommandHandler>[0]): string {
  const channel = params.command.channel;
  const sender = params.command.senderId ?? "unknown";
  return `${channel}:${sender}`;
}

export const handleApproveCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) return null;
  const normalized = params.command.commandBodyNormalized;
  const parsed = parseApproveCommand(normalized);
  if (!parsed) return null;
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /approve from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }

  const resolvedBy = buildResolvedByLabel(params);

  if (parsed.type === "message") {
    // Handle message approval
    try {
      await callGateway({
        method: "message.approval.resolve",
        params: { id: parsed.id, decision: parsed.decision },
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        clientDisplayName: `Chat message approval (${resolvedBy})`,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      });
    } catch {
      // If message approval fails, try exec approval as fallback
      try {
        const execDecision = parsed.decision === "allow" ? "allow-once" : "deny";
        await callGateway({
          method: "exec.approval.resolve",
          params: { id: parsed.id, decision: execDecision },
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          clientDisplayName: `Chat approval (${resolvedBy})`,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        });
      } catch (execErr) {
        return {
          shouldContinue: false,
          reply: {
            text: `❌ Failed to submit approval: ${String(execErr)}`,
          },
        };
      }
    }

    return {
      shouldContinue: false,
      reply: { text: `✅ Message approval ${parsed.decision} submitted for ${parsed.id}.` },
    };
  }

  // Handle exec approval
  try {
    await callGateway({
      method: "exec.approval.resolve",
      params: { id: parsed.id, decision: parsed.decision },
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: `Chat approval (${resolvedBy})`,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });
  } catch (err) {
    return {
      shouldContinue: false,
      reply: {
        text: `❌ Failed to submit approval: ${String(err)}`,
      },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: `✅ Exec approval ${parsed.decision} submitted for ${parsed.id}.` },
  };
};
