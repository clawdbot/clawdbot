import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_IMAGE } from "./constants.js";

type DockerExecResult = {
  stdout: string;
  stderr: string;
  code: number;
};

async function execDockerRawForTest(args: string[]): Promise<DockerExecResult> {
  return await new Promise<DockerExecResult>((resolve) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", () => {
      resolve({ stdout: "", stderr: "", code: 1 });
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}

async function execDockerForTest(args: string[]): Promise<void> {
  const result = await execDockerRawForTest(args);
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `docker ${args.join(" ")}`;
    throw new Error(message);
  }
}

async function sandboxImageReady(): Promise<boolean> {
  try {
    const dockerVersion = await execDockerRawForTest(["version"]);
    if (dockerVersion.code !== 0) {
      return false;
    }
    const pythonCheck = await execDockerRawForTest([
      "run",
      "--rm",
      "--entrypoint",
      "python3",
      DEFAULT_SANDBOX_IMAGE,
      "--version",
    ]);
    return pythonCheck.code === 0;
  } catch {
    return false;
  }
}

describe("sandbox fs bridge docker e2e", () => {
  it.runIf(process.platform !== "win32")(
    "writes through docker exec using the pinned mutation helper",
    async () => {
      if (!(await sandboxImageReady())) {
        return;
      }

      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fsbridge-e2e-"));
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });

      const suffix = `${process.pid}-${Date.now()}`;
      const containerName = `openclaw-fsbridge-${suffix}`.slice(0, 63);

      try {
        const [
          { buildSandboxCreateArgs },
          { createSandboxFsBridge },
          { createSandboxTestContext },
          { appendWorkspaceMountArgs },
        ] = await Promise.all([
          import("./docker.js"),
          import("./fs-bridge.js"),
          import("./test-fixtures.js"),
          import("./workspace-mounts.js"),
        ]);

        const sandbox = createSandboxTestContext({
          overrides: {
            workspaceDir,
            agentWorkspaceDir: workspaceDir,
            containerName,
            containerWorkdir: "/workspace",
          },
          dockerOverrides: {
            image: DEFAULT_SANDBOX_IMAGE,
            containerPrefix: "openclaw-fsbridge-",
            user: "",
          },
        });

        const createArgs = buildSandboxCreateArgs({
          name: containerName,
          cfg: sandbox.docker,
          scopeKey: sandbox.sessionKey,
          includeBinds: false,
          bindSourceRoots: [workspaceDir],
        });
        createArgs.push("--workdir", sandbox.containerWorkdir);
        appendWorkspaceMountArgs({
          args: createArgs,
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          workdir: sandbox.containerWorkdir,
          workspaceAccess: sandbox.workspaceAccess,
        });
        createArgs.push(sandbox.docker.image, "sleep", "infinity");

        await execDockerForTest(createArgs);
        await execDockerForTest(["start", containerName]);

        const bridge = createSandboxFsBridge({ sandbox });
        await bridge.writeFile({ filePath: "nested/hello.txt", data: "from-docker" });

        await expect(
          fs.readFile(path.join(workspaceDir, "nested", "hello.txt"), "utf8"),
        ).resolves.toBe("from-docker");
      } finally {
        await execDockerRawForTest(["rm", "-f", containerName]);
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );
});
