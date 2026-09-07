import { spawnSync } from "node:child_process";
// Covers process warning filtering and install idempotence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installProcessWarningFilter, shouldIgnoreWarning } from "./warning-filter.js";

const warningFilterKey = Symbol.for("openclaw.warning-filter");
const baseEmitWarning = process.emitWarning.bind(process);

function resetWarningFilterInstallState(): void {
  const globalState = globalThis as typeof globalThis & {
    [warningFilterKey]?: { installed: boolean };
  };
  delete globalState[warningFilterKey];
  process.emitWarning = baseEmitWarning;
}

async function flushWarnings(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("warning filter", () => {
  beforeEach(() => {
    resetWarningFilterInstallState();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    resetWarningFilterInstallState();
    vi.restoreAllMocks();
  });

  it("suppresses known deprecation and experimental warning signatures", () => {
    const ignoredWarnings = [
      {
        name: "DeprecationWarning",
        code: "DEP0040",
        message: "The punycode module is deprecated.",
      },
      {
        name: "DeprecationWarning",
        code: "DEP0060",
        message: "The `util._extend` API is deprecated.",
      },
      {
        name: "ExperimentalWarning",
        message: "SQLite is an experimental feature and might change at any time",
      },
    ];

    for (const warning of ignoredWarnings) {
      expect(shouldIgnoreWarning(warning)).toBe(true);
    }
  });

  it("keeps unknown warnings visible", () => {
    const visibleWarnings = [
      {
        name: "DeprecationWarning",
        code: "DEP9999",
        message: "Totally new warning",
      },
      {
        name: "ExperimentalWarning",
        message: "Different experimental warning",
      },
      {
        name: "DeprecationWarning",
        code: "DEP0040",
        message: "Different deprecated module",
      },
    ];

    for (const warning of visibleWarnings) {
      expect(shouldIgnoreWarning(warning)).toBe(false);
    }
  });

  it("routes only Node's warning printer at WARN across repeated capture setup", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-warning-filter-"));
    const logFile = path.join(tempDir, "warning.log");
    const marker = "OPENCLAW_WARNING_LEVEL_PROBE";
    const applicationMarker = "OPENCLAW_FORGED_WARNING_PREFIX_ERROR";
    const source = `
      process.on("warning", () => console.error("(" + process.release.name + ":" + process.pid + ") ${applicationMarker}"));
      const { installProcessWarningFilter } = await import("./src/infra/warning-filter.ts");
      const { enableConsoleCapture } = await import("./src/logging/console.ts");
      const { flushLogger, setLoggerOverride } = await import("./src/logging/logger.ts");
      setLoggerOverride({ level: "trace", file: process.env.OPENCLAW_WARNING_LOG, consoleLevel: "silent" });
      installProcessWarningFilter();
      enableConsoleCapture();
      enableConsoleCapture();
      process.emitWarning("${marker}", { code: "${marker}" });
      await new Promise((resolve) => setImmediate(resolve));
      await flushLogger();
    `;

    try {
      const childEnv: NodeJS.ProcessEnv = { ...process.env, OPENCLAW_WARNING_LOG: logFile };
      delete childEnv.NODE_OPTIONS;
      delete childEnv.NODE_REDIRECT_WARNINGS;
      delete childEnv.NODE_NO_WARNINGS;
      const result = spawnSync(
        process.execPath,
        ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", source],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: childEnv,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const records = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { message?: string; _meta?: { logLevelName?: string } });
      expect(records.find((record) => record.message?.includes(marker))?._meta?.logLevelName).toBe(
        "WARN",
      );
      expect(
        records.find((record) => record.message?.endsWith(applicationMarker))?._meta?.logLevelName,
      ).toBe("ERROR");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("installs once and suppresses known warnings at emit time", async () => {
    const seenWarnings: Array<{ code?: string; name: string; message: string }> = [];
    const onWarning = (warning: Error & { code?: string }) => {
      seenWarnings.push({
        code: warning.code,
        name: warning.name,
        message: warning.message,
      });
    };

    process.on("warning", onWarning);
    try {
      installProcessWarningFilter();
      installProcessWarningFilter();
      installProcessWarningFilter();
      const emitWarning = (...args: unknown[]) =>
        (process.emitWarning as unknown as (...warningArgs: unknown[]) => void)(...args);

      emitWarning(
        "The `util._extend` API is deprecated. Please use Object.assign() instead.",
        "DeprecationWarning",
        "DEP0060",
      );
      emitWarning("The `util._extend` API is deprecated. Please use Object.assign() instead.", {
        type: "DeprecationWarning",
        code: "DEP0060",
      });
      emitWarning(
        Object.assign(new Error("The punycode module is deprecated."), {
          name: "DeprecationWarning",
          code: "DEP0040",
        }),
      );
      emitWarning(new Error("SQLite is an experimental feature and might change at any time"), {
        type: "ExperimentalWarning",
      });
      await flushWarnings();
      expect(seenWarnings.find((warning) => warning.code === "DEP0060")).toBeUndefined();
      expect(seenWarnings.find((warning) => warning.code === "DEP0040")).toBeUndefined();
      expect(
        seenWarnings.find((warning) =>
          warning.message.includes("SQLite is an experimental feature"),
        ),
      ).toBeUndefined();

      emitWarning("Visible warning", { type: "Warning", code: "OPENCLAW_TEST_WARNING" });
      emitWarning(
        Object.assign(new Error("The punycode module is deprecated."), {
          name: "DeprecationWarning",
          code: "DEP0040",
        }),
        { type: "Warning", code: "OPENCLAW_VISIBLE_OVERRIDE" },
      );
      await flushWarnings();
      expect(
        seenWarnings.find((warning) => warning.code === "OPENCLAW_TEST_WARNING"),
      ).toStrictEqual({
        code: "OPENCLAW_TEST_WARNING",
        name: "Warning",
        message: "Visible warning",
      });
      expect(seenWarnings.find((warning) => warning.code === "DEP0040")).toStrictEqual({
        code: "DEP0040",
        name: "DeprecationWarning",
        message: "The punycode module is deprecated.",
      });
    } finally {
      process.off("warning", onWarning);
    }
  });
});
