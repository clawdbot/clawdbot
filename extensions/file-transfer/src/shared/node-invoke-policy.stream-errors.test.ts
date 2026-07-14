// File Transfer tests cover archive-policy process-wrapper failures.
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectBoundedTextTail } from "./append-bounded-text-tail.js";

const { runCommandWithTimeoutMock } = vi.hoisted(() => ({
  runCommandWithTimeoutMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandWithTimeout: runCommandWithTimeoutMock,
}));

import { testing } from "./node-invoke-policy.js";

function commandResult(overrides: Record<string, unknown> = {}) {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

function mockCommandResult(overrides: Record<string, unknown> = {}) {
  runCommandWithTimeoutMock.mockImplementationOnce(
    async (
      _argv: string[],
      options: { onOutputChunk?: (chunk: Buffer, stream: string) => boolean | void },
    ) => {
      const stdout = typeof overrides.stdout === "string" ? overrides.stdout : "";
      const stopped = stdout
        ? options.onOutputChunk?.(Buffer.from(stdout), "stdout") === false
        : false;
      return commandResult({
        ...overrides,
        stdout: "",
        ...(stopped
          ? { code: null, killed: true, outputLimitExceeded: true, termination: "signal" }
          : {}),
      });
    },
  );
}

afterEach(() => {
  runCommandWithTimeoutMock.mockReset();
});

describe("dir.fetch archive policy process wrapper", () => {
  it("fails archive listing closed on wrapper errors", async () => {
    runCommandWithTimeoutMock.mockRejectedValueOnce(new Error("policy listing read failed"));

    await expect(
      testing.listDirFetchArchiveEntries({
        tarBase64: Buffer.from("archive").toString("base64"),
      }),
    ).resolves.toEqual({
      ok: false,
      code: "ARCHIVE_ENTRIES_UNREADABLE",
      reason: "tar -tzf error: policy listing read failed",
    });
  });

  it("normalizes successful archive entries", async () => {
    mockCommandResult({ stdout: "./ok.txt\n" });
    const archive = Buffer.from("archive");

    await expect(
      testing.listDirFetchArchiveEntries({ tarBase64: archive.toString("base64") }),
    ).resolves.toEqual({
      ok: true,
      entries: ["ok.txt"],
      sizeBytes: archive.byteLength,
      sha256: crypto.createHash("sha256").update(archive).digest("hex"),
    });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ tolerateOutputError: { stderr: true } }),
    );
  });

  it("surfaces a UTF-16-safe stderr tail on nonzero exit", async () => {
    const oldNoise = "n".repeat(250);
    const recent = "🤖" + "f".repeat(199);
    mockCommandResult({ code: 2, stderr: oldNoise + recent });

    const result = await testing.listDirFetchArchiveEntries({
      tarBase64: Buffer.from("archive").toString("base64"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(projectBoundedTextTail(recent, 200));
      expect(result.reason).not.toContain("🤖");
    }
  });

  it("stops archive listing as soon as the entry cap is crossed", async () => {
    mockCommandResult({
      stdout: Array.from({ length: 5_001 }, (_, index) => `file-${index}`).join("\n") + "\n",
    });

    await expect(
      testing.listDirFetchArchiveEntries({
        tarBase64: Buffer.from("archive").toString("base64"),
      }),
    ).resolves.toMatchObject({ ok: false, code: "ARCHIVE_ENTRIES_TOO_MANY" });
  });
});
