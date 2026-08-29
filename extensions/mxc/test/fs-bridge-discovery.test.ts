import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SANDBOX_FS_DIRECTORY_MAX_ENTRIES,
  type SandboxFsBridge,
} from "openclaw/plugin-sdk/sandbox-fs";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, test } from "vitest";
import { createMxcFsBridge } from "../src/fs-bridge.js";

async function withWorkspaceBridge(
  run: (params: { bridge: SandboxFsBridge; workdir: string }) => Promise<void>,
): Promise<void> {
  // openclaw-temp-dir: allow extension tests cannot import repo-only test helpers
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mxc-fsbridge-"));
  try {
    const workdir = await fs.realpath(stateDir);
    const bridge = createMxcFsBridge({
      sandbox: createSandboxTestContext({
        overrides: {
          workspaceDir: workdir,
          agentWorkspaceDir: workdir,
          containerWorkdir: workdir,
          workspaceAccess: "rw",
        },
      }),
    });
    await run({ bridge, workdir });
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("mxc fs bridge discovery", () => {
  test.runIf(process.platform === "linux")(
    "lists typed entries without traversing symbolic links",
    async () => {
      await withWorkspaceBridge(async ({ bridge, workdir }) => {
        await fs.mkdir(path.join(workdir, "docs"));
        await fs.writeFile(path.join(workdir, "readme.md"), "hello");
        await fs.symlink(path.join(workdir, "readme.md"), path.join(workdir, "link"));

        await expect(bridge.listDirectory?.({ filePath: workdir })).resolves.toEqual([
          { name: "docs", type: "directory" },
          { name: "link", type: "other" },
          { name: "readme.md", type: "file" },
        ]);
      });
    },
  );

  test.runIf(process.platform === "linux")(
    "stops the listing for an aborted caller signal",
    async () => {
      await withWorkspaceBridge(async ({ bridge, workdir }) => {
        const controller = new AbortController();
        controller.abort();

        await expect(
          bridge.listDirectory?.({ filePath: workdir, signal: controller.signal }),
        ).rejects.toHaveProperty("name", "AbortError");
      });
    },
  );

  test.runIf(process.platform === "linux")(
    "rejects directories over the discovery entry limit",
    async () => {
      await withWorkspaceBridge(async ({ bridge, workdir }) => {
        const names = Array.from(
          { length: SANDBOX_FS_DIRECTORY_MAX_ENTRIES + 1 },
          (_, index) => `entry-${index}`,
        );
        for (let start = 0; start < names.length; start += 500) {
          await Promise.all(
            names
              .slice(start, start + 500)
              .map((name) => fs.writeFile(path.join(workdir, name), "")),
          );
        }

        await expect(bridge.listDirectory?.({ filePath: workdir })).rejects.toThrow("entry limit");
      });
    },
  );

  test.runIf(process.platform !== "linux")("omits unsupported local discovery", async () => {
    await withWorkspaceBridge(async ({ bridge }) => {
      expect(typeof bridge.listDirectory).toBe("undefined");
    });
  });
});
