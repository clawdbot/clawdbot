// Log tail tests cover reading, parsing, and limiting recent log entries.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging.js";

const resolvedRedaction = { mode: "tools" as const, patterns: [/custom-secret-[a-z]+/g] };

const { redactSensitiveLinesMock, resolveRedactOptionsMock } = vi.hoisted(() => ({
  redactSensitiveLinesMock: vi.fn((lines: string[], options?: unknown) =>
    options === resolvedRedaction
      ? lines.map((line) => line.replace("custom-secret-abcdefghijklmnopqrstuvwxyz", "custom…wxyz"))
      : lines,
  ),
  resolveRedactOptionsMock: vi.fn(() => resolvedRedaction),
}));

vi.mock("./redact.js", async () => {
  const actual = await vi.importActual<typeof import("./redact.js")>("./redact.js");
  return {
    ...actual,
    redactSensitiveLines: (lines: string[], options?: unknown) =>
      redactSensitiveLinesMock(lines, options),
    resolveRedactOptions: () => resolveRedactOptionsMock(),
  };
});

describe("readConfiguredLogTail", () => {
  afterEach(() => {
    resolveRedactOptionsMock.mockClear();
    redactSensitiveLinesMock.mockClear();
    resetLogger();
    setLoggerOverride(null);
  });

  it("applies redaction once per request across all returned lines", async () => {
    const { readConfiguredLogTail } = await import("./log-tail.js");
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-log-tail-"));
    const file = path.join(tempDir, "openclaw-2026-01-22.log");

    await fs.writeFile(file, "custom-secret-abcdefghijklmnopqrstuvwxyz\nsecond line\n");
    setLoggerOverride({ file });

    const result = await readConfiguredLogTail();

    expect(resolveRedactOptionsMock).toHaveBeenCalledTimes(1);
    expect(redactSensitiveLinesMock).toHaveBeenCalledTimes(1);
    expect(redactSensitiveLinesMock).toHaveBeenCalledWith(
      ["custom-secret-abcdefghijklmnopqrstuvwxyz", "second line"],
      resolvedRedaction,
    );
    expect(result.lines).toEqual(["custom…wxyz", "second line"]);

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
