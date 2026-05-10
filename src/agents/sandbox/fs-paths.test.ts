import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSandboxFsMounts,
  parseSandboxBindMount,
  resolveSandboxFsPathWithMounts,
} from "./fs-paths.js";
import { createSandboxTestContext } from "./test-fixtures.js";
import type { SandboxContext } from "./types.js";

function createSandbox(overrides?: Partial<SandboxContext>): SandboxContext {
  return createSandboxTestContext({ overrides });
}

describe("parseSandboxBindMount", () => {
  it("parses bind mode and writeability", () => {
    expect(parseSandboxBindMount("/tmp/a:/workspace-a:ro")).toEqual({
      hostRoot: path.resolve("/tmp/a"),
      containerRoot: "/workspace-a",
      writable: false,
    });
    expect(parseSandboxBindMount("/tmp/b:/workspace-b:rw")).toEqual({
      hostRoot: path.resolve("/tmp/b"),
      containerRoot: "/workspace-b",
      writable: true,
    });
  });

  it("parses Windows drive-letter host paths", () => {
    expect(parseSandboxBindMount("C:\\Users\\kai\\workspace:/workspace:ro")).toEqual({
      hostRoot: path.resolve("C:\\Users\\kai\\workspace"),
      containerRoot: "/workspace",
      writable: false,
    });
    expect(parseSandboxBindMount("D:/data:/workspace-data:rw")).toEqual({
      hostRoot: path.resolve("D:/data"),
      containerRoot: "/workspace-data",
      writable: true,
    });
  });

  it("parses UNC-style host paths", () => {
    expect(parseSandboxBindMount("//server/share:/workspace:ro")).toEqual({
      hostRoot: path.resolve("//server/share"),
      containerRoot: "/workspace",
      writable: false,
    });
  });
});

describe("resolveSandboxFsPathWithMounts", () => {
  it("maps mounted container absolute paths to host paths", () => {
    const sandbox = createSandbox({
      docker: {
        ...createSandbox().docker,
        binds: ["/tmp/workspace-two:/workspace-two:ro"],
      },
    });
    const mounts = buildSandboxFsMounts(sandbox);
    const resolved = resolveSandboxFsPathWithMounts({
      filePath: "/workspace-two/docs/AGENTS.md",
      cwd: sandbox.workspaceDir,
      defaultWorkspaceRoot: sandbox.workspaceDir,
      defaultContainerRoot: sandbox.containerWorkdir,
      mounts,
    });

    expect(resolved.hostPath).toBe(
      path.join(path.resolve("/tmp/workspace-two"), "docs", "AGENTS.md"),
    );
    expect(resolved.containerPath).toBe("/workspace-two/docs/AGENTS.md");
    expect(resolved.relativePath).toBe("/workspace-two/docs/AGENTS.md");
    expect(resolved.writable).toBe(false);
  });

  it("keeps workspace-relative display paths for default workspace files", () => {
    const sandbox = createSandbox();
    const mounts = buildSandboxFsMounts(sandbox);
    const resolved = resolveSandboxFsPathWithMounts({
      filePath: "src/index.ts",
      cwd: sandbox.workspaceDir,
      defaultWorkspaceRoot: sandbox.workspaceDir,
      defaultContainerRoot: sandbox.containerWorkdir,
      mounts,
    });
    expect(resolved.hostPath).toBe(path.join(path.resolve("/tmp/workspace"), "src", "index.ts"));
    expect(resolved.containerPath).toBe("/workspace/src/index.ts");
    expect(resolved.relativePath).toBe("src/index.ts");
    expect(resolved.writable).toBe(true);
  });

  it("includes the container workspace root in outside-path errors", () => {
    const sandbox = createSandbox();
    const mounts = buildSandboxFsMounts(sandbox);
    expect(() =>
      resolveSandboxFsPathWithMounts({
        filePath: "/etc/passwd",
        cwd: sandbox.workspaceDir,
        defaultWorkspaceRoot: sandbox.workspaceDir,
        defaultContainerRoot: sandbox.containerWorkdir,
        mounts,
      }),
    ).toThrow(
      /Path escapes sandbox root \(.*container root \/workspace\): \/etc\/passwd\. Use a path under \/workspace\/ instead\./,
    );
  });

  it("uses the configured custom container root in outside-path errors", () => {
    const sandbox = createSandbox({
      containerWorkdir: "/sandbox-root",
      docker: {
        ...createSandbox().docker,
        workdir: "/sandbox-root",
      },
    });
    const mounts = buildSandboxFsMounts(sandbox);
    expect(() =>
      resolveSandboxFsPathWithMounts({
        filePath: "/tmp/healthcheck-alert/config.json",
        cwd: sandbox.workspaceDir,
        defaultWorkspaceRoot: sandbox.workspaceDir,
        defaultContainerRoot: sandbox.containerWorkdir,
        mounts,
      }),
    ).toThrow(
      /Path escapes sandbox root \(.*container root \/sandbox-root\): \/tmp\/healthcheck-alert\/config\.json\. Use a path under \/sandbox-root\/ instead\./,
    );
  });

  it("includes container workspace hint without exposing a full home workspace root", () => {
    const workspaceDir = path.join(os.homedir(), "workspace-coder");
    const sandbox = createSandbox({
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
    });
    const mounts = buildSandboxFsMounts(sandbox);
    let thrown: unknown;
    try {
      resolveSandboxFsPathWithMounts({
        filePath: "/tmp/outside",
        cwd: sandbox.workspaceDir,
        defaultWorkspaceRoot: sandbox.workspaceDir,
        defaultContainerRoot: sandbox.containerWorkdir,
        mounts,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(
      "Path escapes sandbox root (~/workspace-coder; container root /workspace): /tmp/outside",
    );
    expect(message).toContain("Use a path under /workspace/ instead.");
    expect(message).not.toContain(os.homedir());
  });

  it("prefers custom bind mounts over default workspace mount at /workspace", () => {
    const sandbox = createSandbox({
      docker: {
        ...createSandbox().docker,
        binds: ["/tmp/override:/workspace:ro"],
      },
    });
    const mounts = buildSandboxFsMounts(sandbox);
    const resolved = resolveSandboxFsPathWithMounts({
      filePath: "/workspace/docs/AGENTS.md",
      cwd: sandbox.workspaceDir,
      defaultWorkspaceRoot: sandbox.workspaceDir,
      defaultContainerRoot: sandbox.containerWorkdir,
      mounts,
    });

    expect(resolved.hostPath).toBe(path.join(path.resolve("/tmp/override"), "docs", "AGENTS.md"));
    expect(resolved.writable).toBe(false);
  });
});
