// Resolves an OpenClaw Node entry script without confusing Node option values for the script.
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
  return token.trim().toLowerCase().split("=", 1)[0] ?? "";
}

/** Return OpenClaw-equivalent argv when Node directly launches its CLI entry script. */
export function resolveNodeOpenClawArgv(argv: readonly string[]): string[] | null {
  if (normalizeExecutableToken(argv[0] ?? "") !== "node") {
    return null;
  }
  let scriptIndex = 1;
  for (; scriptIndex < argv.length; scriptIndex += 1) {
    const token = argv[scriptIndex]?.trim() ?? "";
    if (token === "--") {
      scriptIndex += 1;
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }
    const name = optionName(token);
    if (/^-(?:c|r).+/u.test(name)) {
      continue;
    }
    if (NODE_OPTIONS_WITH_VALUE.has(name) && !token.includes("=")) {
      scriptIndex += 1;
    }
  }
  const script = (argv[scriptIndex] ?? "").trim().toLowerCase();
  if (
    !script.includes("openclaw") ||
    !/(?:^|[/\\])(?:openclaw\.mjs|(?:dist[/\\])?(?:entry|index)\.(?:c?js|mjs))$/u.test(script)
  ) {
    return null;
  }
  return ["openclaw", ...argv.slice(scriptIndex + 1)];
}
