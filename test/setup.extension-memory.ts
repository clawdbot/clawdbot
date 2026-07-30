// Memory extension suites can spend several minutes importing/indexing before
// Vitest emits test results on hosted runners. Keep the child process chatty so
// the repo watchdog does not mistake a live run for a stalled one.
import { afterAll } from "vitest";

const MEMORY_EXTENSION_KEEPALIVE_MS = 120_000;

const memoryExtensionProgressTimer = setInterval(() => {
  process.stderr.write("[extension-memory] still running\n");
}, MEMORY_EXTENSION_KEEPALIVE_MS);
memoryExtensionProgressTimer.unref?.();

afterAll(() => {
  clearInterval(memoryExtensionProgressTimer);
});
