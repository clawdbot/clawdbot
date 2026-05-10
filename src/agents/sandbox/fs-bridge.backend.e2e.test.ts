import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  SandboxBackendHandle,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
} from "./backend-handle.types.js";

async function runLocalShellCommand(
  params: SandboxBackendCommandParams,
): Promise<SandboxBackendCommandResult> {
  return await new Promise<SandboxBackendCommandResult>((resolve, reject) => {
    const child = spawn(
      "sh",
      ["-c", params.script, "openclaw-sandbox-fs", ...(params.args ?? [])],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let aborted = false;

    const onAbort = () => {
      if (aborted) {
        return;
      }
      aborted = true;
      child.kill("SIGTERM");
    };
    params.signal?.addEventListener("abort", onAbort);

    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on("error", reject);
    child.on("close", (code) => {
      params.signal?.removeEventListener("abort", onAbort);
      if (aborted || params.signal?.aborted) {
        const error = new Error("Aborted");
        error.name = "AbortError";
        reject(error);
        return;
      }

      const result = {
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        code: code ?? 0,
      };
      if (result.code !== 0 && !params.allowFailure) {
        reject(new Error(result.stderr.toString("utf8").trim() || `shell exited ${result.code}`));
        return;
      }
      resolve(result);
    });

    if (child.stdin) {
      child.stdin.end(params.stdin);
    }
  });
}

describe("sandbox fs bridge local backend e2e", () => {
  it.runIf(process.platform !== "win32")(
    "writes through backend shell commands using the pinned mutation helper",
    async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fsbridge-e2e-"));
      const workspacePath = path.join(stateDir, "workspace");
      await fs.mkdir(workspacePath, { recursive: true });
      const workspaceDir = await fs.realpath(workspacePath);
      const scripts: string[] = [];
      const backend: SandboxBackendHandle = {
        id: "local-test",
        runtimeId: "local-backend-fsbridge",
        runtimeLabel: "local-backend-fsbridge",
        workdir: workspaceDir,
        buildExecSpec: async ({ command, env }) => ({
          argv: ["sh", "-c", command],
          env,
          stdinMode: "pipe-closed",
        }),
        runShellCommand: async (params) => {
          scripts.push(params.script);
          return await runLocalShellCommand(params);
        },
      };

      try {
        const [{ createSandboxFsBridge }, { createSandboxTestContext }] = await Promise.all([
          import("./fs-bridge.js"),
          import("./test-fixtures.js"),
        ]);

        const sandbox = createSandboxTestContext({
          overrides: {
            workspaceDir,
            agentWorkspaceDir: workspaceDir,
            containerName: "local-backend-fsbridge",
            containerWorkdir: workspaceDir,
            backend,
          },
        });

        const bridge = createSandboxFsBridge({ sandbox });
        await bridge.writeFile({ filePath: "nested/hello.txt", data: "from-backend" });

        await expect(
          fs.readFile(path.join(workspaceDir, "nested", "hello.txt"), "utf8"),
        ).resolves.toBe("from-backend");
        expect(scripts.some((script) => script.includes("operation = sys.argv[1]"))).toBe(true);
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );
});
