// Vitest performance config helper normalizes performance test environment settings.
import path from "node:path";
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

type VitestPerformanceConfig = {
  fsModuleCache?: true;
  fsModuleCachePath?: string;
  experimental?: {
    importDurations?: { print: true };
    printImportBreakdown?: true;
  };
};

// Linked worktrees may share node_modules; invalidating that cache would remove
// another checkout's transforms. Keep writable cache ownership in this checkout.
export function resolveVitestFsModuleCacheRoot(cwd = process.cwd()): string {
  return path.join(cwd, ".cache", "vitest");
}

export function loadVitestPerformanceConfig(
  env: EnvMap = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd = process.cwd(),
): VitestPerformanceConfig {
  const config: VitestPerformanceConfig = {};
  const windowsEnv = isWindowsEnv(env, platform);

  if (!windowsEnv && !isDisabled(env.OPENCLAW_VITEST_FS_MODULE_CACHE)) {
    config.fsModuleCache = true;
  }
  if (windowsEnv && isEnabled(env.OPENCLAW_VITEST_FS_MODULE_CACHE)) {
    config.fsModuleCache = true;
  }
  if (config.fsModuleCache) {
    // The default leaf cannot contain the scheduler's concurrent cache leaves:
    // Vitest recursively removes its selected directory when lockfiles change.
    config.fsModuleCachePath =
      env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH?.trim() ||
      path.join(resolveVitestFsModuleCacheRoot(cwd), "default");
  }
  if (isEnabled(env.OPENCLAW_VITEST_IMPORT_DURATIONS)) {
    (config.experimental ??= {}).importDurations = { print: true };
  }
  if (isEnabled(env.OPENCLAW_VITEST_PRINT_IMPORT_BREAKDOWN)) {
    (config.experimental ??= {}).printImportBreakdown = true;
  }

  return config;
}
