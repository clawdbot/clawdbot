import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, test } from "vitest";
import { createMxcFsBridge } from "../src/fs-bridge.js";

function createDirectoryReader(params: {
  workspaceDir: string;
  agentWorkspaceDir?: string;
  skillsWorkspaceDir?: string;
  workspaceAccess?: "none" | "ro" | "rw";
}) {
  const bridge = createMxcFsBridge({
    sandbox: {
      workspaceDir: params.workspaceDir,
      agentWorkspaceDir: params.agentWorkspaceDir ?? params.workspaceDir,
      skillsWorkspaceDir: params.skillsWorkspaceDir,
      workspaceAccess: params.workspaceAccess ?? "rw",
      containerName: "mxc-directory-test",
      containerWorkdir: params.workspaceDir,
      docker: {},
    },
  });
  return expectDefined(bridge.readDirectory?.bind(bridge), "MXC directory reader");
}

describe("MXC filesystem directory reads", () => {
  test("returns entry names and directory types relative to the mounted directory", async () => {
    await using workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-mxc-directory-",
    });
    const workspaceDir = await fs.realpath(workspace.dir);
    await fs.mkdir(path.join(workspaceDir, "notes"));
    await fs.writeFile(path.join(workspaceDir, "readme.md"), "readme");
    await fs.writeFile(path.join(workspaceDir, "notes", "one.txt"), "note");
    const readDirectory = createDirectoryReader({ workspaceDir });

    await expect(readDirectory({ filePath: "." })).resolves.toEqual([
      { name: "notes", isDirectory: true },
      { name: "readme.md", isDirectory: false },
    ]);
    await expect(
      readDirectory({ filePath: ".", cwd: path.join(workspaceDir, "notes") }),
    ).resolves.toEqual([{ name: "one.txt", isDirectory: false }]);
  });

  test.each([
    { workspaceAccess: "none", expectedName: "sandbox.txt" },
    { workspaceAccess: "ro", expectedName: "sandbox.txt" },
    { workspaceAccess: "rw", expectedName: "agent.txt" },
  ] as const)("uses the mounted workspace with access $workspaceAccess", async (scenario) => {
    await using workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-mxc-mounts-",
    });
    const root = await fs.realpath(workspace.dir);
    const workspaceDir = path.join(root, "sandbox");
    const agentWorkspaceDir = path.join(root, "agent");
    await fs.mkdir(workspaceDir);
    await fs.mkdir(agentWorkspaceDir);
    await fs.writeFile(path.join(workspaceDir, "sandbox.txt"), "sandbox");
    await fs.writeFile(path.join(agentWorkspaceDir, "agent.txt"), "agent");
    const readDirectory = createDirectoryReader({
      workspaceDir,
      agentWorkspaceDir,
      workspaceAccess: scenario.workspaceAccess,
    });

    await expect(readDirectory({ filePath: workspaceDir })).resolves.toEqual([
      { name: scenario.expectedName, isDirectory: false },
    ]);
    if (scenario.workspaceAccess === "ro") {
      await expect(readDirectory({ filePath: agentWorkspaceDir })).resolves.toEqual([
        { name: "agent.txt", isDirectory: false },
      ]);
    } else {
      await expect(readDirectory({ filePath: agentWorkspaceDir })).rejects.toThrow(
        "Path escapes sandbox root",
      );
    }
    await expect(readDirectory({ filePath: root })).rejects.toThrow("Path escapes sandbox root");
  });

  test("lists the protected skill mount instead of its workspace shadow", async () => {
    await using workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-mxc-skills-",
    });
    const root = await fs.realpath(workspace.dir);
    const workspaceDir = path.join(root, "sandbox");
    const skillsWorkspaceDir = path.join(root, "materialized");
    const skillPath = path.join(".openclaw", "sandbox-skills", "skills");
    await fs.mkdir(path.join(workspaceDir, skillPath, "shadow"), { recursive: true });
    await fs.mkdir(path.join(skillsWorkspaceDir, "skills", "demo"), { recursive: true });
    const readDirectory = createDirectoryReader({ workspaceDir, skillsWorkspaceDir });

    await expect(readDirectory({ filePath: skillPath })).resolves.toEqual([
      { name: "demo", isDirectory: true },
    ]);
  });

  test("rejects a directory symlink that escapes the mounted root", async () => {
    await using workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-mxc-symlink-",
    });
    const root = await fs.realpath(workspace.dir);
    const workspaceDir = path.join(root, "sandbox");
    const outsideDir = path.join(root, "outside");
    await fs.mkdir(workspaceDir);
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, "private.txt"), "outside");
    await fs.symlink(
      outsideDir,
      path.join(workspaceDir, "outside-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const readDirectory = createDirectoryReader({ workspaceDir });

    await expect(readDirectory({ filePath: "outside-link" })).rejects.toThrow(
      "path alias escape blocked",
    );
  });
});
