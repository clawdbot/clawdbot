import { formatRuntimeStatusWithDetails } from "../infra/runtime-status.ts";

export type ServiceRuntimeLike = {
  status?: string;
  state?: string;
  subState?: string;
  pid?: number;
  lastExitStatus?: number;
  lastExitReason?: string;
  lastRunResult?: string;
  lastRunTime?: string;
  detail?: string;
};

const SIGNAL_NAMES_BY_STATUS = new Map<number, string>([
  [129, "SIGHUP"],
  [130, "SIGINT"],
  [131, "SIGQUIT"],
  [134, "SIGABRT/abort"],
  [137, "SIGKILL"],
  [143, "SIGTERM"],
]);

function formatLastExitStatus(status: number): string {
  const signalName = SIGNAL_NAMES_BY_STATUS.get(status);
  return signalName ? `last exit ${status} (${signalName})` : `last exit ${status}`;
}

export function formatRuntimeStatus(runtime: ServiceRuntimeLike | undefined): string | null {
  if (!runtime) {
    return null;
  }
  const details: string[] = [];
  if (runtime.subState) {
    details.push(`sub ${runtime.subState}`);
  }
  if (runtime.lastExitStatus !== undefined) {
    details.push(formatLastExitStatus(runtime.lastExitStatus));
  }
  if (runtime.lastExitReason) {
    details.push(`reason ${runtime.lastExitReason}`);
  }
  if (runtime.lastRunResult) {
    details.push(`last run ${runtime.lastRunResult}`);
  }
  if (runtime.lastRunTime) {
    details.push(`last run time ${runtime.lastRunTime}`);
  }
  if (runtime.detail) {
    details.push(runtime.detail);
  }
  return formatRuntimeStatusWithDetails({
    status: runtime.status,
    pid: runtime.pid,
    state: runtime.state,
    details,
  });
}
