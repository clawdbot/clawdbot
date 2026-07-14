// File Transfer tests cover dir fetch tar validation through the canonical process wrapper.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectBoundedTextTail } from "../shared/append-bounded-text-tail.js";
import { validateTarUncompressedBudget } from "./dir-fetch-tool.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dir-fetch-tool-test-")));
});

afterEach(async () => {
  vi.doUnmock("openclaw/plugin-sdk/process-runtime");
  vi.resetModules();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function tarDirectory(dir: string): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const tarBin = process.platform !== "win32" ? "/usr/bin/tar" : "tar";
    const child = spawn(tarBin, ["-czf", "-", "-C", dir, "."], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`tar exited ${code}: ${stderr}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    child.on("error", reject);
  });
}

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

function bufferedCommandResult(overrides: Record<string, unknown> = {}) {
  return {
    ...commandResult(),
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    ...overrides,
  };
}

async function importWithCommandResults(...results: Array<Record<string, unknown>>) {
  const runCommandBuffered = vi.fn().mockResolvedValue(bufferedCommandResult());
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
        const stdout = typeof result.stdout === "string" ? result.stdout : "";
        const stopped = stdout
          ? options.onOutputChunk?.(Buffer.from(stdout), "stdout") === false
          : false;
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
    runCommandBuffered,
    runCommandWithTimeout,
  }));
  return {
    module: await import("./dir-fetch-tool.js"),
    runCommandBuffered,
    runCommandWithTimeout,
  };
}

const testUnlessWindows = process.platform === "win32" ? it.skip : it;

describe("validateTarUncompressedBudget", () => {
  testUnlessWindows(
    "rejects an archive before extraction when expanded bytes exceed budget",
    async () => {
      await fs.writeFile(path.join(tmpRoot, "zeros.txt"), "0".repeat(128));
      const tarBuffer = await tarDirectory(tmpRoot);

      await expect(validateTarUncompressedBudget(tarBuffer, 64)).resolves.toEqual({
        ok: false,
        reason: "archive expands past uncompressed budget 64 bytes",
      });
      await expect(validateTarUncompressedBudget(tarBuffer, 256)).resolves.toEqual({ ok: true });
    },
  );

  it("fails closed on wrapper errors", async () => {
    const { module, runCommandWithTimeout } = await importWithCommandResults({
      code: null,
      termination: "error",
      error: new Error("budget read failed"),
    });

    await expect(module.testing.validateTarUncompressedBudget(Buffer.from("x"))).resolves.toEqual({
      ok: false,
      reason: "tar uncompressed budget validation error: budget read failed",
    });
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ tolerateOutputError: { stderr: true } }),
    );
  });
});

describe("dir.fetch tar validation", () => {
  it("fails tar listing closed on wrapper errors", async () => {
    const { module } = await importWithCommandResults({
      code: null,
      termination: "error",
      error: new Error("listing read failed"),
    });

    await expect(module.testing.preValidateTarball(Buffer.from("x"))).resolves.toEqual({
      ok: false,
      reason: "tar -tzf error: listing read failed",
    });
  });

  it("accepts successful unpack", async () => {
    const { module, runCommandWithTimeout } = await importWithCommandResults();

    await expect(module.testing.unpackTar(Buffer.from("x"), tmpRoot)).resolves.toBeUndefined();
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        outputCapture: { stdout: "discard", stderr: "tail" },
        tolerateOutputError: { stderr: true },
      }),
    );
  });

  it("keeps tar exit diagnostics", async () => {
    const { module } = await importWithCommandResults({
      code: 2,
      stderr: "invalid archive",
    });

    await expect(module.testing.preValidateTarball(Buffer.from("x"))).resolves.toEqual({
      ok: false,
      reason: "tar -tzf exited 2: invalid archive",
    });
  });

  it("stops name validation at the entry cap", async () => {
    const tarLines = Array.from({ length: 5001 }, (_, index) => `file-${index}`).join("\n") + "\n";
    const { module, runCommandWithTimeout } = await importWithCommandResults({
      stdout: tarLines,
    });

    await expect(module.testing.preValidateTarball(Buffer.from("x"))).resolves.toEqual({
      ok: false,
      reason: "archive contains 5001 entries; limit 5000",
    });
    expect(runCommandWithTimeout).toHaveBeenCalledOnce();
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ tolerateOutputError: { stderr: true } }),
    );
  });

  it("keeps recent tar stderr when listing fails noisily", async () => {
    const oldNoise = "old-noise\n".repeat(600);
    const recent = "recent-invalid-archive-details\n".repeat(12);
    const { module } = await importWithCommandResults({
      code: 2,
      stderr: oldNoise + recent,
    });

    const result = await module.testing.preValidateTarball(Buffer.from("x"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(projectBoundedTextTail(recent, 200));
      expect(result.reason).not.toContain(oldNoise.slice(0, 40));
    }
  });

  it("surfaces a UTF-16-safe tar stderr tail", async () => {
    const oldNoise = "n".repeat(250);
    const recent = "🤖" + "f".repeat(199);
    const { module } = await importWithCommandResults({
      code: 2,
      stderr: oldNoise + recent,
    });

    const result = await module.testing.preValidateTarball(Buffer.from("x"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(projectBoundedTextTail(recent, 200));
      expect(result.reason).toContain("f".repeat(199));
      expect(result.reason).not.toContain("🤖");
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          result.reason,
        ),
      ).toBe(false);
    }
  });
});
