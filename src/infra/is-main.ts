// Identifies whether an ESM module is running as the process entry point.
import fs from "node:fs";
import path from "node:path";

type IsMainModuleOptions = {
  currentFile: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  wrapperEntryPairs?: Array<{
    wrapperBasename: string;
    entryBasename: string;
  }>;
};

function normalizePathCandidate(candidate: string | undefined, cwd: string): string | undefined {
  if (!candidate) {
    return undefined;
  }

  const resolved = path.resolve(cwd, candidate);
  try {
    // Compare real paths so symlinked package bins and resolved entry files still match.
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function resolveDefaultCwd(currentFile: string): string {
  try {
    return process.cwd();
  } catch {
    // `process.cwd()` can throw when the launch directory was removed; entrypoint checks should
    // still work relative to the current module path.
    return path.dirname(currentFile);
  }
}

/** Detects whether a module is executing as the process entrypoint, including wrapper launches. */
export function isMainModule({
  currentFile,
  argv = process.argv,
  env = process.env,
  cwd,
  wrapperEntryPairs = [],
}: IsMainModuleOptions): boolean {
  const resolvedCwd = cwd ?? resolveDefaultCwd(currentFile);
  const normalizedCurrent = normalizePathCandidate(currentFile, resolvedCwd);
  const normalizedArgv1 = normalizePathCandidate(argv[1], resolvedCwd);

  if (normalizedCurrent && normalizedArgv1 && normalizedCurrent === normalizedArgv1) {
    return true;
  }

  // PM2 runs the script via an internal wrapper; `argv[1]` points at the wrapper.
  // PM2 exposes the actual script path in `pm_exec_path`.
  const normalizedPmExecPath = normalizePathCandidate(env.pm_exec_path, resolvedCwd);
  if (normalizedCurrent && normalizedPmExecPath && normalizedCurrent === normalizedPmExecPath) {
    return true;
  }

  // Optional wrapper->entry mapping for wrapper launchers that import the real entry.
  if (normalizedCurrent && normalizedArgv1 && wrapperEntryPairs.length > 0) {
    const currentBase = path.basename(normalizedCurrent);
    const argvBase = path.basename(normalizedArgv1);
    const matched = wrapperEntryPairs.some(
      ({ wrapperBasename, entryBasename }) =>
        currentBase === entryBasename && argvBase === wrapperBasename,
    );
    if (matched) {
      return true;
    }
  }

  return false;
}
