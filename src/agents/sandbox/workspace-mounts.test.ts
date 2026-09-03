// Workspace mount tests cover Docker bind arguments for workspace access modes
// and read-only skill overlays.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendWorkspaceMountArgs,
  filterBindsConflictingWithProtectedMounts,
  resolveProtectedSkillMountContainerPaths,
  type ReadOnlyWorkspaceSkillMount,
} from "./workspace-mounts.js";

const tmpDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sandbox-mounts-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("appendWorkspaceMountArgs", () => {
  it.each([
    { access: "rw" as const, expected: "/tmp/workspace:/workspace:z" },
    { access: "ro" as const, expected: "/tmp/workspace:/workspace:ro,z" },
    { access: "none" as const, expected: "/tmp/workspace:/workspace:z" },
  ])("sets main mount permissions for workspaceAccess=$access", ({ access, expected }) => {
    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/agent-workspace",
      workdir: "/workspace",
      workspaceAccess: access,
    });

    expect(args).toContain(expected);
  });

  it("omits agent workspace mount when workspaceAccess is none", () => {
    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/agent-workspace",
      workdir: "/workspace",
      workspaceAccess: "none",
    });

    const mounts = args.filter((arg) => arg.startsWith("/tmp/"));
    expect(mounts).toEqual(["/tmp/workspace:/workspace:z"]);
  });

  it("omits agent workspace mount when paths are identical", () => {
    const workspaceDir = makeTempWorkspace();
    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      workdir: "/workspace",
      workspaceAccess: "rw",
    });

    const mounts = args.filter((arg) => arg.startsWith(workspaceDir));
    expect(mounts).toEqual([`${workspaceDir}:/workspace:z`]);
  });

  it("marks split agent workspace mounts shared for SELinux", () => {
    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/agent-workspace",
      workdir: "/workspace",
      workspaceAccess: "ro",
    });

    const mounts = args.filter((arg) => arg.startsWith("/tmp/"));
    expect(mounts).toEqual(["/tmp/workspace:/workspace:ro,z", "/tmp/agent-workspace:/agent:ro,z"]);
  });

  it("overlays workspace skills read-only when workspaceAccess is rw", () => {
    // The writable workspace mount is followed by a narrower read-only skills
    // overlay so sandboxed agents cannot mutate checked-in skill instructions.
    const agentWorkspaceDir = makeTempWorkspace();
    fs.mkdirSync(path.join(agentWorkspaceDir, "skills", "demo"), { recursive: true });
    fs.writeFileSync(path.join(agentWorkspaceDir, "skills", "demo", "SKILL.md"), "# Demo\n");

    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: agentWorkspaceDir,
      agentWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "rw",
    });

    const mounts = args.filter((arg) => arg.startsWith(agentWorkspaceDir));
    expect(mounts).toEqual([
      `${agentWorkspaceDir}:/workspace:z`,
      `${path.join(agentWorkspaceDir, "skills")}:/workspace/skills:ro,z`,
    ]);
  });

  it.runIf(process.platform !== "win32")("does not overlay symlinked workspace skill roots", () => {
    // Skill overlays must be real workspace directories; symlinks could expose
    // arbitrary host paths read-only inside the sandbox.
    const agentWorkspaceDir = makeTempWorkspace();
    const outsideDir = makeTempWorkspace();
    fs.mkdirSync(path.join(outsideDir, "demo"), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(agentWorkspaceDir, "skills"), "dir");

    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: agentWorkspaceDir,
      agentWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "rw",
    });

    const mounts = args.filter((arg) => arg.startsWith(agentWorkspaceDir));
    expect(mounts).toEqual([`${agentWorkspaceDir}:/workspace:z`]);
  });

  it.runIf(process.platform !== "win32")(
    "does not overlay skill roots through a symlinked parent",
    () => {
      const agentWorkspaceDir = makeTempWorkspace();
      const outsideDir = makeTempWorkspace();
      fs.mkdirSync(path.join(outsideDir, "skills", "demo"), { recursive: true });
      fs.symlinkSync(outsideDir, path.join(agentWorkspaceDir, ".agents"), "dir");

      const args: string[] = [];
      appendWorkspaceMountArgs({
        args,
        workspaceDir: agentWorkspaceDir,
        agentWorkspaceDir,
        workdir: "/workspace",
        workspaceAccess: "rw",
      });

      const mounts = args.filter((arg) => arg.startsWith(agentWorkspaceDir));
      expect(mounts).toEqual([`${agentWorkspaceDir}:/workspace:z`]);
    },
  );

  it("overlays project .agents skills read-only when workspaceAccess is rw", () => {
    const agentWorkspaceDir = makeTempWorkspace();
    fs.mkdirSync(path.join(agentWorkspaceDir, ".agents", "skills", "demo"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(agentWorkspaceDir, ".agents", "skills", "demo", "SKILL.md"),
      "# Demo\n",
    );

    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: agentWorkspaceDir,
      agentWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "rw",
    });

    const mounts = args.filter((arg) => arg.startsWith(agentWorkspaceDir));
    expect(mounts).toEqual([
      `${agentWorkspaceDir}:/workspace:z`,
      `${path.join(agentWorkspaceDir, ".agents", "skills")}:/workspace/.agents/skills:ro,z`,
    ]);
  });

  it("overlays materialized sandbox skills read-only when workspaceAccess is rw", () => {
    const agentWorkspaceDir = makeTempWorkspace();
    const skillsWorkspaceDir = makeTempWorkspace();
    const materializedSkillsDir = path.join(skillsWorkspaceDir, "skills");
    fs.mkdirSync(path.join(materializedSkillsDir, "demo"), { recursive: true });
    fs.writeFileSync(path.join(materializedSkillsDir, "demo", "SKILL.md"), "# Demo\n");

    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: agentWorkspaceDir,
      agentWorkspaceDir,
      skillsWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "rw",
    });

    const mounts = args.filter(
      (arg) => arg.startsWith(agentWorkspaceDir) || arg.startsWith(skillsWorkspaceDir),
    );
    expect(mounts).toEqual([
      `${agentWorkspaceDir}:/workspace:z`,
      `${materializedSkillsDir}:/workspace/.openclaw/sandbox-skills/skills:ro,z`,
    ]);
  });

  it("does not add a separate synced skill overlay when workspaceAccess is ro", () => {
    const agentWorkspaceDir = makeTempWorkspace();
    const sandboxWorkspaceDir = makeTempWorkspace();
    fs.mkdirSync(path.join(sandboxWorkspaceDir, "skills", "demo"), { recursive: true });

    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: sandboxWorkspaceDir,
      agentWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "ro",
    });

    const mounts = args.filter(
      (arg) => arg.startsWith(agentWorkspaceDir) || arg.startsWith(sandboxWorkspaceDir),
    );

    expect(mounts).toEqual([
      `${sandboxWorkspaceDir}:/workspace:ro,z`,
      `${agentWorkspaceDir}:/agent:ro,z`,
    ]);
    expect(mounts).not.toContain(
      `${path.join(sandboxWorkspaceDir, "skills")}:/workspace/skills:ro,z`,
    );
  });

  it("keeps private workspace skills read-only without exposing the agent workspace", () => {
    const agentWorkspaceDir = makeTempWorkspace();
    const sandboxWorkspaceDir = makeTempWorkspace();
    fs.mkdirSync(path.join(sandboxWorkspaceDir, "skills", "demo"), { recursive: true });
    fs.mkdirSync(path.join(sandboxWorkspaceDir, ".agents", "skills"), { recursive: true });
    fs.mkdirSync(path.join(agentWorkspaceDir, "skills", "host-only"), { recursive: true });

    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: sandboxWorkspaceDir,
      agentWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "none",
    });

    const mounts = args.filter(
      (arg) => arg.startsWith(agentWorkspaceDir) || arg.startsWith(sandboxWorkspaceDir),
    );

    expect(mounts).toEqual([
      `${sandboxWorkspaceDir}:/workspace:z`,
      `${path.join(sandboxWorkspaceDir, "skills")}:/workspace/skills:ro,z`,
      `${path.join(sandboxWorkspaceDir, ".agents", "skills")}:/workspace/.agents/skills:ro,z`,
    ]);
  });
});

