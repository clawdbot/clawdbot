// File Transfer tests cover dir fetch tool plugin behavior.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
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

function mockTarSpawn(
  script: (
    child: EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      stderr: EventEmitter;
      stdin: EventEmitter & { end: () => void };
      stdout: EventEmitter;
    },
  ) => void,
) {
  return vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      stderr: EventEmitter;
      stdin: EventEmitter & { end: () => void };
      stdout: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter() as EventEmitter & { end: () => void };
    child.kill = vi.fn();
    child.stdin.end = () => {
      queueMicrotask(() => script(child));
    };
    return child;
  });
}

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

  it("stops tar name listing once the entry cap is exceeded", async () => {
    vi.resetModules();
    const tarLines = Array.from({ length: 5001 }, (_, index) => `file-${index}`).join("\n") + "\n";
    const spawnMock = mockTarSpawn((child) => {
      child.stdout.emit("data", Buffer.from(tarLines));
    });
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: spawnMock,
      };
    });

    try {
      const { testing } = await import("./dir-fetch-tool.js");
      await expect(testing.preValidateTarball(Buffer.from("x"))).resolves.toEqual({
        ok: false,
        reason: "archive contains 5001 entries; limit 5000",
      });
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const child = spawnMock.mock.results[0]?.value;
      expect(child?.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("keeps recent tar stderr when listing fails noisily", async () => {
    vi.resetModules();
    const oldNoise = "old-noise\n".repeat(600);
    const recent = "recent-invalid-archive-details\n".repeat(12);
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: mockTarSpawn((child) => {
          child.stderr.emit("data", Buffer.from(oldNoise));
          child.stderr.emit("data", Buffer.from(recent));
          child.emit("close", 2);
        }),
      };
    });

    try {
      const { testing } = await import("./dir-fetch-tool.js");
      const result = await testing.preValidateTarball(Buffer.from("x"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain(recent.slice(-200));
        expect(result.reason).not.toContain(oldNoise.slice(0, 40));
      }
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});
