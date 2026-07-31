// Resolves an OpenClaw Node entry script without confusing Node option values for the script.
import path from "node:path";
import { classifyOpenClawArgv } from "./exec-approvals-lifecycle-cli.js";
import { isOpenClawEntryScriptPath } from "./exec-approvals-lifecycle-patterns.js";
import { lifecycleIsJavaScriptExecutableRunner } from "./exec-approvals-lifecycle-runners.js";
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";

const NODE_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "-r",
  "--conditions",
  "--cpu-prof-dir",
  "--diagnostic-dir",
  "--env-file",
  "--env-file-if-exists",
  "--experimental-config-file",
  "--experimental-default-type",
  "--experimental-loader",
  "--experimental-sea-config",
  "--heapsnapshot-near-heap-limit",
  "--icu-data-dir",
  "--import",
  "--input-type",
  "--inspect-port",
  "--localstorage-file",
  "--loader",
  "--max-http-header-size",
  "--openssl-config",
  "--redirect-warnings",
  "--report-dir",
  "--report-filename",
  "--report-signal",
  "--require",
  "--secure-heap",
  "--secure-heap-min",
  "--snapshot-blob",
  "--test-concurrency",
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--test-timeout",
  "--title",
  "--tls-cipher-list",
  "--trace-event-categories",
  "--trace-event-file-pattern",
  "--watch-path",
]);

function optionName(token: string): string {
  return token.trim().toLowerCase().replaceAll("_", "-").split("=", 1)[0] ?? "";
}

function nodeScriptIndex(argv: readonly string[]): number {
  let scriptIndex = 1;
  for (; scriptIndex < argv.length; scriptIndex += 1) {
    const token = argv[scriptIndex]?.trim() ?? "";
    if (token === "--") {
      return scriptIndex + 1;
    }
    if (!token.startsWith("-") || token === "-") {
      return scriptIndex;
    }
    const name = optionName(token);
    if (/^-(?:c|r).+/u.test(name)) {
      continue;
    }
    if (NODE_OPTIONS_WITH_VALUE.has(name) && !token.includes("=")) {
      scriptIndex += 1;
    }
  }
  return scriptIndex;
}

function resolveNodeRunArgv(argv: readonly string[]): {
  args: string[];
  scriptIndex: number;
  scriptToken: string;
} | null {
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    const name = optionName(token);
    if (name === "--run") {
      const inline = token.includes("=") ? token.slice(token.indexOf("=") + 1) : undefined;
      const scriptIndex = inline === undefined ? index + 1 : index;
      const scriptToken = inline ?? argv[scriptIndex] ?? "";
      const argStart = scriptIndex + 1 + (argv[scriptIndex + 1] === "--" ? 1 : 0);
      return { args: argv.slice(argStart), scriptIndex, scriptToken };
    }
    if (token === "--" || (!token.startsWith("-") && token !== "-")) {
      return null;
    }
    if (NODE_OPTIONS_WITH_VALUE.has(name) && !token.includes("=")) {
      index += 1;
    }
  }
  return null;
}

/** Return OpenClaw-equivalent argv when Node directly launches its CLI entry script. */
export function resolveNodeOpenClawArgv(argv: readonly string[], cwd?: string): string[] | null {
  if (normalizeExecutableToken(argv[0] ?? "") !== "node") {
    return null;
  }
  const run = resolveNodeRunArgv(argv);
  if (run && normalizeExecutableToken(run.scriptToken) === "openclaw") {
    return ["openclaw", ...run.args];
  }
  const scriptIndex = nodeScriptIndex(argv);
  const scriptToken = (argv[scriptIndex] ?? "").trim();
  const isAbsolute = path.win32.isAbsolute(scriptToken) || path.posix.isAbsolute(scriptToken);
  const script = (cwd && !isAbsolute ? path.resolve(cwd, scriptToken) : scriptToken).toLowerCase();
  if (!isOpenClawEntryScriptPath(script)) {
    return null;
  }
  return ["openclaw", ...argv.slice(scriptIndex + 1)];
}

/** Return true when a dynamic Node entry could be OpenClaw and receives lifecycle argv. */
export function unresolvedNodeEntryMayHideLifecycle(
  argv: readonly string[],
  isUnresolved: (value: string | undefined) => boolean,
): boolean {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (!lifecycleIsJavaScriptExecutableRunner(executable)) {
    return false;
  }
  if (["node", "nodejs"].includes(executable)) {
    const run = resolveNodeRunArgv(argv);
    if (run) {
      return isUnresolved(run.scriptToken) && classifyOpenClawArgv(["openclaw", ...run.args]);
    }
    const scriptIndex = nodeScriptIndex(argv);
    return (
      isUnresolved(argv[scriptIndex]) &&
      classifyOpenClawArgv(["openclaw", ...argv.slice(scriptIndex + 1)])
    );
  }
  const scriptIndex = argv.findIndex((token, index) => index > 0 && isUnresolved(token));
  return scriptIndex !== -1 && classifyOpenClawArgv(["openclaw", ...argv.slice(scriptIndex + 1)]);
}
