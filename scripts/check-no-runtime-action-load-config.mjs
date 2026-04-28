#!/usr/bin/env node
import { collectRuntimeActionLoadConfigViolations } from "./lib/config-boundary-guard.mjs";

function main() {
  const violations = collectRuntimeActionLoadConfigViolations();
  if (violations.length === 0) {
    return 0;
  }
  console.error(
    [
      "Runtime channel send/action/client/pairing helpers must not call loadConfig().",
      "Load and resolve config at the command/gateway/monitor boundary, then pass cfg through.",
      "",
      ...violations,
    ].join("\n"),
  );
  return 1;
}

process.exitCode = main();
