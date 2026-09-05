import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createProcessTool } from "./bash-tools.process.js";

afterEach(resetProcessRegistryForTests);

function nodeCommand(source: string): string {
  const quote = (value: string) =>
    `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  const command = `${quote(process.execPath)} -e ${quote(source)}`;
  return process.platform === "win32" ? `& ${command}` : command;
}

test.each([
  { label: "explicit background", args: { background: true } },
  { label: "elapsed yield window", args: { yieldMs: 10 } },
])("provides a usable structured follow-up route after $label", async ({ label, args }) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "exec-followup-")));
  const releasePath = path.join(directory, "release");
  const scopeKey = `agent:main:followup-${label}`;
  const exec = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    allowBackground: true,
    notifyOnExit: false,
    timeoutSec: 5,
    scopeKey,
  });
  const processTool = createProcessTool({ scopeKey });
  // A parent-owned file releases the child only after the background result is observed.
  const command = nodeCommand(
    `const fs = require("node:fs"); const timer = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(releasePath)})) {
        clearInterval(timer); process.stdout.write("FOLLOWUP_COMPLETE");
      }
    }, 10);`,
  );
  try {
    const started = await exec.execute("followup-start", { command, ...args });
    expect(started.details.status).toBe("running");
    if (started.details.status !== "running") {
      throw new Error("Expected a background process handle");
    }
    expect(started.details).toMatchObject({ followUp: expect.stringContaining("Use process") });
    const followUp = started.details.followUp;
    expect(followUp).toContain("poll");
    if (!followUp) {
      throw new Error("Expected a structured follow-up route");
    }
    expect(started.content).toContainEqual({
      type: "text",
      text: expect.stringContaining(followUp),
    });

    await fs.writeFile(releasePath, "release");
    await waitForExecScope(scopeKey);
    const completed = await processTool.execute("followup-poll", {
      action: "poll",
      sessionId: started.details.sessionId,
    });
    expect(completed.details).toMatchObject({
      status: "completed",
      sessionId: started.details.sessionId,
      aggregated: "FOLLOWUP_COMPLETE",
    });
  } finally {
    await fs.writeFile(releasePath, "release");
    await waitForExecScope(scopeKey);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("does not advertise detached continuation when process is unavailable", async () => {
  const exec = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    processToolAvailabilityRef: { value: false },
    notifyOnExit: false,
  });
  const result = await exec.execute("followup-foreground", {
    command: nodeCommand('process.stdout.write("FOREGROUND_COMPLETE")'),
    background: true,
  });
  expect(result.details).toMatchObject({ status: "completed", aggregated: "FOREGROUND_COMPLETE" });
  expect(result.details).not.toHaveProperty("followUp");
});
