import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { waitForDead } from "../../test/helpers/process-wait.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildTaskScript, encodeWindowsLauncherScript } from "./schtasks-layout.js";
import { startStartupEntry } from "./schtasks-runtime.js";

type ChildEnvironment = { pid: number; value?: string; control?: string };

async function waitForChildEnvironment(filePath: string): Promise<ChildEnvironment> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline) {
        throw error;
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

describe.runIf(process.platform === "win32")("Windows Startup fallback environment", () => {
  it.each([
    { name: "different casing", key: "openclaw_test_fallback_case" },
    { name: "matching casing", key: "OPENCLAW_TEST_FALLBACK_CASE" },
  ])("preserves the saved override with $name", async ({ key }) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw fallback env "));
    const output = new PassThrough();
    output.resume();
    let childExited = false;
    try {
      const reportPath = path.join(dir, "child.json");
      const childPath = path.join(dir, "report-env.cjs");
      await fs.writeFile(
        childPath,
        `
const fs = require("node:fs");
const file = process.argv[2];
fs.writeFileSync(file + ".tmp", JSON.stringify({
  pid: process.pid,
  value: process.env.OPENCLAW_TEST_FALLBACK_CASE,
  control: process.env.OPENCLAW_TEST_FALLBACK_CONTROL,
}));
fs.renameSync(file + ".tmp", file);
`,
      );
      const scriptPath = path.join(dir, "gateway.cmd");
      await fs.writeFile(
        scriptPath,
        encodeWindowsLauncherScript({
          format: "cmd",
          content: buildTaskScript({
            programArguments: [process.execPath, childPath, reportPath],
            workingDirectory: dir,
            environment: {
              [key]: "configured",
              OPENCLAW_TEST_FALLBACK_CONTROL: "control",
            },
          }),
        }),
      );
      await withEnvAsync({ OPENCLAW_TEST_FALLBACK_CASE: "inherited" }, async () => {
        await startStartupEntry({ OPENCLAW_TASK_SCRIPT: scriptPath }, output);
        const observed = await waitForChildEnvironment(reportPath);
        expect(Number.isSafeInteger(observed.pid) && observed.pid > 0).toBe(true);
        await waitForDead(observed.pid, 10_000);
        childExited = true;
        expect(observed.control).toBe("control");
        expect(observed.value, "PR122658_ENV_OVERRIDE_LOST").toBe("configured");
      });
    } finally {
      output.end();
      if (childExited) {
        await fs.rm(dir, { recursive: true });
      }
    }
  });
});
