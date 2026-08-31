// Log tail tests cover reading, parsing, and limiting recent log entries.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetLogger, setLoggerOverride } from "../logging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const metadataBoundaries = [
  "configured stat",
  "rolling readdir",
  "candidate stat",
  "final stat",
] as const;
const operationalErrorCodes = ["EACCES", "EIO", "EMFILE"] as const;
const operationalMetadataFailures = metadataBoundaries.flatMap((boundary) =>
  operationalErrorCodes.map((code) => ({ boundary, code })),
);

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

  it("holds an unterminated record until a later read completes it", async () => {
    const { readConfiguredLogTail } = await import("./log-tail.js");
    const tempDir = tempDirs.make("openclaw-log-tail-");
    const file = path.join(tempDir, "openclaw-2026-01-22.log");
    const completePrefix = "complete-before ✅\n";

    await fs.writeFile(file, `${completePrefix}partial`);
    setLoggerOverride({ file });

    const initial = await readConfiguredLogTail();
    expect(initial).toMatchObject({
      lines: ["complete-before ✅"],
      cursor: Buffer.byteLength(completePrefix),
    });

    await fs.appendFile(file, "-completed\n");
    const continuation = await readConfiguredLogTail({ cursor: initial.cursor });

    expect(continuation).toMatchObject({
      lines: ["partial-completed"],
      cursor: Buffer.byteLength(`${completePrefix}partial-completed\n`),
    });
  });

  it("reports truncation when the line limit omits complete records", async () => {
    const { readConfiguredLogTail } = await import("./log-tail.js");
    const tempDir = tempDirs.make("openclaw-log-tail-");
    const file = path.join(tempDir, "openclaw-2026-01-22.log");
    const content = "one\ntwo\nthree\n";

    await fs.writeFile(file, content);
    setLoggerOverride({ file });

    const result = await readConfiguredLogTail({ limit: 2, maxBytes: 100 });

    expect(result).toMatchObject({
      lines: ["two", "three"],
      cursor: Buffer.byteLength(content),
      size: Buffer.byteLength(content),
      truncated: true,
      reset: false,
    });
  });

  it("distinguishes a byte-budget re-anchor from file shrink", async () => {
    const { readConfiguredLogTail } = await import("./log-tail.js");
    const tempDir = tempDirs.make("openclaw-log-tail-");
    const file = path.join(tempDir, "openclaw-2026-01-22.log");

    await fs.writeFile(file, "first line\n");
    setLoggerOverride({ file });
    const initial = await readConfiguredLogTail();

    await fs.appendFile(file, `${"x".repeat(40)}\n`.repeat(200));
    const byteBudget = await readConfiguredLogTail({ cursor: initial.cursor, maxBytes: 500 });

    expect(byteBudget).toMatchObject({ truncated: true, reset: true });
    expect(byteBudget.skippedBytes).toBeGreaterThan(0);

    await fs.writeFile(file, "fresh\n");
    const fileShrink = await readConfiguredLogTail({ cursor: byteBudget.cursor, maxBytes: 500 });

    expect(fileShrink).toMatchObject({ reset: true });
    expect(fileShrink.skippedBytes).toBeUndefined();
  });

  it("keeps the first line when the byte window starts exactly after a newline", async () => {
    const { readConfiguredLogTail } = await import("./log-tail.js");
    const tempDir = tempDirs.make("openclaw-log-tail-");
    const file = path.join(tempDir, "openclaw-2026-01-22.log");
    const line = (message: string) => `${message}${" ".repeat(199 - message.length)}\n`;
    const content = Array.from({ length: 10_000 }, (_, index) =>
      line(index === 5000 ? "first-line-in-window" : "filler"),
    ).join("");

    await fs.writeFile(file, content);
    setLoggerOverride({ file });

    const result = await readConfiguredLogTail({ limit: 5000, maxBytes: 1_000_000 });

    expect(result.lines).toHaveLength(5000);
    expect(result.lines[0]?.trimEnd()).toBe("first-line-in-window");
  });

  it.each(operationalMetadataFailures)(
    "rethrows $code from the $boundary boundary",
    async ({ boundary, code }) => {
      const tempDir = tempDirs.make("openclaw-log-tail-");
      const configured = path.join(tempDir, "openclaw-2026-01-22.log");
      const candidate = path.join(tempDir, "openclaw-2026-01-21.log");
      const error = Object.assign(new Error(`${code} injected`), { code });
      const realStat = fs.stat.bind(fs);

      if (boundary === "candidate stat") {
        await fs.writeFile(candidate, "candidate\n");
      } else if (boundary !== "rolling readdir") {
        await fs.writeFile(configured, "configured\n");
      }
      setLoggerOverride({ file: configured });

      if (boundary === "configured stat") {
        vi.spyOn(fs, "stat").mockRejectedValueOnce(error);
      } else if (boundary === "rolling readdir") {
        vi.spyOn(fs, "readdir").mockRejectedValueOnce(error);
      } else if (boundary === "candidate stat") {
        vi.spyOn(fs, "stat").mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
          if (String(args[0]) === candidate) {
            throw error;
          }
          return realStat(...args);
        });
      } else {
        vi.spyOn(fs, "stat")
          .mockImplementationOnce((...args: Parameters<typeof fs.stat>) => realStat(...args))
          .mockRejectedValueOnce(error);
      }

      const { readConfiguredLogTail } = await import("./log-tail.js");
      await expect(readConfiguredLogTail()).rejects.toBe(error);
    },
  );

  it("falls back only within the active profile's rolling log family", async () => {
    const tempDir = tempDirs.make("openclaw-log-tail-");
    const missing = path.join(tempDir, "openclaw-2026-01-22.log");
    const defaultLog = path.join(tempDir, "openclaw-2026-01-21.log");
    const devLog = path.join(tempDir, "openclaw-dev-2026-01-21.log");
    await fs.writeFile(defaultLog, "default profile\n");
    await fs.writeFile(devLog, "dev profile\n");
    await fs.utimes(defaultLog, new Date(0), new Date(0));
    await fs.utimes(devLog, new Date(), new Date());
    setLoggerOverride({ file: missing });

    const { readConfiguredLogTail } = await import("./log-tail.js");
    const result = await readConfiguredLogTail();

    expect(result.file).toBe(defaultLog);
    expect(result.lines).toEqual(["default profile"]);
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
