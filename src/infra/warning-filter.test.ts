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
  await new Promise((resolve) => setImmediate(resolve));
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
