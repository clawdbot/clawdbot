import { runLiveCacheRegression } from "../src/agents/live-cache-regression-runner.js";
import { LIVE_CACHE_TEST_ENABLED, logLiveCache } from "../src/agents/live-cache-test-support.js";

if (!LIVE_CACHE_TEST_ENABLED) {
  logLiveCache("skipped; set OPENCLAW_LIVE_TEST=1 and OPENCLAW_LIVE_CACHE_TEST=1");
  process.exit(0);
}

const result = await runLiveCacheRegression();
if (result.warnings.length > 0) {
  process.stderr.write("\n[live-cache] non-blocking cache observations:\n");
  for (const warning of result.warnings) {
    process.stderr.write(`- ${warning}\n`);
  }
}
if (result.regressions.length > 0) {
  process.stderr.write("\n[live-cache] regressions detected:\n");
  for (const regression of result.regressions) {
    process.stderr.write(`- ${regression}\n`);
  }
  process.exitCode = 1;
} else {
  process.stderr.write("\n[live-cache] all regression floors satisfied\n");
}
