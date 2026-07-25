// Openshell tests cover backend plugin behavior.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
} from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { createOpenShellSandboxBackendFactory } from "./backend.js";
import { resolveOpenShellPluginConfig } from "./config.js";

const OPENCLAW_OPENSHELL_E2E = process.env.OPENCLAW_E2E_OPENSHELL === "1";
const OPENCLAW_OPENSHELL_E2E_TIMEOUT_MS = 12 * 60_000;
const OPENCLAW_OPENSHELL_COMMAND =
  process.env.OPENCLAW_E2E_OPENSHELL_COMMAND?.trim() || "openshell";
const OPENCLAW_OPENSHELL_CONFIG_HOME =
  process.env.OPENCLAW_E2E_OPENSHELL_CONFIG_HOME?.trim() || null;
const OPENCLAW_OPENSHELL_HOST_IP = process.env.OPENCLAW_E2E_OPENSHELL_HOST_IP?.trim() || null;
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, "gu");

const CUSTOM_IMAGE_DOCKERFILE = `FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \\
    coreutils curl findutils iproute2 nftables \\
  && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 1000660000 sandbox && \\
    useradd -m -u 1000660000 -g sandbox sandbox && \\
    install -d -o sandbox -g sandbox /sandbox

RUN echo "openclaw-openshell-e2e" > /opt/openshell-e2e-marker.txt

USER sandbox
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
        const message = [
          `command failed: ${params.command} ${params.args.join(" ")}`,
          `exit: ${exitCode}`,
        ];
        const trimmedStdout = stdout.trim();
        if (trimmedStdout.length > 0) {
          message.push(`stdout:\n${stdout}`);
        }
        const trimmedStderr = stderr.trim();
        if (trimmedStderr.length > 0) {
          message.push(`stderr:\n${stderr}`);
        }
        reject(new Error(message.join("\n")));
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

async function activeOpenShellGateway(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    const result = await runCommand({
      command,
      args: ["gateway", "list"],
      env,
      allowFailure: true,
      timeoutMs: 20_000,
    });
    if (result.code !== 0) {
      return null;
    }
    const output = `${result.stdout}\n${result.stderr}`.replace(ANSI_ESCAPE_RE, "");
    for (const line of output.split(/\r?\n/u)) {
      const match = line.match(/\*\s+(\S+)/u);
      if (match) {
        const gateway = expectDefined(match[1], "OpenShell gateway name");
        const info = await runCommand({
          command,
          args: ["gateway", "info", "--gateway", gateway],
          env,
          allowFailure: true,
          timeoutMs: 20_000,
        });
        const endpoint = `${info.stdout}\n${info.stderr}`
          .replace(ANSI_ESCAPE_RE, "")
          .match(/Gateway endpoint:\s+(\S+)/u)?.[1];
        if (
          info.code === 0 &&
          endpoint &&
          /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/u.test(endpoint)
        ) {
          const status = await runCommand({
            command,
            args: ["--gateway", gateway, "sandbox", "list"],
            env,
            allowFailure: true,
            timeoutMs: 20_000,
          });
          return status.code === 0 ? gateway : null;
        }
        return null;
      }
    }
    return null;
  } catch {
    return null;
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

async function resolveOpenShellHostIp(): Promise<string> {
  if (OPENCLAW_OPENSHELL_HOST_IP) {
    return OPENCLAW_OPENSHELL_HOST_IP;
  }
  const networks = await runCommand({
    command: "docker",
    args: ["network", "ls", "--format", "{{.Name}}"],
    timeoutMs: 20_000,
  });
  for (const network of networks.stdout.split(/\r?\n/u).map((value) => value.trim())) {
    if (!network.startsWith("openshell")) {
      continue;
    }
    const gateway = await runCommand({
      command: "docker",
      args: [
        "network",
        "inspect",
        network,
        "--format",
        "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
      ],
      allowFailure: true,
      timeoutMs: 20_000,
    });
    const hostIp = gateway.stdout.trim();
    if (gateway.code === 0 && hostIp) {
      return hostIp;
    }
  }
  throw new Error(
    "OpenShell E2E could not resolve the OpenShell Docker network gateway; set OPENCLAW_E2E_OPENSHELL_HOST_IP",
  );
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
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }

  await runCommand({
    command: "docker",
    args: ["rm", "-f", containerId],
    allowFailure: true,
    timeoutMs: 30_000,
  });
  throw new Error("docker-backed host policy server did not become ready");
}

function buildOpenShellPolicyYaml(params: {
  port: number;
  binaryPath: string;
  hostIp: string;
}): string {
  const networkPolicies = `  host_echo:
    name: host-echo
    endpoints:
      - host: host.openshell.internal
        port: ${params.port}
        protocol: rest
        enforcement: enforce
        access: full
        allowed_ips:
          - "${params.hostIp}/32"
    binaries:
      - path: ${params.binaryPath}`;
  return `version: 1

