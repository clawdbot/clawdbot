// File Transfer tests cover dir fetch tar validation through the tool boundary.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectBoundedTextTail } from "../shared/append-bounded-text-tail.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dir-fetch-tool-test-")));
});

afterEach(async () => {
  vi.doUnmock("openclaw/plugin-sdk/media-store");
  vi.doUnmock("openclaw/plugin-sdk/process-runtime");
  vi.doUnmock("../shared/audit.js");
  vi.doUnmock("./node-tool-invoke.js");
  vi.resetModules();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

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

type MockCommandResult = Record<string, unknown> & {
  outputByteLength?: number;
};

async function importToolWithCommandResults(tarBuffer: Buffer, ...results: MockCommandResult[]) {
  const runCommandWithTimeout = vi.fn();
  for (const result of results) {
    runCommandWithTimeout.mockImplementationOnce(
      async (
        _argv: string[],
        options: { onOutputChunk?: (chunk: Buffer, stream: string) => boolean | void },
      ) => {
        if (result.error instanceof Error && result.termination === "error") {
          throw result.error;
        }
        let stopped = false;
        const stdout = typeof result.stdout === "string" ? result.stdout : "";
        if (stdout) {
          stopped = options.onOutputChunk?.(Buffer.from(stdout), "stdout") === false;
        } else if (typeof result.outputByteLength === "number") {
          stopped =
            options.onOutputChunk?.({ byteLength: result.outputByteLength } as Buffer, "stdout") ===
            false;
        }
        return commandResult({
          ...result,
          stdout: "",
          ...(stopped
            ? { code: null, killed: true, outputLimitExceeded: true, termination: "signal" }
            : {}),
        });
      },
    );
  }
  runCommandWithTimeout.mockResolvedValue(commandResult());
  vi.resetModules();
  vi.doMock("openclaw/plugin-sdk/process-runtime", () => ({
    runCommandWithTimeout,
  }));
  vi.doMock("openclaw/plugin-sdk/media-store", () => ({
    saveMediaBuffer: vi.fn(async () => ({ path: path.join(tmpRoot, "archive.tar.gz") })),
  }));
  vi.doMock("../shared/audit.js", () => ({
    appendFileTransferAudit: vi.fn(async () => undefined),
  }));
  vi.doMock("./node-tool-invoke.js", () => ({
    readRequiredNodePath: (params: Record<string, unknown>) => ({
      node: String(params.node),
      requestedPath: String(params.path),
    }),
    invokeNodeToolPayload: vi.fn(async () => ({
      nodeId: "node-1",
      nodeDisplayName: "Node One",
      payload: {
        ok: true,
        path: "/tmp/project",
        tarBase64: tarBuffer.toString("base64"),
        tarBytes: tarBuffer.byteLength,
        sha256: crypto.createHash("sha256").update(tarBuffer).digest("hex"),
        fileCount: 1,
      },
      startedAt: Date.now(),
    })),
  }));
  return {
    module: await import("./dir-fetch-tool.js"),
    runCommandWithTimeout,
  };
}

async function executeDirFetch(module: typeof import("./dir-fetch-tool.js")) {
  return await module.createDirFetchTool().execute("tool-call-1", {
    node: "node-1",
    path: "/tmp/project",
  });
}

const validListingResults = [{ stdout: "./ok.txt\n" }, { stdout: "-ok.txt\n" }] as const;

describe("dir.fetch tar validation", () => {
  it("rejects an archive before extraction when expanded bytes exceed budget", async () => {
    const { module } = await importToolWithCommandResults(
      Buffer.from("archive"),
      ...validListingResults,
      { outputByteLength: 64 * 1024 * 1024 + 1 },
    );

    await expect(executeDirFetch(module)).rejects.toThrow(
      "dir.fetch UNCOMPRESSED_TOO_LARGE: archive expands past uncompressed budget 67108864 bytes",
    );
  });

  it("fails uncompressed budget checks closed on wrapper errors", async () => {
    const { module, runCommandWithTimeout } = await importToolWithCommandResults(
      Buffer.from("archive"),
      ...validListingResults,
      {
        code: null,
        termination: "error",
        error: new Error("budget read failed"),
      },
    );

    await expect(executeDirFetch(module)).rejects.toThrow(
      "dir.fetch UNCOMPRESSED_TOO_LARGE: tar uncompressed budget validation error: budget read failed",
    );
    expect(runCommandWithTimeout).toHaveBeenLastCalledWith(
      expect.any(Array),
      expect.objectContaining({ tolerateOutputError: { stderr: true } }),
    );
  });

  it("fails tar listing closed on wrapper errors", async () => {
    const { module } = await importToolWithCommandResults(Buffer.from("archive"), {
      code: null,
      termination: "error",
      error: new Error("listing read failed"),
    });

    await expect(executeDirFetch(module)).rejects.toThrow(
      "dir.fetch UNSAFE_ARCHIVE: tar -tzf error: listing read failed",
    );
  });

  it("accepts successful validation and unpack", async () => {
    const { module, runCommandWithTimeout } = await importToolWithCommandResults(
      Buffer.from("archive"),
      ...validListingResults,
      {},
      {},
    );

    await expect(executeDirFetch(module)).resolves.toMatchObject({
      details: {
        path: "/tmp/project",
        fileCount: 1,
      },
    });
    expect(runCommandWithTimeout).toHaveBeenLastCalledWith(
      expect.any(Array),
      expect.objectContaining({
        outputCapture: { stdout: "discard", stderr: "tail" },
        tolerateOutputError: { stderr: true },
      }),
    );
  });

  it("keeps tar exit diagnostics", async () => {
    const { module } = await importToolWithCommandResults(Buffer.from("archive"), {
      code: 2,
      stderr: "invalid archive",
    });

    await expect(executeDirFetch(module)).rejects.toThrow(
      "dir.fetch UNSAFE_ARCHIVE: tar -tzf exited 2: invalid archive",
    );
  });

  it("stops name validation at the entry cap", async () => {
    const tarLines = Array.from({ length: 5001 }, (_, index) => `file-${index}`).join("\n") + "\n";
    const { module, runCommandWithTimeout } = await importToolWithCommandResults(
      Buffer.from("archive"),
      { stdout: tarLines },
    );

    await expect(executeDirFetch(module)).rejects.toThrow(
      "dir.fetch UNSAFE_ARCHIVE: archive contains 5001 entries; limit 5000",
    );
    expect(runCommandWithTimeout).toHaveBeenCalledOnce();
  });

  it("keeps recent tar stderr when listing fails noisily", async () => {
    const oldNoise = "old-noise\n".repeat(600);
    const recent = "recent-invalid-archive-details\n".repeat(12);
    const { module } = await importToolWithCommandResults(Buffer.from("archive"), {
      code: 2,
      stderr: oldNoise + recent,
    });

    await expect(executeDirFetch(module)).rejects.toThrow(projectBoundedTextTail(recent, 200));
  });

  it("surfaces a UTF-16-safe tar stderr tail", async () => {
    const oldNoise = "n".repeat(250);
    const recent = "🤖" + "f".repeat(199);
    const { module } = await importToolWithCommandResults(Buffer.from("archive"), {
      code: 2,
      stderr: oldNoise + recent,
    });

    let message = "";
    try {
      await executeDirFetch(module);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(projectBoundedTextTail(recent, 200));
    expect(message).toContain("f".repeat(199));
    expect(message).not.toContain("🤖");
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(message),
    ).toBe(false);
  });
});
