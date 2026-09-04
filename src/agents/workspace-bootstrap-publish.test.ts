// Bootstrap publication atomicity: a failed first-time write must never leave
// a partial AGENTS.md behind, and an existing complete winner is never clobbered.
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { nodeFilePath } from "../test-utils/node-file-path.js";
import * as workspace from "./workspace.js";

const {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  ensureAgentWorkspace,
  seedWorkspaceBootstrap,
} = workspace;

async function expectPathMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toHaveProperty("code", "ENOENT");
}

async function injectPartialPublicationFailure(dir: string, fileName: string) {
  const realWriteFile = fs.writeFile.bind(fs);
  const resolvedDir = await fs.realpath(dir);
  const targetPath = path.join(resolvedDir, fileName);
  let injected = true;
  const writeFileSpy = vi
    .spyOn(fs, "writeFile")
    .mockImplementation(async (filePath, data, options) => {
      const rawPath = nodeFilePath(filePath);
      if (!rawPath) {
        return await realWriteFile(filePath, data, options);
      }
      const target = path.resolve(rawPath);
      const parent = path.dirname(target);
      const isFinalTarget = target === targetPath;
      const isStagedTarget =
        path.dirname(parent) === resolvedDir &&
        path.basename(parent).startsWith("openclaw-bootstrap-") &&
        path.basename(target) === fileName;
      if (injected && (isFinalTarget || isStagedTarget)) {
        injected = false;
        await realWriteFile(filePath, "# PARTIAL\n", options);
        const err = new Error("ENOSPC") as NodeJS.ErrnoException;
        err.code = "ENOSPC";
        throw err;
      }
      return await realWriteFile(filePath, data, options);
    });
  return () => {
    writeFileSpy.mockRestore();
  };
}

async function listTempSiblings(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir);
  return names.filter((name) => name.startsWith("openclaw-bootstrap-")).toSorted();
}

