import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateTarUncompressedBudget } from "./dir-fetch-tool.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dir-fetch-tool-test-")));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function tarDirectory(dir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
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
      await expect(validateTarUncompressedBudget(tarBuffer, 256)).resolves.toEqual({
        ok: true,
      });
    },
  );
});

describe("dir.fetch tar validation", () => {
  it("ignores late stdin EPIPE after tar listing has already settled", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: vi.fn(() => {
          const child = new EventEmitter() as EventEmitter & {
            kill: ReturnType<typeof vi.fn>;
            stderr: EventEmitter;
            stdin: EventEmitter & { end: () => void };
            stdout: EventEmitter;
          };
          const stdout = new EventEmitter();
          const stderr = new EventEmitter();
          const stdin = new EventEmitter() as EventEmitter & { end: () => void };
          child.stdout = stdout;
          child.stderr = stderr;
          child.stdin = stdin;
          child.kill = vi.fn();
          stdin.end = () => {
            queueMicrotask(() => {
              stderr.emit("data", Buffer.from("invalid archive"));
              child.emit("close", 2);
              stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
            });
          };
          return child;
        }),
      };
    });

    try {
      const { testing } = await import("./dir-fetch-tool.js");
      await expect(testing.preValidateTarball(Buffer.from("x"))).resolves.toEqual({
        ok: false,
        reason: "tar -tzf exited 2: invalid archive",
      });
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});
