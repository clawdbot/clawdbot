// Sandbox filesystem bridge boundary tests cover host-side validation before
// any Docker filesystem command can run.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createHostEscapeFixture,
  createSandbox,
  createSandboxFsBridge,
  expectMkdirpAllowsExistingDirectory,
  findCallByDockerArg,
  installFsBridgeTestHarness,
  mockedExecDockerRaw,
  withTempDir,
} from "./fs-bridge.test-helpers.js";

describe("sandbox fs bridge boundary validation", () => {
  installFsBridgeTestHarness();

  it("blocks writes into read-only bind mounts", async () => {
    const sandbox = createSandbox({
      docker: {
        ...createSandbox().docker,
        binds: ["/tmp/workspace-two:/workspace-two:ro"],
      },
    });
    const bridge = createSandboxFsBridge({ sandbox });

    await expect(
      bridge.writeFile({ filePath: "/workspace-two/new.txt", data: "hello" }),
    ).rejects.toThrow(/read-only/);
    expect(mockedExecDockerRaw).not.toHaveBeenCalled();
  });

  it("allows mkdirp for existing in-boundary subdirectories", async () => {
    await expectMkdirpAllowsExistingDirectory();
  });

  it("allows mkdirp when boundary open reports io for an existing directory", async () => {
    await expectMkdirpAllowsExistingDirectory({ forceBoundaryIoFallback: true });
  });

  it("rejects mkdirp when target exists as a file", async () => {
    await withTempDir("openclaw-fs-bridge-mkdirp-file-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      const filePath = path.join(workspaceDir, "memory", "kemik");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "not a directory");

      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      await expect(bridge.mkdirp({ filePath: "memory/kemik" })).rejects.toThrow(
        /cannot create directories/i,
      );
      expect(findCallByDockerArg(1, "mkdirp")).toBeUndefined();
    });
  });

  it("rejects pre-existing host symlink escapes before docker exec", async () => {
    // Host-visible symlink escapes are rejected locally so Docker never follows
    // them inside a privileged bridge command.
    await withTempDir("openclaw-fs-bridge-", async (stateDir) => {
      const { workspaceDir, outsideFile } = await createHostEscapeFixture(stateDir);
      if (process.platform === "win32") {
        return;
      }
      await fs.symlink(outsideFile, path.join(workspaceDir, "link.txt"));

      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      await expect(bridge.readFile({ filePath: "link.txt" })).rejects.toThrow(/Symlink escapes/);
      expect(mockedExecDockerRaw).not.toHaveBeenCalled();
    });
  });

  it("rejects pre-existing host hardlink escapes before docker exec", async () => {
    // Hardlinks can expose outside files without a symlink marker, so the bridge
    // checks link metadata before reads enter the container.
    if (process.platform === "win32") {
      return;
    }
    await withTempDir("openclaw-fs-bridge-hardlink-", async (stateDir) => {
      const { workspaceDir, outsideFile } = await createHostEscapeFixture(stateDir);
      const hardlinkPath = path.join(workspaceDir, "link.txt");
      try {
        await fs.link(outsideFile, hardlinkPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          return;
        }
        throw err;
      }

      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      await expect(bridge.readFile({ filePath: "link.txt" })).rejects.toThrow(/hardlink|sandbox/i);
      expect(mockedExecDockerRaw).not.toHaveBeenCalled();
    });
  });

  it("rejects missing files before any docker read command runs", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });
    await expect(bridge.readFile({ filePath: "a.txt" })).rejects.toThrow(/ENOENT|no such file/i);
    expect(mockedExecDockerRaw).not.toHaveBeenCalled();
  });
});
