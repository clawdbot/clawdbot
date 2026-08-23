import { afterEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => childProcess);
vi.mock("./resolve-system-bin.js", () => ({
  resolveSystemBin: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
}));
vi.mock("./windows-encoding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./windows-encoding.js")>();
  return {
    ...actual,
    decodeWindowsOutputBuffer: (params: { buffer: Buffer }) =>
      actual.decodeWindowsOutputBuffer({ ...params, platform: "win32", windowsEncoding: "gbk" }),
  };
});

import {
  createPrivateSqliteDirectory,
  createPrivateSqliteTempDirectorySync,
} from "./sqlite-private-directory.js";

function errorCause(error: unknown): Error {
  expect(error).toBeInstanceOf(Error);
  const cause = (error as Error & { cause?: unknown }).cause;
  expect(cause).toBeInstanceOf(Error);
  return cause as Error;
}

describe("private Windows SQLite directory diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    childProcess.execFile.mockReset();
    childProcess.execFileSync.mockReset();
  });

  it("reports bounded async stderr without retaining the child-process error", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const original = Object.assign(
      new Error("Command failed: powershell -EncodedCommand secret-payload"),
      {
        cmd: "powershell -EncodedCommand secret-payload",
        code: 7,
        killed: true,
        signal: "SIGTERM",
      },
    );
    childProcess.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(
        original,
        Buffer.from("stdout fallback"),
        Buffer.concat([
          Buffer.from([0xb2, 0xe2, 0xca, 0xd4]),
          Buffer.from(
            ` useful stderr\n-EncodedCommand secret\nbenign after redaction ${"tail ".repeat(250)}`,
          ),
        ]),
      );
    });

    const error = await createPrivateSqliteDirectory("C:\\private").catch(
      (cause: unknown) => cause,
    );
    const cause = errorCause(error);
    expect(cause.message).toContain("exit=7, killed=true, signal=SIGTERM");
    expect(cause.message).toContain("测试");
    expect(cause.message).toContain("stderr: 测试 useful stderr");
    expect(cause.message).toContain("benign after redaction");
    expect(cause.message).not.toContain("stdout fallback");
    expect(cause.message).not.toContain("EncodedCommand");
    expect(cause.message.length).toBeLessThanOrEqual(1100);
    expect(cause).not.toBe(original);
    expect((cause as Error & { cause?: unknown; cmd?: unknown }).cause).toBeUndefined();
    expect((cause as Error & { cmd?: unknown }).cmd).toBeUndefined();
  });

  it("reports sync status and string codes from sanitized stderr", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    childProcess.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error("powershell -EncodedCommand secret"), {
        code: "ETIMEDOUT",
        status: 1,
        stderr: Buffer.from("native directory creation failed"),
        stdout: Buffer.from("stdout fallback"),
      });
    });

    let error: unknown;
    try {
      createPrivateSqliteTempDirectorySync("C:\\root", "stage-");
    } catch (cause) {
      error = cause;
    }
    expect(errorCause(error).message).toBe(
      "PowerShell failed (status=1, code=ETIMEDOUT); stderr: native directory creation failed",
    );
  });

  it("preserves the EEXIST contract from child output", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    childProcess.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error("failed"), "", "OPENCLAW_SQLITE_DIRECTORY_EXISTS");
    });

    const error = await createPrivateSqliteDirectory("C:\\existing").catch(
      (cause: unknown) => cause,
    );
    expect(error).toMatchObject({
      code: "EEXIST",
      message: "Private SQLite directory already exists: C:\\existing",
    });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });
});
