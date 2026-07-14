import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runLocalCommandToFile } from "./workspace-sync-local.js";

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

describe("runLocalCommandToFile", () => {
  it("force-kills a command that ignores abort termination", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-sync-"));
    const outputPath = path.join(root, "output");
    const readyPath = path.join(root, "ready");
    const controller = new AbortController();
    const operation = runLocalCommandToFile({
      argv: [
        process.execPath,
        "-e",
        [
          'const fs = require("node:fs");',
          'process.on("SIGTERM", () => {});',
          'fs.writeFileSync(process.argv[1], "ready");',
          "setInterval(() => {}, 1000);",
        ].join(""),
        readyPath,
      ],
      outputPath,
      signal: controller.signal,
      timeoutMs: 10_000,
    });

    try {
      await waitForFile(readyPath);
      const abortedAt = Date.now();
      controller.abort();
      await expect(operation).rejects.toThrow("Worker workspace file enumeration was aborted");
      expect(Date.now() - abortedAt).toBeLessThan(3_000);
    } finally {
      controller.abort();
      await operation.catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
