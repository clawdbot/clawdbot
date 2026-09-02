// Linux OOM score helpers adjust child process OOM priority when supported.
import fs from "node:fs";

/**
 * On Linux, children spawned by a long-lived parent (e.g., the gateway) inherit
 * the parent's `oom_score_adj`. Under cgroup memory pressure the kernel tends
 * to pick the largest-RSS process as the OOM victim, which is usually the
 * gateway rather than its transient workers. See issue #70404.
 *
 * Since Linux 2.6.20 any unprivileged process may voluntarily *raise* its own
 * `oom_score_adj` without `CAP_SYS_RESOURCE`. We exploit that by wrapping the
 * child argv in a tiny `/bin/sh` shim that raises the score in the post-fork
 * child and then `exec`s the real command, so there is no extra long-lived
 * shell process and no change to the final process identity.
 *
 * Opt out per-process by setting `OPENCLAW_CHILD_OOM_SCORE_ADJ=0` (also
 * accepts `false`/`no`/`off`). Callers may also provide the key via
 * `params.env` for per-child overrides.
 */

const CHILD_OOM_SCORE_ADJ_ENV_KEY = "OPENCLAW_CHILD_OOM_SCORE_ADJ";
const OOM_SCORE_WRAP_SHELL = "/bin/sh";
const OOM_SCORE_WRAP_SCRIPT = 'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"';

// Env keys that can make /bin/sh (especially Bash invoked as sh) execute or
// expose caller-influenced startup behavior before the final `exec`. Stripped
// when we wrap so the shim can't become an env-controlled code-exec primitive.
const SHELL_INIT_ENV_CARRIERS = [
  ["BASH_ENV", "OC_INTERNAL_OOM_EXEC_BASH_ENV"],
  ["ENV", "OC_INTERNAL_OOM_EXEC_ENV"],
  ["CDPATH", "OC_INTERNAL_OOM_EXEC_CDPATH"],
  ["PS4", "OC_INTERNAL_OOM_EXEC_PS4"],
] as const;
const NON_RESTORABLE_BASH_ENV_KEY = /^(?:SHELLOPTS|BASHOPTS|BASH_FUNC_.*)$/u;
const OOM_SCORE_RESTORE_EXEC_ENV_SCRIPT = [
  'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; if [ "${OC_INTERNAL_OOM_EXEC_BASH_ENV+x}" = x ]; then BASH_ENV="$OC_INTERNAL_OOM_EXEC_BASH_ENV"; export BASH_ENV; fi; unset OC_INTERNAL_OOM_EXEC_BASH_ENV',
  'if [ "${OC_INTERNAL_OOM_EXEC_ENV+x}" = x ]; then ENV="$OC_INTERNAL_OOM_EXEC_ENV"; export ENV; fi; unset OC_INTERNAL_OOM_EXEC_ENV',
  'if [ "${OC_INTERNAL_OOM_EXEC_CDPATH+x}" = x ]; then CDPATH="$OC_INTERNAL_OOM_EXEC_CDPATH"; export CDPATH; fi; unset OC_INTERNAL_OOM_EXEC_CDPATH',
  'if [ "${OC_INTERNAL_OOM_EXEC_PS4+x}" = x ]; then PS4="$OC_INTERNAL_OOM_EXEC_PS4"; export PS4; fi; unset OC_INTERNAL_OOM_EXEC_PS4; exec "$0" "$@"',
].join("; ");

function isDisabled(value: string | undefined): boolean {
  switch (value?.trim().toLowerCase()) {
    case "0":
    case "false":
    case "no":
    case "off":
      return true;
    default:
      return false;
  }
}

let cachedShellAvailable: boolean | null = null;
function defaultShellAvailable(): boolean {
  if (cachedShellAvailable !== null) {
    return cachedShellAvailable;
  }
  try {
    cachedShellAvailable = fs.statSync(OOM_SCORE_WRAP_SHELL).isFile();
  } catch {
    cachedShellAvailable = false;
  }
  return cachedShellAvailable;
}

export type OomWrapOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  argv0?: string;
  shellAvailable?: () => boolean;
};

