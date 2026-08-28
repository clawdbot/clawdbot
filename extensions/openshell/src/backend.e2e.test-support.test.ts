import { expect, it } from "vitest";
import { runCommand } from "./backend.e2e.test-support.js";

it.runIf(process.platform !== "win32")("reports a signal-killed probe as failure", async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
    allowFailure: true,
    timeoutMs: 10_000,
  });
  expect(result.code).not.toBe(0);
});
