// File Transfer tests cover canonical process-wrapper failures through dir fetch.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runCommandBufferedMock } = vi.hoisted(() => ({ runCommandBufferedMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandBuffered: runCommandBufferedMock,
}));

import { handleDirFetch } from "./dir-fetch.js";

let tmpRoot: string;

function commandResult(overrides: Record<string, unknown> = {}) {
  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

beforeEach(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dir-fetch-errors-")));
  await fs.writeFile(path.join(tmpRoot, "ok.txt"), "ok");
});

afterEach(async () => {
  runCommandBufferedMock.mockReset();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("dir.fetch process wrapper", () => {
  it("falls back to capped tar when the optional du probe fails", async () => {
    runCommandBufferedMock
      .mockRejectedValueOnce(new Error("du failed"))
      .mockResolvedValueOnce(commandResult({ stdout: Buffer.from("archive") }))
      .mockResolvedValueOnce(commandResult({ stdout: Buffer.from("./ok.txt\n") }));

    await expect(handleDirFetch({ path: tmpRoot, maxBytes: 1024 })).resolves.toMatchObject({
      ok: true,
      entries: ["ok.txt"],
    });
    expect(runCommandBufferedMock).toHaveBeenNthCalledWith(
      1,
      ["du", "-sk", tmpRoot],
      expect.objectContaining({ discardOutput: { stderr: true } }),
    );
  });

  it("uses capped tar output for preflight-only requests without returning the archive", async () => {
    runCommandBufferedMock.mockResolvedValueOnce(commandResult({ stdout: Buffer.from("archive") }));

    await expect(
      handleDirFetch({ path: tmpRoot, maxBytes: 1024, preflightOnly: true }),
    ).resolves.toMatchObject({
      ok: true,
      entries: ["ok.txt"],
      fileCount: 1,
      preflightOnly: true,
    });
    expect(runCommandBufferedMock).toHaveBeenCalledOnce();
    expect(runCommandBufferedMock).toHaveBeenCalledWith(
      [process.platform !== "win32" ? "/usr/bin/tar" : "tar", "-czf", "-", "-C", tmpRoot, "."],
      expect.objectContaining({
        discardOutput: { stderr: true },
        maxOutputBytes: { stdout: 1024, stderr: 64 * 1024 },
      }),
    );
  });

  it("rejects oversized preflight-only requests using the encoded tar limit", async () => {
    runCommandBufferedMock.mockResolvedValueOnce(
      commandResult({
        code: null,
        termination: "output-limit",
        outputLimitStream: "stdout",
      }),
    );

    await expect(
      handleDirFetch({ path: tmpRoot, maxBytes: 1024, preflightOnly: true }),
    ).resolves.toMatchObject({
      ok: false,
      code: "TREE_TOO_LARGE",
      message: "tarball exceeded 1024 byte limit during preflight",
    });
    expect(runCommandBufferedMock).toHaveBeenCalledOnce();
  });

  it("rejects preflight-only requests once filesystem listing crosses the entry cap", async () => {
    await Promise.all(
      Array.from({ length: 5001 }, (_, index) =>
        fs.writeFile(path.join(tmpRoot, `file-${index}.txt`), ""),
      ),
    );

    await expect(
      handleDirFetch({ path: tmpRoot, maxBytes: 1024, preflightOnly: true }),
    ).resolves.toMatchObject({
      ok: false,
      code: "TREE_TOO_LARGE",
      message: "directory tree exceeds 5000 entries during preflight",
    });
    expect(runCommandBufferedMock).not.toHaveBeenCalled();
  });

  it("preserves filesystem classification when a preflight tar race removes the directory", async () => {
    runCommandBufferedMock.mockImplementationOnce(async () => {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      return commandResult({ code: 1 });
    });

    await expect(
      handleDirFetch({ path: tmpRoot, maxBytes: 1024, preflightOnly: true }),
    ).resolves.toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("fails tar entry listing closed on wrapper errors", async () => {
    runCommandBufferedMock
      .mockResolvedValueOnce(commandResult({ stdout: Buffer.from("1\tproject\n") }))
      .mockResolvedValueOnce(commandResult({ stdout: Buffer.from("archive") }))
      .mockResolvedValueOnce(
        commandResult({ code: null, termination: "error", error: new Error("listing failed") }),
      );

    await expect(handleDirFetch({ path: tmpRoot, maxBytes: 1024 })).resolves.toMatchObject({
      ok: false,
      code: "READ_ERROR",
      message: "tar entry listing failed",
    });
  });

  it.each([
    {
      label: "output cap",
      result: commandResult({
        code: null,
        termination: "output-limit",
        outputLimitStream: "stdout",
      }),
      message: "tarball exceeded 1024 byte limit mid-stream",
    },
    {
      label: "timeout",
      result: commandResult({ code: null, termination: "timeout" }),
      message: "tar command exceeded 60s wall-clock timeout",
    },
    {
      label: "launch error",
      result: new Error("spawn failed"),
      message: "tar command failed",
    },
  ])("classifies $label failures through handleDirFetch", async ({ result, message }) => {
    runCommandBufferedMock.mockResolvedValueOnce(
      commandResult({ stdout: Buffer.from("1\tproject\n") }),
    );
    if (result instanceof Error) {
      runCommandBufferedMock.mockRejectedValueOnce(result);
    } else {
      runCommandBufferedMock.mockResolvedValueOnce(result);
    }

    const response = await handleDirFetch({ path: tmpRoot, maxBytes: 1024 });
    expect(response).toMatchObject({ ok: false, code: expect.any(String) });
    if (!response.ok) {
      expect(response.message).toContain(message);
    }
  });
});
