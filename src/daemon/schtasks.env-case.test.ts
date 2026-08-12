// Windows schtasks fallback launch tests cover configured-env key precedence.
//
// The case-insensitive duplicate drop this guards is Node's own, in
// `child_process`, and Node selects that branch by reading `process.platform`
// at spawn time — so pointing it at "win32" runs the real Windows branch on any
// host instead of a model of it. What is not reproduced off Windows is the
// kernel's case-insensitive environment block: the spawned child looks keys up
// case-sensitively here, so its report is read back through the shipped
// `resolveEnvironmentValue(env, name, "win32")` precedence reader.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEnvironmentValue } from "../infra/process-env.js";
import "./test-helpers/schtasks-base-mocks.js";
import type { GatewayServiceEnv } from "./service-types.js";

const { buildTaskScript, encodeWindowsLauncherScript } = await import("./schtasks-layout.js");
const { launchFallbackTaskScript } = await import("./schtasks-runtime.js");

const CASE_KEY = "OPENCLAW_TASK_ENV_CASE";
const CONTROL_KEY = "OPENCLAW_TASK_ENV_CONTROL";

async function waitForLaunchedChildEnv(
  dumpPath: string,
): Promise<Record<string, string | undefined>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return JSON.parse(await fs.readFile(dumpPath, "utf8"));
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error("fallback task launch never reported its environment", { cause: error });
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }
}

describe("Windows scheduled task fallback launch environment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("launches with the configured env overriding an inherited key of another case", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "schtasks-env-case-"));
    try {
      const dumpPath = path.join(dir, "launched-env.json");
      const childScript = path.join(dir, "report-env.cjs");
      await fs.writeFile(
        childScript,
        [
          'const fs = require("node:fs");',
          "const observed = Object.entries(process.env).filter(([key]) =>",
          `  key.toUpperCase().startsWith("OPENCLAW_TASK_ENV_"),`,
          ");",
          `fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(Object.fromEntries(observed)));`,
        ].join("\n"),
        "utf8",
      );
      const scriptPath = path.join(dir, "gateway.cmd");
      await fs.writeFile(
        scriptPath,
        encodeWindowsLauncherScript({
          format: "cmd",
          content: buildTaskScript({
            programArguments: [process.execPath, childScript],
            environment: {
              // Windows keeps the lexicographically first case-insensitive
              // duplicate, so this spelling loses to the inherited upper-cased
              // key unless the merge drops the inherited spelling first.
              [CASE_KEY.toLowerCase()]: "configured",
              [CONTROL_KEY]: "control",
            },
          }),
        }),
      );
      const env: GatewayServiceEnv = { OPENCLAW_TASK_SCRIPT: scriptPath };

      vi.stubEnv(CASE_KEY, "inherited");
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      await launchFallbackTaskScript(env);

      const observed = await waitForLaunchedChildEnv(dumpPath);
      expect({
        overridden: resolveEnvironmentValue(observed, CASE_KEY, "win32"),
        control: resolveEnvironmentValue(observed, CONTROL_KEY, "win32"),
      }).toEqual({ overridden: "configured", control: "control" });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