filesystem_policy:
  include_workdir: true
  read_only: [/usr, /lib, /proc, /dev/urandom, /app, /etc, /var/log, /opt]
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
  let result: ExecResult | null | undefined;
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
        throw new Error("OpenShell E2E requires a working Docker daemon");
      }
      if (!(await commandAvailable(OPENCLAW_OPENSHELL_COMMAND))) {
        throw new Error(`OpenShell CLI is unavailable: ${OPENCLAW_OPENSHELL_COMMAND}`);
      }
      if (!OPENCLAW_OPENSHELL_CONFIG_HOME) {
        throw new Error(
          "OpenShell E2E requires OPENCLAW_E2E_OPENSHELL_CONFIG_HOME because tests isolate HOME and XDG_CONFIG_HOME",
        );
      }
      const openshellConfigHome = OPENCLAW_OPENSHELL_CONFIG_HOME;
      const hostIp = await resolveOpenShellHostIp();
      const gatewayName = await activeOpenShellGateway(OPENCLAW_OPENSHELL_COMMAND, {
        ...process.env,
        XDG_CONFIG_HOME: openshellConfigHome,
      });
      if (!gatewayName) {
        throw new Error("OpenShell E2E requires an active local registered gateway");
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
      const scopeKey = `session:openshell-e2e-deny:${scopeSuffix}`;
      const allowSandboxName = `openclaw-policy-allow-${scopeSuffix}`;
      let hostPolicyServer: HostPolicyServer | null | undefined;
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
        const isolatedConfigHome = env.XDG_CONFIG_HOME;
        if (!isolatedConfigHome) {
          throw new Error("OpenShell E2E could not create an isolated XDG config home");
        }
        await fs.mkdir(isolatedConfigHome, { recursive: true });
        await fs.cp(
          path.join(openshellConfigHome, "openshell"),
          path.join(isolatedConfigHome, "openshell"),
          { recursive: true },
        );
        await fs.writeFile(path.join(workspaceDir, "seed.txt"), "seed-from-local\n", "utf8");
        await fs.writeFile(dockerfilePath, CUSTOM_IMAGE_DOCKERFILE, "utf8");
        await fs.writeFile(
          denyPolicyPath,
          buildOpenShellPolicyYaml({
            port: hostPolicyServer.port,
            binaryPath: "/usr/bin/false",
            hostIp,
          }),
          "utf8",
        );
        await fs.writeFile(
          allowPolicyPath,
          buildOpenShellPolicyYaml({
            port: hostPolicyServer.port,
            binaryPath: "/usr/bin/curl",
            hostIp,
          }),
          "utf8",
        );

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
        const hostReadError = await fs
          .readFile(path.join(workspaceDir, "nested", "remote-only.txt"), "utf8")
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(hostReadError).toBeInstanceOf(Error);
        expect((hostReadError as NodeJS.ErrnoException).code).toBe("ENOENT");
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
