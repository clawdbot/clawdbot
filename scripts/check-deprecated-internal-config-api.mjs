#!/usr/bin/env node
import { collectDeprecatedInternalConfigApiViolations } from "./lib/deprecated-config-api-guard.mjs";

export function main() {
  const violations = collectDeprecatedInternalConfigApiViolations();
  if (violations.length === 0) {
    console.log("deprecated internal config API guard passed");
    return 0;
  }

  console.error("Deprecated internal config API guard failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
