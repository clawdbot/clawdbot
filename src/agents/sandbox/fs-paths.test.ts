// Sandbox filesystem path tests cover bind parsing, host/container path mapping,
// and writable-root detection.
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSandboxFsMounts,
  hasSandboxBindContainerPathAliases,
  hasSandboxBindReadonlyHostShadows,
  resolveSandboxFsPathWithMounts,
  resolveWritableSandboxBindHostRoots,
} from "./fs-paths.js";
import { createSandboxTestContext } from "./test-fixtures.js";
import type { SandboxContext } from "./types.js";

function createSandbox(overrides?: Partial<SandboxContext>): SandboxContext {
  return createSandboxTestContext({ overrides });
}

describe("sandbox bind mounts", () => {
  it("returns only unique writable bind host roots", () => {
    expect(
      resolveWritableSandboxBindHostRoots([
        "/tmp/data:/data:rw",
        "/tmp/read-only:/read-only:ro",
        "/tmp/default-write:/default-write",
        "/tmp/data:/data-two:rw",
        "C:\\Users\\kai\\workspace:/windows-read-only:ro",
        "D:/data:/windows-data:rw",
        "//server/share:/unc-share:rw",
        "invalid-bind",
      ]),
    ).toEqual([
      path.resolve("/tmp/data"),
      path.resolve("/tmp/default-write"),
      path.resolve("D:/data"),
      path.resolve("//server/share"),
    ]);
  });

  it("omits writable bind roots that contain read-only host shadows", () => {
    // A writable parent with a read-only child is unsafe for generic host writes;
    // callers must route through mount-aware path resolution instead.
    expect(
      resolveWritableSandboxBindHostRoots([
        "/tmp/data:/tmp/data:rw",
        "/tmp/data/secrets:/tmp/data/secrets:ro",
        "/tmp/readonly-parent:/tmp/readonly-parent:ro",
        "/tmp/readonly-parent/work:/tmp/readonly-parent/work:rw",
      ]),
    ).toEqual([path.resolve("/tmp/readonly-parent/work")]);
  });

  it("detects bind mounts whose container path differs from the host path", () => {
    expect(hasSandboxBindContainerPathAliases(["/tmp/data:/tmp/data:rw"])).toBe(false);
    expect(hasSandboxBindContainerPathAliases(["/tmp/data:/data:rw"])).toBe(true);
    expect(hasSandboxBindContainerPathAliases(["invalid-bind"])).toBe(false);
  });

  it("detects read-only bind shadows inside writable host roots", () => {
    expect(
      hasSandboxBindReadonlyHostShadows([
        "/tmp/data:/tmp/data:rw",
        "/tmp/data/secrets:/tmp/data/secrets:ro",
      ]),
    ).toBe(true);
    expect(
      hasSandboxBindReadonlyHostShadows([
        "/tmp/data:/tmp/data:ro",
        "/tmp/data/work:/tmp/data/work:rw",
      ]),
    ).toBe(false);
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
    // Error messages should guide users toward container paths without printing
    // the host home directory.
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
