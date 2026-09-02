import { asRecord, readStringField } from "@openclaw/normalization-core/record-coerce";

export const DEFAULT_UPDATE_TIMEOUT_MS = 20 * 60 * 1000;

// Budget serialized text, including escaped log characters, not just input length.
function summaryText(value: unknown, budget: number, tail = false): string | undefined {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  let text = tail ? value.slice(-budget) : value.slice(0, budget);
  while (JSON.stringify(text).length > budget + 2) {
    text = tail ? text.slice(1) : text.slice(0, -1);
  }
  return text;
}

/** One bounded chat-facing outcome for the agent tool and /update command. */
export function summarizeUpdateRunResponse(response: unknown, hasSession = true) {
  const raw = asRecord(response);
  const result = asRecord(raw.result);
  const restart = asRecord(raw.restart);
  const handoff = asRecord(raw.handoff);
  const status = summaryText(result.status, 40) ?? "error";
  const ok = raw.ok === true && (handoff.status === "started" || status === "ok");
  // Recovery instructions are executable operator guidance: preserve them verbatim.
  const command = readStringField(handoff, "command");
  const message = readStringField(handoff, "message");
  const before = summaryText(asRecord(result.before).version, 100);
  const after = summaryText(asRecord(result.after).version, 100);
  const next = ok
    ? "Update handed off. The gateway restarts shortly after you reply and the user gets an automatic completion or failure notice in this chat. Reply with one short sentence; do not run shell commands or restart anything."
    : message || command
      ? `Tell the user the update did not start and give these manual instructions: ${command || message}`
      : "Tell the user the update did not start and why.";
  const failedSteps: Array<{ name: string; exitCode: number | null; stderrTail: string }> = [];
  const summary = {
    ok,
    status,
    reason: summaryText(result.reason, 240),
    mode: summaryText(result.mode, 40),
    ...(before ? { before: { version: before } } : {}),
    ...(after ? { after: { version: after } } : {}),
    ...(raw.restart !== undefined
      ? {
          restart: {
            scheduled: restart.ok === true,
            ...(typeof restart.delayMs === "number" ? { delayMs: restart.delayMs } : {}),
          },
        }
      : {}),
    ...(typeof handoff.status === "string"
      ? { handoff: { status: summaryText(handoff.status, 40), command, message } }
      : {}),
    ...(typeof raw.ackDelivered === "boolean" ? { ackDelivered: raw.ackDelivered } : {}),
    failedSteps,
    next: hasSession
      ? next
      : `No caller session was available; the gateway will use its fallback notification route. ${next.replace("in this chat", "on that route")}`,
  };
  // Keep failed steps in execution order; never include successful-step output or sentinels.
  for (const value of Array.isArray(result.steps) ? result.steps : []) {
    const step = asRecord(value);
    if (step.exitCode === 0 || (step.exitCode === null && status !== "error")) {
      continue;
    }
    summary.failedSteps.push({
      name: summaryText(step.name, 100) ?? "update",
      exitCode: typeof step.exitCode === "number" ? step.exitCode : null,
      stderrTail: summaryText(step.stderrTail, 500, true) ?? "",
    });
  }
  // Retain failure names/codes before logs; handoff instructions never pay this budget.
  for (const step of summary.failedSteps.toReversed()) {
    if (JSON.stringify(summary, null, 2).length < 4000) {
      break;
    }
    step.stderrTail = "";
  }
  while (summary.failedSteps.length > 0 && JSON.stringify(summary, null, 2).length >= 4000) {
    summary.failedSteps.pop();
  }
  if (JSON.stringify(summary, null, 2).length >= 4000) {
    // Reference rather than repeat exact recovery instructions when they fill the budget.
    summary.next = ok
      ? "Update handed off; reply briefly and wait for the automatic completion notice, without running shell commands or restarting anything."
      : "Tell the user the update did not start and relay the exact manual instructions in handoff.";
    if (!hasSession) {
      summary.next +=
        " No caller session was available; the gateway uses its fallback notice route.";
    }
    summary.reason = summaryText(summary.reason, 80);
  }
  if (JSON.stringify(summary, null, 2).length >= 4000) {
    throw new Error(
      "Update response exceeds the chat budget without truncating manual instructions; check the Control UI for the outcome and do not retry the update.",
    );
  }
  return summary;
}
