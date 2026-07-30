// Expands known shell environment references used in lifecycle-sensitive argv.
const POSIX_VARIABLE_RE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu;
const POWERSHELL_VARIABLE_RE = /\$env:([A-Za-z_][A-Za-z0-9_]*)/giu;
const CMD_VARIABLE_RE = /%([A-Za-z_][A-Za-z0-9_]*)%/gu;
const VARIABLE_REFERENCE_RE =
  /\$\{[^}]+\}|\$(?:[A-Za-z_][A-Za-z0-9_]*|env:[A-Za-z_][A-Za-z0-9_]*)|%[A-Za-z_][A-Za-z0-9_]*%/iu;
const POSIX_PARAMETER_OPERATOR_RE = /\$\{(?![A-Za-z_][A-Za-z0-9_]*\})[^}]+\}/u;
const OPENCLAW_GLOBAL_FLAGS = new Set(["--dev", "--no-color"]);
const OPENCLAW_GLOBAL_OPTIONS = new Set(["--container", "--log-level", "--profile"]);
const SYSTEMCTL_OPTIONS_WITH_VALUE = new Set([
  "-h",
  "-m",
  "-p",
  "-s",
  "-t",
  "--host",
  "--image-policy",
  "--job-mode",
  "--lines",
  "--machine",
  "--output",
  "--property",
  "--root",
  "--runtime-scope",
  "--signal",
  "--state",
  "--type",
]);

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

function optionName(token: string): string {
  return token.trim().toLowerCase().split("=", 1)[0] ?? "";
}

function scanFirstPositional(
  argv: readonly string[],
  start: number,
  optionsWithValue: ReadonlySet<string>,
  standaloneOptions: ReadonlySet<string> = new Set(),
): number {
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      return index + 1;
    }
    const name = optionName(token);
    if (standaloneOptions.has(name)) {
      continue;
    }
    if (optionsWithValue.has(name)) {
      if (!token.includes("=")) {
        index += 1;
      }
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      return index;
    }
  }
  return argv.length;
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
    const actionIndex = scanFirstPositional(argv, 1, new Set(["-d", "-s"]));
    return !["blame", "list", "print", "procinfo"].includes(tokens[actionIndex] ?? "");
  }
  if (executable === "systemctl") {
    const actionIndex = scanFirstPositional(argv, 1, SYSTEMCTL_OPTIONS_WITH_VALUE);
    return !["is-active", "is-enabled", "list-units", "show", "status"].includes(
      tokens[actionIndex] ?? "",
    );
  }
  if (executable === "openclaw") {
    const commandIndex = scanFirstPositional(
      argv,
      1,
      OPENCLAW_GLOBAL_OPTIONS,
      OPENCLAW_GLOBAL_FLAGS,
    );
    return !["--help", "health", "probe", "status", "update.status"].includes(
      tokens[commandIndex] ?? "",
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
  let unresolved = params.argv.some((token) => POSIX_PARAMETER_OPERATOR_RE.test(token));
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
