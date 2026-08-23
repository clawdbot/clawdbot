// Log tail tests cover reading, parsing, and limiting recent log entries.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetLogger, setLoggerOverride } from "../logging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const resolvedRedaction = { mode: "tools" as const, patterns: [/custom-secret-[a-z]+/g] };
type PositionalRead = (
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | null,
) => Promise<{ bytesRead: number; buffer: Buffer }>;

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
    vi.restoreAllMocks();
    resolveRedactOptionsMock.mockClear();
    redactSensitiveLinesMock.mockClear();
    resetLogger();
    setLoggerOverride(null);
  });

  it("applies redaction once per request across all returned lines", async () => {
    const { readConfiguredLogTail } = await import("./log-tail.js");
    const tempDir = tempDirs.make("openclaw-log-tail-");
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
  });

  it("fills short positional reads before splitting log lines", async () => {
    const { readConfiguredLogTail } = await import("./log-tail.js");
    const tempDir = tempDirs.make("openclaw-log-tail-");
    const file = path.join(tempDir, "openclaw-2026-01-22.log");
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const realRead = handle.read.bind(handle) as PositionalRead;
      const shortRead = vi.fn<PositionalRead>((buffer, offset, length, position) =>
        realRead(buffer, offset, Math.min(length, 4), position),
      );
      Object.defineProperty(handle, "read", { configurable: true, value: shortRead });
      return handle;
    });

    await fs.writeFile(file, "old line\nrecent one\nrecent two\n");
    setLoggerOverride({ file });

    const result = await readConfiguredLogTail();

    expect(result.lines).toEqual(["old line", "recent one", "recent two"]);
  });

  it("falls back only within the active profile's rolling log family", async () => {
    const tempDir = tempDirs.make("openclaw-log-tail-");
    const missing = path.join(tempDir, "openclaw-dev-2026-01-22.log");
    const devLog = path.join(tempDir, "openclaw-dev-2026-01-21.log");
    const defaultLog = path.join(tempDir, "openclaw-2026-01-21.log");
    await fs.writeFile(devLog, "dev profile\n");
    await fs.writeFile(defaultLog, "default profile\n");
    await fs.utimes(devLog, new Date(0), new Date(0));
    await fs.utimes(defaultLog, new Date(), new Date());
    const { resolveLogFile } = await import("./log-tail.js");
    const result = await resolveLogFile(missing, { rolling: true });

    expect(result).toBe(devLog);
  });

  it("does not reinterpret an explicit profile-shaped logging.file as rolling", async () => {
    const { readConfiguredLogTail } = await import("./log-tail.js");
    const tempDir = tempDirs.make("openclaw-log-tail-");
    const configured = path.join(tempDir, "openclaw-dev-2026-01-22.log");
    const sibling = path.join(tempDir, "openclaw-dev-2026-01-21.log");
    await fs.writeFile(sibling, "sibling profile log\n");
    setLoggerOverride({ file: configured });

    const result = await readConfiguredLogTail();

    expect(result.file).toBe(configured);
    expect(result.lines).toEqual([]);
  });
});
