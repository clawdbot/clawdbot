import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

      await expect(validateTarUncompressedBudget(tarBuffer, 64)).resolves.toMatchObject({
        ok: false,
      });
      await expect(validateTarUncompressedBudget(tarBuffer, 256)).resolves.toMatchObject({
        ok: true,
      });
    },
  );
});