describe("bootstrap publication atomicity", () => {
  it("does not publish a partial AGENTS.md when the first write fails", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    const restore = await injectPartialPublicationFailure(tempDir, DEFAULT_AGENTS_FILENAME);

    try {
      await expect(
        ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
      ).rejects.toMatchObject({ code: "ENOSPC" });
      await expectPathMissing(agentsPath);
      expect(await listTempSiblings(tempDir)).toEqual([]);
    } finally {
      restore();
    }

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    const content = await fs.readFile(agentsPath, "utf-8");
    expect(content).not.toBe("# PARTIAL\n");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it("leaves an existing complete AGENTS.md winner unchanged", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    await fs.writeFile(agentsPath, "WINNER\n", "utf-8");

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    expect(await fs.readFile(agentsPath, "utf-8")).toBe("WINNER\n");
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "reuses an established read-only workspace without creating bootstrap files",
    async () => {
      const tempDir = await makeTempWorkspace("openclaw-workspace-readonly-");
      const files = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];
      for (const name of files) {
        await fs.writeFile(path.join(tempDir, name), `Authored ${name}\n`);
      }
      await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
      await fs.chmod(tempDir, 0o555);

      try {
        await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

        for (const name of files) {
          expect(await fs.readFile(path.join(tempDir, name), "utf8")).toBe(`Authored ${name}\n`);
        }
        expect((await fs.readdir(tempDir)).toSorted()).toEqual(files.toSorted());
      } finally {
        await fs.chmod(tempDir, 0o700);
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "preserves an existing dangling bootstrap symlink in a read-only workspace",
    async () => {
      const tempDir = await makeTempWorkspace("openclaw-workspace-dangling-");
      const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
      await fs.symlink("missing.md", agentsPath);
      await fs.chmod(tempDir, 0o555);

      try {
        await expect(workspace.publishBootstrapFile(agentsPath, "replacement\n")).resolves.toBe(
          false,
        );
        expect(await fs.readlink(agentsPath)).toBe("missing.md");
        expect(await fs.readdir(tempDir)).toEqual([DEFAULT_AGENTS_FILENAME]);
      } finally {
        await fs.chmod(tempDir, 0o700);
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")("publishes through a workspace symlink", async () => {
    const root = await makeTempWorkspace("openclaw-workspace-alias-");
    const workspaceDir = path.join(root, "workspace");
    const workspaceAlias = path.join(root, "workspace-alias");
    await fs.mkdir(workspaceDir);
    await fs.symlink(workspaceDir, workspaceAlias, "dir");

    await ensureAgentWorkspace({ dir: workspaceAlias, ensureBootstrapFiles: true });

    const agents = await fs.readFile(path.join(workspaceDir, DEFAULT_AGENTS_FILENAME), "utf8");
    expect(agents.trim().length).toBeGreaterThan(0);
  });

  it("publishes one complete winner when bootstrap writers race", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    const contents = ["FIRST-COMPLETE\n", "SECOND-COMPLETE\n"];

    const created = await Promise.all(
      contents.map(async (content) => await workspace.publishBootstrapFile(agentsPath, content)),
    );

    expect(created.filter(Boolean)).toHaveLength(1);
    expect(contents).toContain(await fs.readFile(agentsPath, "utf8"));
    expect((await fs.lstat(agentsPath)).nlink).toBe(1);
    expect(await listTempSiblings(tempDir)).toEqual([]);
  });

  it("keeps a safe reader on the complete single-link file", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    const realLink = syncFs.linkSync.bind(syncFs);
    let concurrentRead: ReturnType<typeof workspace.loadWorkspaceBootstrapFiles> | undefined;
    const linkSpy = vi.spyOn(syncFs, "linkSync").mockImplementation((source, target) => {
      realLink(source, target);
      concurrentRead = workspace.loadWorkspaceBootstrapFiles(tempDir);
    });

    try {
      await workspace.publishBootstrapFile(agentsPath, "COMPLETE\n");
      if (!concurrentRead) {
        throw new Error("concurrent reader was not started");
      }
      const agents = (await concurrentRead).find((file) => file.name === DEFAULT_AGENTS_FILENAME);
      expect(agents).toMatchObject({ content: "COMPLETE\n", missing: false });
      expect((await fs.lstat(agentsPath)).nlink).toBe(1);
    } finally {
      linkSpy.mockRestore();
    }
  });

  it("reports a staging cleanup failure with the publication error", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    const restore = await injectPartialPublicationFailure(tempDir, DEFAULT_AGENTS_FILENAME);
    const realRm = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (filePath, options) => {
      const target = nodeFilePath(filePath);
      if (target && path.basename(target).startsWith("openclaw-bootstrap-")) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      await realRm(filePath, options);
    });

    try {
      const error = await workspace
        .publishBootstrapFile(agentsPath, "complete\n")
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toMatchObject([
        { code: "ENOSPC" },
        { code: "EACCES" },
      ]);
      expect(error).toMatchObject({
        message: expect.stringMatching(/publication and staging cleanup failed/u),
      });
      await expectPathMissing(agentsPath);
      expect(await listTempSiblings(tempDir)).toHaveLength(1);
    } finally {
      restore();
      rmSpy.mockRestore();
    }
  });

  it("fails closed when the workspace does not support hard links", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    const linkSpy = vi.spyOn(syncFs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
    });

    try {
      await expect(workspace.publishBootstrapFile(agentsPath, "complete\n")).rejects.toThrow(
        /filesystem does not support atomic bootstrap publication/u,
      );
      await expectPathMissing(agentsPath);
    } finally {
      linkSpy.mockRestore();
    }
  });

  it("preserves the raw bootstrap bytes including a UTF-8 BOM", async () => {
    // The Claw bootstrap flow approves raw bytes and later re-verifies them by
    // byte equality. Writing the decoded text (TextDecoder strips a leading
    // BOM) would persist different bytes and trip the existing-winner check.
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const content = Buffer.concat([bom, Buffer.from("# BOOTSTRAP\n")]);

    await expect(seedWorkspaceBootstrap({ dir: tempDir, content })).resolves.toBe("seeded");

    const written = await fs.readFile(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    expect(written.equals(content)).toBe(true);
    if (process.platform !== "win32") {
      const stat = await fs.stat(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });
});
