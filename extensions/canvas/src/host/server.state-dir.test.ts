import fs from "node:fs/promises";
import path from "node:path";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { beforeAll, describe, expect, it } from "vitest";

describe("canvas host state dir defaults", () => {
  let createCanvasHostHandler: typeof import("./server.js").createCanvasHostHandler;

  beforeAll(async () => {
    ({ createCanvasHostHandler } = await import("./server.js"));
  });

  it("uses OPENCLAW_STATE_DIR for the default canvas root", async () => {
    await withStateDirEnv("openclaw-canvas-state-", async ({ stateDir }) => {
      const handler = await createCanvasHostHandler({
        runtime: defaultRuntime,
        allowInTests: true,
      });

      try {
        const expectedRoot = await fs.realpath(path.join(stateDir, "canvas"));
        const actualRoot = await fs.realpath(handler.rootDir);
        expect(actualRoot).toBe(expectedRoot);
        const indexPath = path.join(expectedRoot, "index.html");
        const indexContents = await fs.readFile(indexPath, "utf8");
        expect(indexContents).toContain("OpenClaw Canvas");
      } finally {
        await handler.close();
      }
    });
  });
});
