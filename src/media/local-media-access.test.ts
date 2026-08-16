// Local media access tests cover workspace path authorization.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import {
  assertLocalMediaAllowed,
  LocalMediaAccessError,
  readLocalMediaFile,
} from "./local-media-access.js";

const { hoistedRoots } = vi.hoisted(() => ({ hoistedRoots: [] as string[] }));

vi.mock("./local-roots.js", () => ({
  getDefaultMediaLocalRoots: () => hoistedRoots,
}));

describe("assertLocalMediaAllowed", () => {
  afterEach(() => {
    __setFsSafeTestHooksForTest(undefined);
  });

  it("allows managed inbound media paths before explicit root checks", async () => {
    const stateDir = resolveStateDir();
    const id = `managed-local-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from("png"));

    try {
      await expect(assertLocalMediaAllowed(filePath, [])).resolves.toBeUndefined();
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("does not allow nested inbound paths as managed media", async () => {
    const stateDir = resolveStateDir();
    const filePath = path.join(stateDir, "media", "inbound", "nested", "hidden.png");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from("png"));

    try {
      let accessError: unknown;
      try {
        await assertLocalMediaAllowed(filePath, []);
      } catch (error) {
        accessError = error;
      }
      expect(accessError).toBeInstanceOf(LocalMediaAccessError);
      if (!(accessError instanceof LocalMediaAccessError)) {
        throw new Error("expected LocalMediaAccessError");
      }
      expect(accessError.name).toBe("LocalMediaAccessError");
      expect(accessError.code).toBe("path-not-allowed");
      expect(accessError.message).toBe(
        `Local media path is not under an allowed directory: ${filePath}`,
      );
    } finally {
      await fs.rm(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it("rejects workspace-* sibling paths when localRoots is undefined (unscoped)", async () => {
    const tmpDir = path.join(
      os.tmpdir(),
      `ocl-local-media-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const workspaceDir = path.join(tmpDir, "workspace");
    const workspaceXiaoqianDir = path.join(tmpDir, "workspace-xiaoqian");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(workspaceXiaoqianDir, { recursive: true });

    const mediaPath = path.join(workspaceXiaoqianDir, "report.html");
    await fs.writeFile(mediaPath, "<html>test</html>");

    hoistedRoots.length = 0;
    hoistedRoots.push(workspaceDir);

    try {
      let accessError: unknown;
      try {
        await assertLocalMediaAllowed(mediaPath, undefined);
      } catch (error) {
        accessError = error;
      }
      expect(accessError).toBeInstanceOf(LocalMediaAccessError);
      if (!(accessError instanceof LocalMediaAccessError)) {
        throw new Error("expected LocalMediaAccessError");
      }
      expect(accessError.code).toBe("path-not-allowed");
    } finally {
      hoistedRoots.length = 0;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("allows workspace-* paths when scoped localRoots include the agent workspace", async () => {
    const tmpDir = path.join(
      os.tmpdir(),
      `ocl-local-media-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const workspaceDir = path.join(tmpDir, "workspace");
    const workspaceXiaoqianDir = path.join(tmpDir, "workspace-xiaoqian");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(workspaceXiaoqianDir, { recursive: true });

    const mediaPath = path.join(workspaceXiaoqianDir, "report.html");
    await fs.writeFile(mediaPath, "<html>test</html>");

    try {
      // Simulate scoped roots that include the agent's workspace-* directory
      await expect(
        assertLocalMediaAllowed(mediaPath, [workspaceDir, workspaceXiaoqianDir]),
      ).resolves.toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "reads through an in-root directory symlink but rejects a final symlink",
    async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-root-alias-"));
      const root = path.join(base, "root");
      const realDir = path.join(root, "real");
      const aliasDir = path.join(root, "alias");
      const realFile = path.join(realDir, "inside.bin");
      const aliasFile = path.join(aliasDir, "inside.bin");
      const finalLink = path.join(root, "final.bin");
      await fs.mkdir(realDir, { recursive: true });
      await fs.writeFile(realFile, "inside");
      await fs.symlink(realDir, aliasDir);
      await fs.symlink(realFile, finalLink);

      try {
        await expect(readLocalMediaFile(aliasFile, [root], { maxBytes: 1024 })).resolves.toEqual(
          Buffer.from("inside"),
        );
        await expect(
          readLocalMediaFile(finalLink, [root], { maxBytes: 1024 }),
        ).rejects.toMatchObject({ code: "symlink" });
      } finally {
        await fs.rm(base, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects inbound-root reads through a pre-existing directory symlink outside the root",
    async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inbound-root-alias-"));
      const inboundRoot = path.join(base, "inbound");
      const outsideDir = path.join(base, "outside");
      const aliasDir = path.join(inboundRoot, "alias");
      const filePath = path.join(aliasDir, "secret.bin");
      await fs.mkdir(inboundRoot, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, "secret.bin"), "outside-secret");
      await fs.symlink(outsideDir, aliasDir);

      try {
        await expect(
          readLocalMediaFile(filePath, [], {
            inboundRoots: [inboundRoot],
            maxBytes: 1024,
          }),
        ).rejects.toMatchObject({ code: "path-not-allowed" });
      } finally {
        await fs.rm(base, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects inbound wildcard reads when a nested directory symlink retargets before open",
    async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inbound-root-race-"));
      const inboundRoot = path.join(base, "alice", "Attachments");
      const insideDir = path.join(inboundRoot, "inside");
      const outsideDir = path.join(base, "outside");
      const aliasDir = path.join(inboundRoot, "slot");
      const filePath = path.join(aliasDir, "report.csv");
      await fs.mkdir(insideDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(insideDir, "report.csv"), "inside");
      await fs.writeFile(path.join(outsideDir, "report.csv"), "outside-secret");
      await fs.symlink(insideDir, aliasDir);
      __setFsSafeTestHooksForTest({
        afterPreOpenLstat: async (openedPath) => {
          if (openedPath !== filePath) {
            return;
          }
          await fs.rm(aliasDir);
          await fs.symlink(outsideDir, aliasDir);
        },
      });

      try {
        await expect(
          readLocalMediaFile(filePath, [], {
            inboundRoots: [path.join(base, "*", "Attachments")],
            maxBytes: 1024,
          }),
          // fs-safe 0.5.2 reports pre-open identity drift as path-mismatch.
        ).rejects.toMatchObject({ code: "path-mismatch" });
      } finally {
        await fs.rm(base, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects inbound wildcard roots whose wildcard segment already resolves outside the anchor",
    async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inbound-anchor-"));
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inbound-outside-"));
      const alias = path.join(base, "alice");
      const outsideAttachments = path.join(outside, "Attachments");
      const filePath = path.join(alias, "Attachments", "secret.bin");
      await fs.mkdir(outsideAttachments, { recursive: true });
      await fs.writeFile(path.join(outsideAttachments, "secret.bin"), "outside-secret");
      await fs.symlink(outside, alias);

      try {
        await expect(
          readLocalMediaFile(filePath, [], {
            inboundRoots: [path.join(base, "*", "Attachments")],
            maxBytes: 1024,
          }),
        ).rejects.toMatchObject({ code: "path-not-allowed" });
      } finally {
        await fs.rm(base, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects hardlink aliases inside channel inbound roots",
    async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inbound-hardlink-"));
      const inboundRoot = path.join(base, "inbound");
      const outsidePath = path.join(base, "outside.bin");
      const filePath = path.join(inboundRoot, "alias.bin");
      await fs.mkdir(inboundRoot, { recursive: true });
      await fs.writeFile(outsidePath, "outside-secret");
      await fs.link(outsidePath, filePath);

      try {
        await expect(
          readLocalMediaFile(filePath, [], {
            inboundRoots: [inboundRoot],
            maxBytes: 1024,
          }),
        ).rejects.toMatchObject({ code: "hardlink" });
      } finally {
        await fs.rm(base, { recursive: true, force: true });
      }
    },
  );

  it("keeps missing managed paths available to authorized custom readers", async () => {
    const stateDir = resolveStateDir();
    const inboundRoot = path.join(stateDir, "media", "inbound");
    const filePath = path.join(
      inboundRoot,
      `virtual-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`,
    );

    await expect(
      assertLocalMediaAllowed(filePath, [], { inboundRoots: [inboundRoot] }),
    ).resolves.toBeUndefined();
  });

  it("preserves valid root-level wildcard inbound patterns", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inbound-root-wildcard-"));
    const filePath = path.join(root, "inside.bin");
    await fs.writeFile(filePath, "inside");

    try {
      await expect(
        readLocalMediaFile(filePath, [], {
          inboundRoots: ["/*"],
          maxBytes: 1024,
        }),
      ).resolves.toEqual(Buffer.from("inside"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves not-found and not-file errors for root-bound reads", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-read-errors-"));
    try {
      await expect(
        readLocalMediaFile(path.join(root, "missing.bin"), [root], { maxBytes: 1024 }),
      ).rejects.toMatchObject({ code: "not-found" });
      await expect(readLocalMediaFile(root, [root], { maxBytes: 1024 })).rejects.toMatchObject({
        code: "not-file",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
