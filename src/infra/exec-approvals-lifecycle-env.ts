// Expands known shell environment references used in lifecycle-sensitive argv.
const POSIX_VARIABLE_RE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu;
const POWERSHELL_VARIABLE_RE = /\$env:([A-Za-z_][A-Za-z0-9_]*)/giu;
const CMD_VARIABLE_RE = /%([A-Za-z_][A-Za-z0-9_]*)%/gu;
const VARIABLE_REFERENCE_RE =
  /\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*|env:[A-Za-z_][A-Za-z0-9_]*)|%[A-Za-z_][A-Za-z0-9_]*%/iu;

export type LifecycleEnvironmentExpansion = {
  argv: string[];
  fieldSplitUncertain: boolean;
  unresolved: boolean;
};

function normalizedExecutable(value: string | undefined): string {
  return (
    (value ?? "")
      .trim()
      .split(/[\\/]/u)
      .pop()
      ?.toLowerCase()
      .replace(/\.(?:bat|cmd|com|exe)$/u, "") ?? ""
  );
}

/** Return true when a partial environment can fill a lifecycle-sensitive argv position. */
export function unresolvedEnvironmentMayHideLifecycle(argv: readonly string[]): boolean {
  if (!argv.some((token) => VARIABLE_REFERENCE_RE.test(token))) {
    return false;
  }
  if (VARIABLE_REFERENCE_RE.test(argv[0] ?? "")) {
    return true;
  }
  const executable = normalizedExecutable(argv[0]);
  const tokens = argv.map((token) => token.trim().toLowerCase());
  if (executable === "launchctl") {
    return !tokens.some((token) => ["blame", "list", "print", "procinfo"].includes(token));
  }
  if (executable === "systemctl") {
    const action = tokens.slice(1).find((token) => !token.startsWith("-"));
    return !["is-active", "is-enabled", "list-units", "show", "status"].includes(action ?? "");
  }
  if (executable === "openclaw") {
    return !tokens.some((token) =>
      ["--help", "health", "probe", "status", "update.status"].includes(token),
    );
  }
  return [
    "",
    "kill",
    "killall",
    "ash",
    "bash",
    "dash",
    "env",
    "fish",
    "ksh",
    "pkill",
    "powershell",
    "pwsh",
    "schtasks",
    "service",
    "sh",
    "taskkill",
    "xargs",
    "zsh",
  ].includes(executable);
}

function readEnvironmentValue(env: NodeJS.ProcessEnv | undefined, key: string): string | undefined {
  if (!env) {
    return undefined;
  }
  if (Object.hasOwn(env, key)) {
    return env[key];
  }
  if (process.platform !== "win32") {
    return undefined;
  }
  const matchedKey = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return matchedKey === undefined ? undefined : env[matchedKey];
}

/** Expand variables whose environment value is known and report partial-env uncertainty. */
export function expandLifecycleEnvironmentArgv(params: {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  envComplete: boolean;
}): LifecycleEnvironmentExpansion {
  let fieldSplitUncertain = false;
  let unresolved = false;
  const replaceVariable = (key: string): string => {
    const value = readEnvironmentValue(params.env, key);
    if (value !== undefined) {
      fieldSplitUncertain ||= /\s/u.test(value);
      return value;
    }
    if (!params.envComplete) {
      unresolved = true;
    }
    return "";
  };
  const argv = params.argv.map((token) =>
    token
      .replace(POWERSHELL_VARIABLE_RE, (_match, key: string) => replaceVariable(key))
      .replace(POSIX_VARIABLE_RE, (_match, braced: string | undefined, bare: string | undefined) =>
        replaceVariable(braced ?? bare ?? ""),
      )
      .replace(CMD_VARIABLE_RE, (_match, key: string) => replaceVariable(key)),
  );
  return { argv, fieldSplitUncertain, unresolved };
}
