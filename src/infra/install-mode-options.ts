type InstallMode = "install" | "update";

type InstallModeOptions<TLogger> = {
  logger?: TLogger;
  mode?: InstallMode;
  dryRun?: boolean;
};

type TimedInstallModeOptions<TLogger> = InstallModeOptions<TLogger> & {
  timeoutMs?: number;
};

export function resolveInstallModeOptions<TLogger>(
  params: InstallModeOptions<TLogger>,
  defaultLogger: TLogger,
): {
  logger: TLogger;
  mode: InstallMode;
  dryRun: boolean;
} {
  return {
    logger: params.logger ?? defaultLogger,
    mode: params.mode ?? "install",
    dryRun: params.dryRun ?? false,
  };
}

export function resolveTimedInstallModeOptions<TLogger>(
  params: TimedInstallModeOptions<TLogger>,
  defaultLogger: TLogger,
  defaultTimeoutMs = 120_000,
): {
  logger: TLogger;
  timeoutMs: number;
  mode: InstallMode;
  dryRun: boolean;
} {
  return {
    ...resolveInstallModeOptions(params, defaultLogger),
    timeoutMs: params.timeoutMs ?? defaultTimeoutMs,
  };
}
