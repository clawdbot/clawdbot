// Resolves lifecycle-sensitive commands carried by xargs.
import { isOpenClawEntryScriptPath } from "./exec-approvals-lifecycle-patterns.js";
import { lifecycleIsJavaScriptExecutableRunner } from "./exec-approvals-lifecycle-runners.js";
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";

const XARGS_FLAGS = new Set([
  "-0",
  "-o",
  "-p",
  "-r",
  "-t",
  "-x",
  "--exit",
  "--interactive",
  "--null",
  "--no-run-if-empty",
  "--open-tty",
  "--show-limits",
  "--verbose",
]);
const XARGS_OPTIONS_WITH_VALUE = new Set([
  "-E",
  "-I",
  "-L",
  "-P",
  "-a",
  "-d",
  "-n",
  "-s",
  "--arg-file",
  "--delimiter",
  "--eof",
  "--max-args",
  "--max-chars",
  "--max-lines",
  "--max-procs",
  "--process-slot-var",
  "--replace",
]);
const REPLACEMENT_SENSITIVE_EXECUTABLES = new Set([
  "ash",
  "bash",
  "bunx",
  "busybox",
  "cmd",
  "command",
  "csh",
  "dash",
  "doas",
  "elvish",
  "env",
  "exec",
  "fish",
  "ksh",
  "kill",
  "killall",
  "launchctl",
  "mksh",
  "net",
  "nice",
  "node",
  "nohup",
  "nu",
  "osh",
  "npm",
  "npx",
  "openclaw",
  "pkill",
  "pnpm",
  "powershell",
  "pwsh",
  "sc",
  "schtasks",
  "service",
  "setsid",
  "sh",
  "sudo",
  "systemctl",
  "taskkill",
  "timeout",
  "toybox",
  "tcsh",
  "xargs",
  "xonsh",
  "yash",
  "yarn",
  "zsh",
]);
const STDIN_APPEND_SENSITIVE_EXECUTABLES = new Set([
  ...REPLACEMENT_SENSITIVE_EXECUTABLES,
  "bun",
  "bunx",
  "corepack",
  "kill",
  "killall",
  "openclaw",
  "pnpx",
  "pnpm",
  "yarn",
  "yarnpkg",
]);

type LifecycleXargsPlan =
  | { kind: "not-xargs" }
  | { kind: "approval-required" }
  | { kind: "argv"; argv: string[] };

function optionName(token: string): string {
  return token.trim().split("=", 1)[0] ?? "";
}

function looksLifecycleSensitive(argv: readonly string[]): boolean {
  const text = argv.join(" ").toLowerCase();
  return (
    text.includes("openclaw") &&
    /\b(?:daemon|gateway|install|restart|start|stop|uninstall|update)\b/u.test(text)
  );
}

function containsSensitiveCommandCandidate(argv: readonly string[], start: number): boolean {
  return argv
    .slice(start)
    .some((token) => isXargsSensitiveExecutable(token, STDIN_APPEND_SENSITIVE_EXECUTABLES));
}

function isXargsSensitiveExecutable(
  value: string | undefined,
  candidates: ReadonlySet<string>,
): boolean {
  return (
    candidates.has(normalizeExecutableToken(value ?? "")) ||
    isOpenClawEntryScriptPath(value) ||
    lifecycleIsJavaScriptExecutableRunner(value)
  );
}

/** Resolve the fixed command prefix launched for each xargs input record. */
export function resolveLifecycleXargsArgv(argv: readonly string[]): LifecycleXargsPlan {
  if (normalizeExecutableToken(argv[0] ?? "") !== "xargs") {
    return { kind: "not-xargs" };
  }
  let replacementToken: string | undefined;
  const commandPlan = (commandArgv: string[]): LifecycleXargsPlan => {
    const replacementIndex = replacementToken
      ? commandArgv.findIndex((token) => token.includes(replacementToken as string))
      : -1;
    const executable = commandArgv[0];
    return (!replacementToken &&
      isXargsSensitiveExecutable(executable, STDIN_APPEND_SENSITIVE_EXECUTABLES)) ||
      replacementIndex === 0 ||
      (replacementIndex > 0 &&
        isXargsSensitiveExecutable(executable, REPLACEMENT_SENSITIVE_EXECUTABLES))
      ? { kind: "approval-required" }
      : { kind: "argv", argv: commandArgv };
  };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      return index + 1 < argv.length ? commandPlan(argv.slice(index + 1)) : { kind: "not-xargs" };
    }
    if (!token.startsWith("-") || token === "-") {
      return commandPlan(argv.slice(index));
    }
    const clusteredReplacement = /^-[0oprtx]*([IJi])(.*)$/u.exec(token);
    if (clusteredReplacement) {
      const mode = clusteredReplacement[1] ?? "";
      const attached = clusteredReplacement[2] ?? "";
      replacementToken = attached || (mode === "i" ? "{}" : argv[++index]?.trim());
      continue;
    }
    if (token === "--replace") {
      replacementToken = "{}";
      continue;
    }
    if (token.startsWith("--replace=")) {
      replacementToken = token.slice("--replace=".length) || "{}";
      continue;
    }
    const name = optionName(token);
    if (XARGS_FLAGS.has(name)) {
      continue;
    }
    if (XARGS_OPTIONS_WITH_VALUE.has(name)) {
      if (!token.includes("=") && token === name) {
        index += 1;
      }
      continue;
    }
    if (
      [...XARGS_OPTIONS_WITH_VALUE].some(
        (option) =>
          option.startsWith("-") &&
          !option.startsWith("--") &&
          token.startsWith(option) &&
          token.length > option.length,
      )
    ) {
      continue;
    }
    return looksLifecycleSensitive(argv) || containsSensitiveCommandCandidate(argv, index + 1)
      ? { kind: "approval-required" }
      : { kind: "not-xargs" };
  }
  return looksLifecycleSensitive(argv) ? { kind: "approval-required" } : { kind: "not-xargs" };
}
