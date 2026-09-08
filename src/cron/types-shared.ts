/** Optional zero-token shell gate before cron payload execution (#112371). */
export type CronJobPrecheck = {
  kind?: "exec";
  command: string;
  cwd?: string;
  timeoutMs?: number;
  contract?: "exit-code" | "stdout-prefix" | "dual";
  workExitCodes?: number[];
  noWorkExitCodes?: number[];
  workStdoutPrefix?: string;
  noWorkStdoutPrefix?: string;
  onError?: "fail" | "skip";
};

/** Optional dynamic-cadence bounds for one cron job. */
export type CronPacing = {
  min?: string;
  max?: string;
};

/** Shared persisted cron job envelope used by runtime and external config shapes. */
export type CronJobBase<TSchedule, TSessionTarget, TWakeMode, TPayload, TDelivery, TFailureAlert> =
  {
    id: string;
    agentId?: string;
    sessionKey?: string;
    name: string;
    description?: string;
    enabled: boolean;
    deleteAfterRun?: boolean;
    createdAtMs: number;
    updatedAtMs: number;
    schedule: TSchedule;
    pacing?: CronPacing;
    sessionTarget: TSessionTarget;
    wakeMode: TWakeMode;
    payload: TPayload;
    /** Optional shell gate before payload execution (skip LLM when no work). */
    precheck?: CronJobPrecheck;
    delivery?: TDelivery;
    failureAlert?: TFailureAlert;
  };
