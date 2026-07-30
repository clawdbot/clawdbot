// Resolves lifecycle-sensitive commands carried by xargs.
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

export type LifecycleXargsPlan =
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

/** Resolve the fixed command prefix launched for each xargs input record. */
export function resolveLifecycleXargsArgv(argv: readonly string[]): LifecycleXargsPlan {
  if (normalizeExecutableToken(argv[0] ?? "") !== "xargs") {
    return { kind: "not-xargs" };
  }
  let replacementToken: string | undefined;
  const commandPlan = (commandArgv: string[]): LifecycleXargsPlan =>
    replacementToken && commandArgv[0]?.includes(replacementToken)
      ? { kind: "approval-required" }
      : { kind: "argv", argv: commandArgv };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      return index + 1 < argv.length ? commandPlan(argv.slice(index + 1)) : { kind: "not-xargs" };
    }
    if (!token.startsWith("-") || token === "-") {
      return commandPlan(argv.slice(index));
    }
    if (token === "-I") {
      replacementToken = argv[index + 1]?.trim();
      index += 1;
      continue;
    }
    if (token.startsWith("-I") && token.length > 2) {
      replacementToken = token.slice(2);
      continue;
    }
    if (token === "-i" || token === "--replace") {
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
    if (/^-[EILPnsa].+/u.test(token)) {
      continue;
    }
    return looksLifecycleSensitive(argv) ? { kind: "approval-required" } : { kind: "not-xargs" };
  }
  return looksLifecycleSensitive(argv) ? { kind: "approval-required" } : { kind: "not-xargs" };
}