describe("resolveProtectedSkillMountContainerPaths", () => {
  it("returns an empty set for empty mounts", () => {
    const paths = resolveProtectedSkillMountContainerPaths([]);
    expect(paths.size).toBe(0);
  });

  it("returns container paths from skill mounts", () => {
    const mounts: ReadOnlyWorkspaceSkillMount[] = [
      { hostPath: "/host/skills", containerPath: "/workspace/skills" },
      { hostPath: "/host/.agents/skills", containerPath: "/workspace/./.agents/skills/" },
    ];
    const paths = resolveProtectedSkillMountContainerPaths(mounts);
    expect(paths).toEqual(new Set(["/workspace/skills", "/workspace/.agents/skills"]));
  });
});

describe("filterBindsConflictingWithProtectedMounts", () => {
  const protectedPaths = new Set(["/workspace/skills", "/workspace/.agents/skills"]);

  it("returns empty array when binds is undefined", () => {
    expect(filterBindsConflictingWithProtectedMounts(undefined, protectedPaths)).toEqual([]);
  });

  it("returns empty array when binds is empty", () => {
    expect(filterBindsConflictingWithProtectedMounts([], protectedPaths)).toEqual([]);
  });

  it("returns all binds when protected paths are empty", () => {
    const binds = ["/host/custom:/workspace/skills:rw"];
    expect(filterBindsConflictingWithProtectedMounts(binds, new Set())).toEqual(binds);
  });

  it("skips a bind whose container path matches a protected mount", () => {
    const filtered = filterBindsConflictingWithProtectedMounts(
      ["/host/custom:/workspace/skills:rw", "/host/other:/data:rw"],
      protectedPaths,
    );
    expect(filtered).toEqual(["/host/other:/data:rw"]);
  });

  it("skips multiple binds when multiple conflict", () => {
    const filtered = filterBindsConflictingWithProtectedMounts(
      ["/host/a:/workspace/skills:ro", "/host/b:/workspace/.agents/skills:ro", "/host/c:/data:rw"],
      protectedPaths,
    );
    expect(filtered).toEqual(["/host/c:/data:rw"]);
  });

  it("returns all binds when none conflict", () => {
    const binds = ["/host/a:/data:rw", "/host/b:/tmp:ro"];
    expect(filterBindsConflictingWithProtectedMounts(binds, protectedPaths)).toEqual(binds);
  });

  it("skips all binds when every one conflicts with a protected path", () => {
    const filtered = filterBindsConflictingWithProtectedMounts(
      ["/host/a:/workspace/skills:ro", "/host/b:/workspace/.agents/skills:ro"],
      protectedPaths,
    );
    expect(filtered).toEqual([]);
  });

  it("handles rw binds (no :ro option) correctly", () => {
    const filtered = filterBindsConflictingWithProtectedMounts(
      ["/host/custom:/workspace/skills"],
      protectedPaths,
    );
    expect(filtered).toEqual([]);
  });

  it("normalizes trailing slashes in container paths", () => {
    const filtered = filterBindsConflictingWithProtectedMounts(
      ["/host/custom:/workspace/skills/"],
      protectedPaths,
    );
    expect(filtered).toEqual([]);
  });
});
