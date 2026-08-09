// Windows process environment helpers for the MXC ProcessContainer backend.
//
// MXC's BaseContainerRunner treats a non-empty `process.env` as a replacement
// environment block for CreateProcessInSandbox: when present it replaces the
// entire default OS environment, so any required OS var (SystemRoot, COMSPEC, …)
// that is not listed is missing and cmd.exe fails with ERROR_ENVVAR_NOT_FOUND.
// These helpers build a minimal-but-complete Windows env block from required OS
// defaults plus caller overrides, and a separate launcher env for the spawn
// process itself.

// Env vars required by cmd.exe / CreateProcess inside the AppContainer. Caller
// overrides are layered on top; nothing else from the host environment leaks in.
const WINDOWS_PROCESS_ENV_DEFAULT_KEYS = [
  "SystemRoot",
  "SystemDrive",
  "ComSpec",
  "WINDIR",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ALLUSERSPROFILE",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "PUBLIC",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "NUMBER_OF_PROCESSORS",
] as const;

// Env vars forwarded to the plugin-side Node launcher process (not the sandboxed
// child). The launcher only needs enough OS context to locate Node, temp dirs,
// and the user profile; the sandbox policy itself travels via the JSON payload.
const LAUNCHER_ENV_KEYS = [
  "SystemRoot",
  "SystemDrive",
  "ComSpec",
  "WINDIR",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
] as const;

function getEnvValueCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const exact = env[key];
  if (exact !== undefined) {
    return exact;
  }
  const normalizedKey = key.toLowerCase();
  const match = Object.entries(env).find(
    ([candidate]) => candidate.toLowerCase() === normalizedKey,
  );
  return match?.[1];
}

function setCaseInsensitiveEnvEntry(
  entries: Map<string, { key: string; value: string }>,
  key: string,
  value: string | undefined,
): void {
  if (!key || key.includes("=") || value === undefined) {
    return;
  }
  entries.set(key.toLowerCase(), { key, value });
}

// Build the Windows replacement env block: required OS defaults first, then
// caller overrides (case-insensitively, since Windows env names are
// case-insensitive). Keys containing `=` are dropped so a malicious caller key
// cannot inject extra `NAME=VALUE` pairs into the block.
export function normalizeWindowsProcessEnvRecord(
  callerEnv: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const entries = new Map<string, { key: string; value: string }>();
  for (const key of WINDOWS_PROCESS_ENV_DEFAULT_KEYS) {
    setCaseInsensitiveEnvEntry(entries, key, getEnvValueCaseInsensitive(hostEnv, key));
  }
  for (const [key, value] of Object.entries(callerEnv)) {
    setCaseInsensitiveEnvEntry(entries, key, value);
  }
  return [...entries.values()]
    .toSorted((a, b) => a.key.localeCompare(b.key))
    .map(({ key, value }) => `${key}=${value}`);
}

export function buildLauncherEnv(hostEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of LAUNCHER_ENV_KEYS) {
    const value = getEnvValueCaseInsensitive(hostEnv, key);
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
