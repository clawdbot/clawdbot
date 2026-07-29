// Log assertions for config reload E2E scenarios.
import { sleep } from "../../../lib/sleep.mjs";
import { readPositiveIntEnv } from "../env-limits.mjs";
import { createConfigReloadLogScanner } from "./log-scanner.mjs";

const logPath = process.env.OPENCLAW_CONFIG_RELOAD_LOG_PATH ?? "/tmp/config-reload-e2e.log";
const deadlineMs = Date.now() + readPositiveIntEnv("OPENCLAW_CONFIG_RELOAD_LOG_TIMEOUT_MS", 30_000);
const maxReadBytes = readPositiveIntEnv("OPENCLAW_CONFIG_RELOAD_LOG_MAX_READ_BYTES", 256 * 1024);

const scanner = createConfigReloadLogScanner(logPath, {
  maxReadBytes,
  tailLineLimit: 160,
});
let result = { reloadLines: [], restartLines: [], tailLines: [] };

while (Date.now() < deadlineMs) {
  result = scanner.scan();
  if (result.restartLines.length > 0 || result.reloadLines.length > 0) {
    break;
  }
  await sleep(500);
}

if (result.restartLines.length > 0) {
  console.error(result.tailLines.join("\n"));
  throw new Error("unexpected restart-required reload line found");
}
for (const line of result.reloadLines) {
  for (const needle of ["gateway.auth.token", "plugins.entries.firecrawl.config.webFetch"]) {
    if (line.includes(needle)) {
      console.error(result.tailLines.join("\n"));
      throw new Error(`runtime-only path appeared in reload diff: ${needle}`);
    }
  }
}
if (result.reloadLines.length === 0) {
  console.error(result.tailLines.join("\n"));
  throw new Error("expected config reload detection log after metadata write");
}
