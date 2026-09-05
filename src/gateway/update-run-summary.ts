import { asRecord, readStringField } from "@openclaw/normalization-core/record-coerce";

export const DEFAULT_UPDATE_TIMEOUT_MS = 20 * 60 * 1000;

/** Project update results without leaking successful logs or restart-sentinel state. */
export function summarizeUpdateRunResponse(response: unknown) {
  const raw = asRecord(response);
  const result = asRecord(raw.result);
  const restart = asRecord(raw.restart);
  const handoff = asRecord(raw.handoff);
  const text = (value: unknown, limit: number) =>
    typeof value === "string" ? value.slice(0, limit) : undefined;
  const status = text(result.status, 40) || "error";
  const ok = raw.ok === true && (handoff.status === "started" || status === "ok");
  const before = text(asRecord(result.before).version, 100);
  const after = text(asRecord(result.after).version, 100);
  const failedSteps = (Array.isArray(result.steps) ? result.steps : [])
    .flatMap((value) => {
      const step = asRecord(value);
      return step.exitCode === 0 || (step.exitCode === null && status !== "error")
        ? []
        : [
            {
              name: text(step.name, 100) || "update",
              exitCode: typeof step.exitCode === "number" ? step.exitCode : null,
              stderrTail: readStringField(step, "stderrTail")?.slice(-500) ?? "",
            },
          ];
    })
    .slice(-3);
  const summary = {
    runId: text(raw.runId, 100),
    ok,
    status,
    reason: text(result.reason, 240),
    message: readStringField(raw, "message"),
    mode: text(result.mode, 40),
    before: before ? { version: before } : undefined,
    after: after ? { version: after } : undefined,
    restart:
      raw.restart === undefined
        ? undefined
        : {
            scheduled: restart.ok === true,
            delayMs: typeof restart.delayMs === "number" ? restart.delayMs : undefined,
          },
    // Preserve executable recovery instructions verbatim, even beyond the log budget.
    handoff:
      typeof handoff.status !== "string"
        ? undefined
        : {
            status: text(handoff.status, 40),
            command: readStringField(handoff, "command"),
            message: readStringField(handoff, "message"),
          },
    ...(typeof raw.ackDelivered === "boolean" ? { ackDelivered: raw.ackDelivered } : {}),
    failedSteps,
    next:
      readStringField(raw, "message") ??
      (ok
        ? "Update handed off. Reply briefly and wait for the automatic completion or failure notice; do not run shell commands or restart anything."
        : "Tell the user the update did not start and why; relay any exact manual instructions."),
  };
  if (JSON.stringify(summary, null, 2).length >= 4000) {
    for (const step of failedSteps) {
      step.stderrTail = "";
    }
    if (JSON.stringify(summary, null, 2).length >= 4000) {
      failedSteps.length = 0;
    }
  }
  return summary;
}
