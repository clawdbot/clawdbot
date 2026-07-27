// Sbx tests cover backend plugin behavior.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
  createSandboxTestContext,
} from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { createSbxSandboxBackendFactory } from "./backend.js";
import { resolveSbxPluginConfig } from "./config.js";

const OPENCLAW_SBX_E2E = process.env.OPENCLAW_E2E_SBX === "1";
const OPENCLAW_SBX_E2E_TIMEOUT_MS = 8 * 60_000;
const OPENCLAW_SBX_COMMAND = process.env.OPENCLAW_E2E_SBX_COMMAND?.trim() || "sbx";

type ExecResult = { code: number; stdout: string; stderr: string };

async function runCommand(params: {
  command: string;
  args: string[];
  allowFailure?: boolean;
  timeoutMs?: number;
}): Promise<ExecResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timeout = params.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), params.timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !params.allowFailure) {
        reject(new Error(`command failed: ${params.command} ${params.args.join(" ")}\n${stderr}`));
        return;
      }
      resolve({ code: exitCode, stdout, stderr });
    });
  });
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    const result = await runCommand({
      command,
      args: ["version"],
      allowFailure: true,
      timeoutMs: 20_000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function runBackendExec(params: {
  backend: Awaited<ReturnType<ReturnType<typeof createSbxSandboxBackendFactory>>>;
  command: string;
  allowFailure?: boolean;
  timeoutMs?: number;
}): Promise<ExecResult> {
  const execSpec = await params.backend.buildExecSpec({
    command: params.command,
    env: {},
    usePty: false,
  });
  return await runCommand({
    command: execSpec.argv[0] ?? OPENCLAW_SBX_COMMAND,
    args: execSpec.argv.slice(1),
    allowFailure: params.allowFailure,
    timeoutMs: params.timeoutMs,
  });
}

describe("sbx sandbox backend e2e", () => {
  it.runIf(process.platform !== "win32" && OPENCLAW_SBX_E2E)(
    "creates a bind-mounted sandbox and executes through the sbx CLI",
    { timeout: OPENCLAW_SBX_E2E_TIMEOUT_MS },
    async () => {
      if (!(await commandAvailable(OPENCLAW_SBX_COMMAND))) {
        return;
      }

      const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sbx-e2e-"));
      const workspaceDir = path.join(rootDir, "workspace");
      const scopeSuffix = `${process.pid}-${Date.now()}`;
      const scopeKey = `session:sbx-e2e:${scopeSuffix}`;
      const sandboxCfg = {
        mode: "all" as const,
        backend: "sbx" as const,
        scope: "session" as const,
        workspaceAccess: "rw" as const,
        workspaceRoot: path.join(rootDir, "sandboxes"),
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          containerPrefix: "openclaw-sbx-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp"],
          network: "none",
          capDrop: ["ALL"],
          env: {},
        },
        ssh: createSandboxSshConfig("/tmp/openclaw-sandboxes"),
        browser: createSandboxBrowserConfig(),
        tools: { allow: [], deny: [] },
        prune: createSandboxPruneConfig(),
      };

      const pluginConfig = resolveSbxPluginConfig({
        command: OPENCLAW_SBX_COMMAND,
        agent: "shell",
      });
      const backendFactory = createSbxSandboxBackendFactory({ pluginConfig });
      const backend = await backendFactory({
        sessionKey: scopeKey,
        scopeKey,
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg: sandboxCfg,
      });

      try {
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.writeFile(path.join(workspaceDir, "seed.txt"), "seed-from-local\n", "utf8");

        const execResult = await runBackendExec({
          backend,
          command: "pwd && cat seed.txt",
          timeoutMs: 2 * 60_000,
        });
        expect(execResult.code).toBe(0);
        expect(execResult.stdout).toContain(workspaceDir);
        expect(execResult.stdout).toContain("seed-from-local");

        const sandbox = createSandboxTestContext({
          overrides: {
            backendId: "sbx",
            workspaceDir,
            agentWorkspaceDir: workspaceDir,
            runtimeId: backend.runtimeId,
            runtimeLabel: backend.runtimeLabel,
            containerName: backend.runtimeId,
            containerWorkdir: backend.workdir,
            backend,
          },
        });
        const bridge = backend.createFsBridge?.({ sandbox });
        if (!bridge) {
          throw new Error("sbx backend did not create a filesystem bridge");
        }

        await bridge.writeFile({ filePath: "nested/bridge-write.txt", data: "hello-bridge\n" });
        // sbx bind-mounts the workspace at an identical host path, so a bridge
        // write is immediately visible on the host without any download/sync step.
        await expect(
          fs.readFile(path.join(workspaceDir, "nested", "bridge-write.txt"), "utf8"),
        ).resolves.toBe("hello-bridge\n");
        await expect(bridge.readFile({ filePath: "nested/bridge-write.txt" })).resolves.toEqual(
          Buffer.from("hello-bridge\n"),
        );
      } finally {
        await runCommand({
          command: OPENCLAW_SBX_COMMAND,
          args: ["rm", backend.runtimeId, "--force"],
          allowFailure: true,
          timeoutMs: 60_000,
        });
        await fs.rm(rootDir, { recursive: true, force: true });
      }
    },
  );
});
