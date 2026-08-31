// Proves a slash-root container workspace through a real local backend.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createSandboxedReadTool,
  wrapToolWorkspaceRootGuardWithOptions,
} from "../agent-tools.read.js";
import type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendHandle,
} from "./backend-handle.types.js";
import { registerSandboxBackend } from "./backend.js";
import { resolveSandboxContext } from "./context.js";

function mapRootMountedArgs(args: readonly string[], hostRoot: string): string[] {
  return args.map((arg) =>
    arg === "/"
      ? hostRoot
      : arg === hostRoot || arg.startsWith(`${hostRoot}${path.sep}`)
        ? arg
        : arg.startsWith("/")
          ? path.join(hostRoot, arg.slice(1))
          : arg,
  );
}

async function runRootMountedShellCommand(
  params: SandboxBackendCommandParams,
  hostRoot: string,
): Promise<SandboxBackendCommandResult> {
  const args = mapRootMountedArgs(params.args ?? [], hostRoot);
  return await new Promise<SandboxBackendCommandResult>((resolve, reject) => {
    const child = spawn("sh", ["-c", params.script, "openclaw-sandbox-fs", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
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
    child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
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
    child.stdin?.end(params.stdin);
  });
}

describe("sandbox fs bridge slash-root backend", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.runIf(process.platform !== "win32")(
    "reads a slash-root container path through the real guard and bridge",
    async () => {
      const stateDir = tempDirs.make("openclaw-fsbridge-root-test-");
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(path.join(workspaceDir, "docs"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "docs", "readme.md"), "from-real-bridge");
      const backend: SandboxBackendHandle = {
        id: "local-test",
        runtimeId: "local-backend-fsbridge-root",
        runtimeLabel: "local-backend-fsbridge-root",
        workdir: "/",
        buildExecSpec: async ({ command, env }) => ({
          argv: ["sh", "-c", command],
          env,
          stdinMode: "pipe-closed",
        }),
        runShellCommand: (params) => runRootMountedShellCommand(params, workspaceDir),
      };
      const restore = registerSandboxBackend("local-test", {
        factory: async () => backend,
        resolveWorkdir: () => backend.workdir,
      });

      try {
        const config: OpenClawConfig = {
          agents: {
            defaults: {
              sandbox: {
                mode: "all",
                backend: "local-test",
                scope: "session",
                workspaceAccess: "rw",
                prune: { idleHours: 0, maxAgeDays: 0 },
              },
            },
          },
        };
        const sandbox = await resolveSandboxContext({
          config,
          execOverrides: { host: "node", node: "build-node", security: "allowlist" },
          sessionKey: "agent:main:root-workdir",
          workspaceDir,
        });
        if (!sandbox?.fsBridge) {
          throw new Error("Sandbox context did not create an fs bridge");
        }
        expect(sandbox.containerWorkdir).toBe(backend.workdir);
        const bridge = sandbox.fsBridge;
        const readTool = wrapToolWorkspaceRootGuardWithOptions(
          createSandboxedReadTool({ root: sandbox.workspaceDir, bridge }),
          sandbox.workspaceDir,
          { containerWorkdir: sandbox.containerWorkdir },
        );
        const mapped = bridge.resolvePath({ filePath: "/docs/readme.md", cwd: workspaceDir });
        const result = await readTool.execute("tc-root-workdir", { path: "/docs/readme.md" });

        expect(mapped.relativePath).toBe("docs/readme.md");
        expect(mapped.containerPath).toBe("/docs/readme.md");
        expect(result.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("from-real-bridge"),
            }),
          ]),
        );
        await expect(
          bridge.readFile({ filePath: "../outside.txt", cwd: workspaceDir }),
        ).rejects.toThrow(/escapes sandbox root/i);
        console.info(
          "REAL_SANDBOX_ROOT_PROOF path=/docs/readme.md mapped=/docs/readme.md content=from-real-bridge outside=REJECTED",
        );
      } finally {
        restore();
      }
    },
  );
});
