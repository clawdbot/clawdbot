import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSandboxTestContext } from "../../../src/agents/sandbox/test-fixtures.js";
import {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
} from "../../../test/helpers/sandbox-fixtures.js";
import { createOpenShellSandboxBackendFactory } from "./backend.js";
import { resolveOpenShellPluginConfig } from "./config.js";

const OPENCLAW_OPENSHELL_E2E = process.env.OPENCLAW_E2E_OPENSHELL === "1";
const OPENCLAW_OPENSHELL_E2E_TIMEOUT_MS = 12 * 60_000;
const OPENCLAW_OPENSHELL_COMMAND =
  process.env.OPENCLAW_E2E_OPENSHELL_COMMAND?.trim() || "openshell";

const CUSTOM_IMAGE_DOCKERFILE = `FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \\
    coreutils \\
    curl \\
    findutils \\
    iproute2 \\
  && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 1000 sandbox && \\
    useradd -m -u 1000 -g sandbox sandbox

RUN echo "openclaw-openshell-e2e" > /opt/openshell-e2e-marker.txt

WORKDIR /sandbox
CMD ["sleep", "infinity"]
`;

type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type HostPolicyServer = {
  port: number;
  close(): Promise<void>;
};

async function runCommand(params: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Uint8Array;
  allowFailure?: boolean;
  timeoutMs?: number;
}): Promise<ExecResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const timeout =
      params.timeoutMs && params.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, params.timeoutMs)
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
      if (timedOut) {
        reject(new Error(`command timed out: ${params.command} ${params.args.join(" ")}`));
        return;
      }
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !params.allowFailure) {
        reject(
          new Error(
            [
              `command failed: ${params.command} ${params.args.join(" ")}`,
              `exit: ${exitCode}`,
              stdout.trim() ? `stdout:\n${stdout}` : "",
              stderr.trim() ? `stderr:\n${stderr}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          ),
        );
        return;
      }
      resolve({ code: exitCode, stdout, stderr });
    });

    child.stdin.end(params.stdin);
  });
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    const result = await runCommand({
      command,
      args: ["--help"],
      allowFailure: true,
      timeoutMs: 20_000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function openshellGatewayAvailable(command: string): Promise<boolean> {
  try {
    const result = await runCommand({
      command,
      args: ["gateway", "start", "--help"],
      allowFailure: true,
      timeoutMs: 20_000,
    });
    return result.code === 0 && `${result.stdout}\n${result.stderr}`.includes("--name");
  } catch {
    return false;
  }
}

async function dockerReady(): Promise<boolean> {
  try {
    const result = await runCommand({
      command: "docker",
      args: ["version"],
      allowFailure: true,
      timeoutMs: 20_000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate local port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function openshellEnv(rootDir: string): NodeJS.ProcessEnv {
  const homeDir = path.join(rootDir, "home");
  const xdgDir = path.join(rootDir, "xdg");
  const cacheDir = path.join(rootDir, "xdg-cache");
  return {
    ...process.env,
    HOME: homeDir,
    XDG_CONFIG_HOME: xdgDir,
    XDG_CACHE_HOME: cacheDir,
  };
}

function trimTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

async function startHostPolicyServer(): Promise<HostPolicyServer> {
  const port = await allocatePort();
  const responseBody = JSON.stringify({ ok: true, message: "hello-from-host" });
  const serverScript = `from http.server import BaseHTTPRequestHandler, HTTPServer
import os

BODY = os.environ["RESPONSE_BODY"].encode()

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length:
            self.rfile.read(length)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

    def log_message(self, _format, *_args):
        pass

HTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
`;
  const startResult = await runCommand({
    command: "docker",
    args: [
      "run",
      "--detach",
      "--rm",
      "-e",
      `RESPONSE_BODY=${responseBody}`,
      "-p",
      `${port}:8000`,
      "python:3.13-alpine",
      "python3",
      "-c",
      serverScript,
    ],
    timeoutMs: 60_000,
  });
  const containerId = trimTrailingNewline(startResult.stdout.trim());
  if (!containerId) {
    throw new Error("failed to start docker-backed host policy server");
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const readyResult = await runCommand({
      command: "docker",
      args: [
        "exec",
        containerId,
        "python3",
        "-c",
        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000', timeout=1).read()",
      ],
      allowFailure: true,
      timeoutMs: 15_000,
    });
    if (readyResult.code === 0) {
      return {
        port,
        async close() {
          await runCommand({
            command: "docker",
            args: ["rm", "-f", containerId],
            allowFailure: true,
            timeoutMs: 30_000,
          });
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  await runCommand({
    command: "docker",
    args: ["rm", "-f", containerId],
    allowFailure: true,
    timeoutMs: 30_000,
  });
  throw new Error("docker-backed host policy server did not become ready");
}

function buildOpenShellPolicyYaml(params: { port: number; binaryPath: string }): string {
  const networkPolicies = `  host_echo:
    name: host-echo
    endpoints:
      - host: host.openshell.internal
        port: ${params.port}
        allowed_ips:
          - "0.0.0.0/0"
    binaries:
      - path: ${params.binaryPath}`;
  return `version: 1

filesystem_policy:
  include_workdir: true
  read_only: [/usr, /lib, /proc, /dev/urandom, /app, /etc, /var/log]
  read_write: [/sandbox, /tmp, /dev/null]

landlock:
  compatibility: best_effort

process:
  run_as_user: sandbox
  run_as_group: sandbox

network_policies:
${networkPolicies}
`;
}

async function runBackendExec(params: {
  backend: Awaited<ReturnType<ReturnType<typeof createOpenShellSandboxBackendFactory>>>;
  command: string;
  allowFailure?: boolean;
  timeoutMs?: number;
}): Promise<ExecResult> {
  const execSpec = await params.backend.buildExecSpec({
    command: params.command,
    env: {},
    usePty: false,
  });
  let result: ExecResult | null = null;
  try {
    result = await runCommand({
      command: execSpec.argv[0] ?? "ssh",
      args: execSpec.argv.slice(1),
      env: execSpec.env,
      allowFailure: params.allowFailure,
      timeoutMs: params.timeoutMs,
    });
    return result;
  } finally {
    await params.backend.finalizeExec?.({
      status: result?.code === 0 ? "completed" : "failed",
      exitCode: result?.code ?? 1,
      timedOut: false,
      token: execSpec.finalizeToken,
    });
  }
}

describe("openshell sandbox backend e2e", () => {
  it.runIf(process.platform !== "win32" && OPENCLAW_OPENSHELL_E2E)(
    "creates a remote-canonical sandbox through OpenShell and executes over SSH",
    { timeout: OPENCLAW_OPENSHELL_E2E_TIMEOUT_MS },
    async () => {
      if (!(await dockerReady())) {
        return;
      }
      if (!(await commandAvailable(OPENCLAW_OPENSHELL_COMMAND))) {
        return;
      }
      if (!(await openshellGatewayAvailable(OPENCLAW_OPENSHELL_COMMAND))) {
        return;
      }

      const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-openshell-e2e-"));
      const env = openshellEnv(rootDir);
      const previousHome = process.env.HOME;
      const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
      const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
      const workspaceDir = path.join(rootDir, "workspace");
      const dockerfileDir = path.join(rootDir, "custom-image");
      const dockerfilePath = path.join(dockerfileDir, "Dockerfile");
      const denyPolicyPath = path.join(rootDir, "deny-policy.yaml");
      const allowPolicyPath = path.join(rootDir, "allow-policy.yaml");
      const scopeSuffix = `${process.pid}-${Date.now()}`;
      const gatewayName = `openclaw-e2e-${scopeSuffix}`;
      const scopeKey = `session:openshell-e2e-deny:${scopeSuffix}`;
      const allowSandboxName = `openclaw-policy-allow-${scopeSuffix}`;
      const gatewayPort = await allocatePort();
      let hostPolicyServer: HostPolicyServer | null = null;
      const sandboxCfg = {
        mode: "all" as const,
        backend: "openshell" as const,
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

      const pluginConfig = resolveOpenShellPluginConfig({
        command: OPENCLAW_OPENSHELL_COMMAND,
        gateway: gatewayName,
        from: dockerfilePath,
        mode: "remote",
        autoProviders: false,
        policy: denyPolicyPath,
      });
      const backendFactory = createOpenShellSandboxBackendFactory({ pluginConfig });
      const backend = await backendFactory({
        sessionKey: scopeKey,
        scopeKey,
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg: sandboxCfg,
      });

      try {
        process.env.HOME = env.HOME;
        process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
        process.env.XDG_CACHE_HOME = env.XDG_CACHE_HOME;
        hostPolicyServer = await startHostPolicyServer();
        if (!hostPolicyServer) {
          throw new Error("failed to start host policy server");
        }
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(dockerfileDir, { recursive: true });
        await fs.writeFile(path.join(workspaceDir, "seed.txt"), "seed-from-local\n", "utf8");
        await fs.writeFile(dockerfilePath, CUSTOM_IMAGE_DOCKERFILE, "utf8");
        await fs.writeFile(
          denyPolicyPath,
          buildOpenShellPolicyYaml({
            port: hostPolicyServer.port,
            binaryPath: "/usr/bin/false",
          }),
          "utf8",
        );
        await fs.writeFile(
          allowPolicyPath,
          buildOpenShellPolicyYaml({
            port: hostPolicyServer.port,
            binaryPath: "/**",
          }),
          "utf8",
        );

        await runCommand({
          command: OPENCLAW_OPENSHELL_COMMAND,
          args: [
            "gateway",
            "start",
            "--name",
            gatewayName,
            "--port",
            String(gatewayPort),
            "--recreate",
          ],
          env,
          timeoutMs: 8 * 60_000,
        });

        const execResult = await runBackendExec({
          backend,
          command: "pwd && cat /opt/openshell-e2e-marker.txt && cat seed.txt",
          timeoutMs: 2 * 60_000,
        });

        expect(execResult.code).toBe(0);
        const stdout = execResult.stdout.trim();
        expect(stdout).toContain("/sandbox");
        expect(stdout).toContain("openclaw-openshell-e2e");
        expect(stdout).toContain("seed-from-local");

        const curlPathResult = await runBackendExec({
          backend,
          command: "command -v curl",
          timeoutMs: 60_000,
        });
        expect(trimTrailingNewline(curlPathResult.stdout.trim())).toMatch(/^\/.+\/curl$/);

        const sandbox = createSandboxTestContext({
          overrides: {
            backendId: "openshell",
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
          throw new Error("openshell backend did not create a filesystem bridge");
        }

        await bridge.writeFile({ filePath: "nested/remote-only.txt", data: "hello-remote\n" });
        await expect(
          fs.readFile(path.join(workspaceDir, "nested", "remote-only.txt"), "utf8"),
        ).rejects.toThrow();
        await expect(bridge.readFile({ filePath: "nested/remote-only.txt" })).resolves.toEqual(
          Buffer.from("hello-remote\n"),
        );

        const verifyResult = await runCommand({
          command: OPENCLAW_OPENSHELL_COMMAND,
          args: ["sandbox", "ssh-config", backend.runtimeId],
          env,
          timeoutMs: 60_000,
        });
        expect(verifyResult.code).toBe(0);
        expect(trimTrailingNewline(verifyResult.stdout)).toContain("Host ");

        const blockedGetResult = await runBackendExec({
          backend,
          command: `curl --fail --silent --show-error --max-time 15 "http://host.openshell.internal:${hostPolicyServer.port}/policy-test"`,
          allowFailure: true,
          timeoutMs: 60_000,
        });
        expect(blockedGetResult.code).not.toBe(0);
        expect(`${blockedGetResult.stdout}\n${blockedGetResult.stderr}`).toMatch(/403|deny/i);

        const allowedGetResult = await runCommand({
          command: OPENCLAW_OPENSHELL_COMMAND,
          args: [
            "sandbox",
            "create",
            "--name",
            allowSandboxName,
            "--from",
            dockerfilePath,
            "--policy",
            allowPolicyPath,
            "--no-auto-providers",
            "--no-keep",
            "--",
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "15",
            `http://host.openshell.internal:${hostPolicyServer.port}/policy-test`,
          ],
          env,
          timeoutMs: 60_000,
        });
        expect(allowedGetResult.code).toBe(0);
        expect(allowedGetResult.stdout).toContain('"message":"hello-from-host"');
      } finally {
        await runCommand({
          command: OPENCLAW_OPENSHELL_COMMAND,
          args: ["sandbox", "delete", backend.runtimeId],
          env,
          allowFailure: true,
          timeoutMs: 2 * 60_000,
        });
        await runCommand({
          command: OPENCLAW_OPENSHELL_COMMAND,
          args: ["sandbox", "delete", allowSandboxName],
          env,
          allowFailure: true,
          timeoutMs: 2 * 60_000,
        });
        await runCommand({
          command: OPENCLAW_OPENSHELL_COMMAND,
          args: ["gateway", "destroy", "--name", gatewayName],
          env,
          allowFailure: true,
          timeoutMs: 3 * 60_000,
        });
        await hostPolicyServer?.close().catch(() => {});
        await fs.rm(rootDir, { recursive: true, force: true });
        if (previousHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = previousHome;
        }
        if (previousXdgConfigHome === undefined) {
          delete process.env.XDG_CONFIG_HOME;
        } else {
          process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
        }
        if (previousXdgCacheHome === undefined) {
          delete process.env.XDG_CACHE_HOME;
        } else {
          process.env.XDG_CACHE_HOME = previousXdgCacheHome;
        }
      }
    },
  );
});
