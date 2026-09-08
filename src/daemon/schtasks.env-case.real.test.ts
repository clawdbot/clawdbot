import type { ChildProcess, SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildTaskScript, encodeWindowsLauncherScript } from "./schtasks-layout.js";
import { startStartupEntry } from "./schtasks-runtime.js";

type ChildEnvironment = { pid: number; value?: string; control?: string };
type LaunchedChild = {
  child: ChildProcess;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

const launchCapture = vi.hoisted(() => ({
  observe: undefined as ((child: ChildProcess, options?: SpawnOptions) => void) | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      launchCapture.observe?.(child, args[2]);
      return child;
    },
  };
});

describe("Windows Startup fallback environment", () => {
  it.for([
    { name: "different casing", key: "openclaw_test_fallback_case" },
    { name: "matching casing", key: "OPENCLAW_TEST_FALLBACK_CASE" },
  ])("preserves the saved override with $name", async ({ key }, context) => {
    if (process.platform !== "win32" && key !== key.toUpperCase()) {
      context.skip("Case-insensitive environment names require Windows");
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw fallback env "));
    const output = new PassThrough();
    output.resume();
    const children: LaunchedChild[] = [];
    onTestFinished(async () => {
      launchCapture.observe = undefined;
      output.end();
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
      }
      // Join the owned instances even after an assertion fails. An uncertain
      // close retains their inputs instead of treating PID disappearance as cleanup.
      await withTestTimeout(
        Promise.all(children.map(({ closed }) => closed)),
        10_000,
        "Startup fixture child did not close; retaining its directory",
      );
      await fs.rm(dir, { recursive: true });
    });
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
    launchCapture.observe = (child, options) => {
      if (options?.cwd !== dir && options?.env?.OPENCLAW_TASK_SCRIPT !== scriptPath) {
        return;
      }
      // Observe close at spawn, before Startup discards its child handle.
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.once("close", (code, signal) => resolve({ code, signal }));
        },
      );
      children.push({ child, closed });
    };
    await withEnvAsync({ OPENCLAW_TEST_FALLBACK_CASE: "inherited" }, async () => {
      await startStartupEntry({ OPENCLAW_TASK_SCRIPT: scriptPath }, output);
      expect(children).toHaveLength(1);
      const { child, closed } = expectDefined(children[0], "Startup fixture child");
      expect(await withTestTimeout(closed, 10_000, "Startup fixture child did not close")).toEqual({
        code: 0,
        signal: null,
      });
      const observed: ChildEnvironment = JSON.parse(await fs.readFile(reportPath, "utf8"));
      expect(observed.pid).toBe(child.pid);
      expect(observed.control).toBe("control");
      expect(observed.value, "PR122658_ENV_OVERRIDE_LOST").toBe("configured");
    });
  });
});
