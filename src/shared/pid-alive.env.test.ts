import childProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDiagnosticFixtureRouting,
  diagnosticCanaries,
  diagnosticEnvReportScript,
  withSyntheticDiagnosticEnv,
} from "../infra/diagnostic-env.test-support.js";
import { getFileLockProcessStartTime } from "./pid-alive.js";

afterEach(() => vi.restoreAllMocks());

it("isolates the lock-owner ps child while retaining its stable locale and timezone", async () => {
  const nativeExec = childProcess.execFileSync;
  const routing = createDiagnosticFixtureRouting({
    PATH: "/fixture/bin",
    HOME: "/fixture/home",
    LC_ALL: "C",
    TZ: "UTC",
  });
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  await withSyntheticDiagnosticEnv(
    { ...routing, LC_ALL: "fr_FR.UTF-8", TZ: "Pacific/Honolulu" },
    async () => {
      let report: unknown;
      const parent = { ...process.env };
      vi.spyOn(childProcess, "execFileSync").mockImplementation((_file, _args, options) => {
        const stdout = nativeExec(
          process.execPath,
          ["-e", `process.stdout.write(${diagnosticEnvReportScript(routing)})`],
          { env: options?.env, encoding: "utf8", timeout: 5000 },
        );
        report = JSON.parse(stdout);
        return "Thu Sep  3 00:00:00 2026\n";
      });
      expect(getFileLockProcessStartTime(424242)).toBe(Date.parse("2026-09-03T00:00:00Z") / 1000);
      expect(process.env).toEqual(parent);
      expect(report).toEqual({
        present: Object.fromEntries(Object.keys(diagnosticCanaries).map((key) => [key, false])),
        routingPreserved: true,
      });
    },
  );
});
