// Vitest performance config helper normalizes performance test environment settings.
type EnvMap = Record<string, string | undefined>;

const isEnabled = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
};

const isDisabled = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "0" || normalized === "false";
};

const isWindowsEnv = (env: EnvMap, platform: NodeJS.Platform): boolean => {
  if (platform === "win32") {
    return true;
  }
  const runnerOs = env.RUNNER_OS?.trim().toLowerCase();
  return runnerOs === "windows";
};

type VitestExperimentalConfig = {
  experimental?: {
    fsModuleCache?: true;
    fsModuleCachePath?: string;
    importDurations?: { print: true };
    printImportBreakdown?: true;
  };
};

export function loadVitestExperimentalConfig(
  env: EnvMap = process.env,
  platform: NodeJS.Platform = process.platform,
): VitestExperimentalConfig {
  const experimental: {
    fsModuleCache?: true;
    fsModuleCachePath?: string;
    importDurations?: { print: true };
    printImportBreakdown?: true;
  } = {};
  const windowsEnv = isWindowsEnv(env, platform);

  if (!windowsEnv && !isDisabled(env.OPENCLAW_VITEST_FS_MODULE_CACHE)) {
    experimental.fsModuleCache = true;
  }
  if (windowsEnv && isEnabled(env.OPENCLAW_VITEST_FS_MODULE_CACHE)) {
    experimental.fsModuleCache = true;
  }
  if (experimental.fsModuleCache && env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH?.trim()) {
    experimental.fsModuleCachePath = env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH.trim();
  }
  if (isEnabled(env.OPENCLAW_VITEST_IMPORT_DURATIONS)) {
    experimental.importDurations = { print: true };
  }
  if (isEnabled(env.OPENCLAW_VITEST_PRINT_IMPORT_BREAKDOWN)) {
    experimental.printImportBreakdown = true;
  }

  return Object.keys(experimental).length > 0 ? { experimental } : {};
}
