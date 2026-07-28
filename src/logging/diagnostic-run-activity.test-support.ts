import type { DiagnosticEventPayload } from "../infra/diagnostic-events.js";
import "./diagnostic-run-activity.js";

type DiagnosticModelStartedActivityEvent = Pick<
  Extract<DiagnosticEventPayload, { type: "model.call.started" }>,
  "runId" | "sessionId" | "sessionKey" | "provider" | "model"
> & { seq?: number };

type DiagnosticRunProgressActivityEvent = Pick<
  Extract<DiagnosticEventPayload, { type: "run.progress" }>,
  "runId" | "sessionId" | "sessionKey" | "reason"
>;

type DiagnosticRunActivityTestApi = {
  markDiagnosticModelStartedForTest(params: DiagnosticModelStartedActivityEvent): void;
  markDiagnosticRunProgressForTest(params: DiagnosticRunProgressActivityEvent): void;
  markDiagnosticToolStartedForTest(params: {
    sessionId?: string;
    sessionKey?: string;
    runId?: string;
    toolName: string;
    toolCallId?: string;
  }): void;
};

function getTestApi(): DiagnosticRunActivityTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.diagnosticRunActivityTestApi")
  ] as DiagnosticRunActivityTestApi;
}

export function markDiagnosticModelStartedForTest(
  params: DiagnosticModelStartedActivityEvent,
): void {
  getTestApi().markDiagnosticModelStartedForTest(params);
}

export function markDiagnosticRunProgressForTest(params: DiagnosticRunProgressActivityEvent): void {
  getTestApi().markDiagnosticRunProgressForTest(params);
}

export function markDiagnosticToolStartedForTest(
  params: Parameters<DiagnosticRunActivityTestApi["markDiagnosticToolStartedForTest"]>[0],
): void {
  getTestApi().markDiagnosticToolStartedForTest(params);
}
