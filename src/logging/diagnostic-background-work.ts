type DiagnosticBackgroundWorkParams = {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  outstanding: boolean;
};

type DiagnosticBackgroundWorkActivity = {
  outstandingBackgroundWorkRunId?: string;
};

export function recordDiagnosticOutstandingBackgroundWork(
  params: DiagnosticBackgroundWorkParams,
  resolveActivity: (
    params: DiagnosticBackgroundWorkParams,
  ) => DiagnosticBackgroundWorkActivity | undefined,
): void {
  const runId = params.runId.trim();
  if (!runId) {
    return;
  }
  const activity = resolveActivity({ ...params, runId });
  if (!activity) {
    return;
  }
  if (params.outstanding) {
    activity.outstandingBackgroundWorkRunId = runId;
  } else if (activity.outstandingBackgroundWorkRunId === runId) {
    activity.outstandingBackgroundWorkRunId = undefined;
  }
}
