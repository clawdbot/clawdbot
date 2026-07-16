// Tests the real fs-safe boundary used by session-export artifacts.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { writeSessionExportFile } from "./commands-export-session-file.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeWorkspace(): string {
  return tempDirs.make("openclaw-session-export-");
}

async function writeExport(params: {
  workspaceDir: string;
  requestedPath?: string;
  defaultFileName?: string;
  contents?: string;
}) {
  return await writeSessionExportFile({
    workspaceDir: params.workspaceDir,
    requestedPath: params.requestedPath,
    defaultFileName: params.defaultFileName ?? "session.html",
    contents: params.contents ?? "new export",
  });
}

describe("writeSessionExportFile", () => {
  it.each([
    ["relative", "exports/session.html"],
    ["absolute", null],
  ])("writes an explicit %s path inside the workspace", async (_label, requestedPath) => {
    const workspaceDir = makeWorkspace();
    const targetPath = requestedPath ?? path.join(workspaceDir, "exports", "session.html");

    const result = await writeExport({ workspaceDir, requestedPath: targetPath });

    expect(result).toEqual({
      absolutePath: path.join(workspaceDir, "exports", "session.html"),
      displayPath: path.join("exports", "session.html"),
    });
    expect(await fs.readFile(result.absolutePath, "utf-8")).toBe("new export");
    if (process.platform !== "win32") {
      expect((await fs.stat(result.absolutePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("preserves explicit overwrite behavior for an in-workspace regular file", async () => {
    const workspaceDir = makeWorkspace();
    const targetPath = path.join(workspaceDir, "session.html");
    await fs.writeFile(targetPath, "old export", "utf-8");
    if (process.platform !== "win32") {
      await fs.chmod(targetPath, 0o644);
    }

    await writeExport({ workspaceDir, requestedPath: targetPath });

    expect(await fs.readFile(targetPath, "utf-8")).toBe("new export");
    if (process.platform !== "win32") {
      expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    ["absolute", (workspaceDir: string) => path.join(path.dirname(workspaceDir), "outside.html")],
    ["traversal", () => "../outside.html"],
  ])("rejects an %s path outside the workspace", async (_label, requestedPath) => {
    const workspaceDir = makeWorkspace();

    await expect(
      writeExport({ workspaceDir, requestedPath: requestedPath(workspaceDir) }),
    ).rejects.toMatchObject({ code: "outside-workspace", category: "policy" });
  });

  it.runIf(process.platform !== "win32")(
    "accepts an absolute path written through a symlinked workspace root",
    async () => {
      const workspaceDir = makeWorkspace();
      const aliasParent = tempDirs.make("openclaw-session-export-alias-");
      const workspaceAlias = path.join(aliasParent, "workspace");
      await fs.symlink(workspaceDir, workspaceAlias, "dir");
      const requestedPath = path.join(workspaceAlias, "exports", "session.html");

      const result = await writeExport({ workspaceDir: workspaceAlias, requestedPath });

      expect(result).toEqual({
        absolutePath: path.join(workspaceDir, "exports", "session.html"),
        displayPath: path.join("exports", "session.html"),
      });
      expect(await fs.readFile(result.absolutePath, "utf-8")).toBe("new export");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symlink target without changing the linked file",
    async () => {
      const workspaceDir = makeWorkspace();
      const outsideDir = tempDirs.make("openclaw-session-export-outside-");
      const outsidePath = path.join(outsideDir, "outside.html");
      const linkedPath = path.join(workspaceDir, "session.html");
      await fs.writeFile(outsidePath, "outside", "utf-8");
      await fs.symlink(outsidePath, linkedPath);

      await expect(writeExport({ workspaceDir, requestedPath: linkedPath })).rejects.toMatchObject({
        category: "policy",
      });
      expect(await fs.readFile(outsidePath, "utf-8")).toBe("outside");
    },
  );

  it("suffixes a colliding generated filename instead of overwriting", async () => {
    const workspaceDir = makeWorkspace();
    await fs.writeFile(path.join(workspaceDir, "session.html"), "existing", "utf-8");

    const result = await writeExport({ workspaceDir });

    expect(result.displayPath).toBe("session-2.html");
    expect(await fs.readFile(path.join(workspaceDir, "session.html"), "utf-8")).toBe("existing");
    expect(await fs.readFile(result.absolutePath, "utf-8")).toBe("new export");
  });
});