export type OomScoreAdjustedSpawn = {
  command: string;
  args: string[];
  argv0?: string;
  env: NodeJS.ProcessEnv | undefined;
  wrapped: boolean;
};

function shouldWrapChildForOomScore(options: OomWrapOptions | undefined): boolean {
  const platform = options?.platform ?? process.platform;
  if (platform !== "linux") {
    return false;
  }
  const env = options?.env ?? process.env;
  if (isDisabled(env[CHILD_OOM_SCORE_ADJ_ENV_KEY])) {
    return false;
  }
  return (options?.shellAvailable ?? defaultShellAvailable)();
}

function isWrapped(command: string, args: readonly string[]): boolean {
  return command === OOM_SCORE_WRAP_SHELL && args[0] === "-c" && args[1] === OOM_SCORE_WRAP_SCRIPT;
}

function canUseShellExecCommand(command: string): boolean {
  // POSIX sh implementations such as dash do not support `exec --`. A command
  // starting with "-" could be parsed as an exec option, so keep that rare
  // shape on the original direct-spawn path instead of wrapping it.
  return !command.startsWith("-");
}

function hardenShellEnv(baseEnv: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...(baseEnv ?? process.env) };
  for (const [key] of SHELL_INIT_ENV_CARRIERS) {
    delete next[key];
  }
  for (const key of Object.keys(next)) {
    if (NON_RESTORABLE_BASH_ENV_KEY.test(key)) {
      delete next[key];
    }
  }
  return next;
}

function prepareOomScoreAdjustedSpawnWithExecEnvPolicy(
  command: string,
  args: readonly string[] = [],
  options?: OomWrapOptions,
  preserveExecEnv = false,
): OomScoreAdjustedSpawn {
  const copy = [...args];
  const directSpawn: OomScoreAdjustedSpawn = {
    command,
    args: copy,
    ...(options?.argv0 === undefined ? {} : { argv0: options.argv0 }),
    env: options?.env,
    wrapped: false,
  };
  if (
    !command ||
    !canUseShellExecCommand(command) ||
    !shouldWrapChildForOomScore(options) ||
    (options?.argv0 !== undefined && options.argv0 !== command)
  ) {
    // POSIX sh cannot preserve an argv0 that differs from the exec pathname.
    return directSpawn;
  }
  if (!preserveExecEnv && isWrapped(command, copy)) {
    return { command, args: copy, env: hardenShellEnv(options?.env), wrapped: true };
  }
  const effectiveEnv = options?.env ?? process.env;
  if (
    preserveExecEnv &&
    Object.entries(effectiveEnv).some(
      ([key, value]) => value !== undefined && NON_RESTORABLE_BASH_ENV_KEY.test(key),
    )
  ) {
    // Bash consumes these readonly/imported controls before the shim can
    // neutralize and restore them, so only direct spawn preserves exact env.
    return directSpawn;
  }
  const wrappedEnv = hardenShellEnv(effectiveEnv);
  if (preserveExecEnv) {
    for (const [key, carrier] of SHELL_INIT_ENV_CARRIERS) {
      if (effectiveEnv[carrier] !== undefined) {
        return directSpawn;
      }
      delete wrappedEnv[carrier];
      if (effectiveEnv[key] !== undefined) {
        wrappedEnv[carrier] = effectiveEnv[key];
      }
    }
  }
  const wrapScript = preserveExecEnv ? OOM_SCORE_RESTORE_EXEC_ENV_SCRIPT : OOM_SCORE_WRAP_SCRIPT;
  return {
    command: OOM_SCORE_WRAP_SHELL,
    args: ["-c", wrapScript, command, ...copy],
    env: wrappedEnv,
    wrapped: true,
  };
}

export function prepareOomScoreAdjustedSpawn(
  command: string,
  args: readonly string[] = [],
  options?: OomWrapOptions,
): OomScoreAdjustedSpawn {
  return prepareOomScoreAdjustedSpawnWithExecEnvPolicy(command, args, options);
}

export function prepareOomScoreAdjustedSpawnPreservingExecEnv(
  command: string,
  args: readonly string[] = [],
  options?: OomWrapOptions,
): OomScoreAdjustedSpawn {
  return prepareOomScoreAdjustedSpawnWithExecEnvPolicy(command, args, options, true);
}
