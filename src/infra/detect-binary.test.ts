// Covers host binary detection command selection.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: runCommandWithTimeoutMock,
}));

import { detectBinary } from "./detect-binary.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  runCommandWithTimeoutMock.mockReset();
});

describe("detectBinary", () => {
  it("uses the trusted Windows where.exe when probing PATH", async () => {
    const accessSync = fs.accessSync.bind(fs);
    vi.spyOn(fs, "accessSync").mockImplementation((filePath, mode) => {
      if (String(filePath).toLowerCase() === "c:\\windows\\system32\\reg.exe") {
        throw new Error("registry lookup disabled for test");
      }
      return accessSync(filePath, mode);
    });
    vi.stubEnv("SystemRoot", "D:\\Windows");
    runCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "D:\\Tools\\openclaw.exe\n",
    });

    await withMockedWindowsPlatform(async () => {
      await expect(detectBinary("openclaw")).resolves.toBe(true);
    });

    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      [path.win32.join("D:\\Windows", "System32", "where.exe"), "openclaw"],
      { timeoutMs: 2000 },
    );
  });
});
