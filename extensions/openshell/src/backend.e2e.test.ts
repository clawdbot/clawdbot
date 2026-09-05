// Openshell tests cover backend plugin behavior.
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  createSandboxTestContext,
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
} from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  buildOpenShellPolicyYaml,
  cleanupOpenShellWorkspace,
  runCommand,
  runBackendExec,
  runPreparedBackendExec,
  stressBackend,
  verifyRemoteExecOverlap,
} from "./backend.e2e.test-support.js";
import {
  createOpenShellSandboxBackendFactory,
  createOpenShellSandboxBackendManager,
} from "./backend.js";
import { resolveOpenShellPluginConfig } from "./config.js";

const OPENCLAW_OPENSHELL_E2E = process.env.OPENCLAW_E2E_OPENSHELL === "1";
const OPENCLAW_OPENSHELL_E2E_TIMEOUT_MS = 12 * 60_000;
const OPENCLAW_OPENSHELL_COMMAND =
  process.env.OPENCLAW_E2E_OPENSHELL_COMMAND?.trim() || "openshell";
const OPENCLAW_OPENSHELL_CONFIG_HOME =
  process.env.OPENCLAW_E2E_OPENSHELL_CONFIG_HOME?.trim() || null;
const OPENCLAW_OPENSHELL_HOST_IP = process.env.OPENCLAW_E2E_OPENSHELL_HOST_IP;

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

type HostPolicyServer = {
  port: number;
  close(): Promise<void>;
};

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

function parseActiveLocalOpenShellGateway(stdout: string): string | null {
  let gateways: unknown;
  try {
    gateways = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(gateways)) {
    return null;
  }
  for (const gateway of gateways) {
    if (
      typeof gateway !== "object" ||
      gateway === null ||
      gateway.active !== true ||
      typeof gateway.name !== "string" ||
      typeof gateway.endpoint !== "string"
    ) {
      continue;
    }
    if (
      /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/u.test(gateway.endpoint)
    ) {
      return gateway.name;
    }
  }
  return null;
}

async function activeOpenShellGateway(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    const result = await runCommand({
      command,
      args: ["gateway", "list", "--output", "json"],
      env,
      allowFailure: true,
      timeoutMs: 20_000,
    });
    if (result.code !== 0) {
      return null;
    }
    const gateway = parseActiveLocalOpenShellGateway(result.stdout);
    if (!gateway) {
      return null;
    }
    const status = await runCommand({
      command,
      args: ["--gateway", gateway, "sandbox", "list"],
      env,
      allowFailure: true,
      timeoutMs: 20_000,
    });
    return status.code === 0 ? gateway : null;
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

describe("OpenShell gateway discovery", () => {
  it("selects the active local gateway from structured output", () => {
    expect(
      parseActiveLocalOpenShellGateway(
        JSON.stringify([
          {
            name: "remote",
            endpoint: "https://gateway.example.com",
            active: false,
          },
          {
            name: "openshell",
            endpoint: "https://127.0.0.1:17670",
            active: true,
          },
        ]),
      ),
    ).toBe("openshell");
  });

  it.each([
    ["malformed output", "not json"],
    [
      "active remote gateway",
      JSON.stringify([
        {
          name: "remote",
          endpoint: "https://gateway.example.com",
          active: true,
        },
      ]),
    ],
  ])("rejects %s", (_name, output) => {
    expect(parseActiveLocalOpenShellGateway(output)).toBeNull();
  });
});

describe("openshell sandbox backend e2e", () => {
  it
    .runIf(process.platform !== "win32" && OPENCLAW_OPENSHELL_E2E)
    .each(["mirror", "remote"] as const)(
    "runs remote and mirrored sandboxes in a non-default OpenShell workspace with %s stress",
    { timeout: OPENCLAW_OPENSHELL_E2E_TIMEOUT_MS },
    async (stressMode) => {
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
      const gatewayName = await activeOpenShellGateway(OPENCLAW_OPENSHELL_COMMAND, {
        ...process.env,
        XDG_CONFIG_HOME: openshellConfigHome,
      });
      if (!gatewayName) {
        throw new Error("OpenShell E2E requires an active local registered gateway");
      }

      // macOS sockaddr_un cannot hold the test runner's nested temporary path, and the
      // mirror socket under this root would exceed it.
      const rootDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "oc-osh-e2e-"));
      const env = openshellEnv(rootDir);
      const previousHome = process.env.HOME;
      const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
      const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
      const workspaceDir = path.join(rootDir, "workspace");
      const mirrorWorkspaceDir = path.join(rootDir, "mirror");
      const overlapWorkspaceDir = path.join(rootDir, "overlap-primary");
      const overlapAgentWorkspaceDir = path.join(rootDir, "overlap-agent");
      const dockerfileDir = path.join(rootDir, "custom-image");
      const dockerfilePath = path.join(dockerfileDir, "Dockerfile");
      const denyPolicyPath = path.join(rootDir, "deny-policy.yaml");
      const allowPolicyPath = path.join(rootDir, "allow-policy.yaml");
      const scopeSuffix = `${process.pid}-${Date.now()}`;
      const scopeKey = `session:openshell-e2e-deny:${scopeSuffix}`;
      const testRunId = `${process.pid.toString(36)}${Date.now().toString(36)}`;
      const openShellWorkspace = `oc-w-${testRunId.slice(-14)}`;
      let hostPolicyServer: HostPolicyServer | null | undefined;
      let mirrorSocketServer: net.Server | undefined;
      let workspaceCreated = false;
      const sandboxCfg = {
        mode: "all" as const,
        backend: "openshell" as const,
        scope: "session" as const,
        workspaceAccess: "rw" as const,
        workspaceRoot: path.join(rootDir, "sandboxes"),
        dockerTmpfsSource: "configured" as const,
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
        workspace: openShellWorkspace,
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
      const mirrorPluginConfig = resolveOpenShellPluginConfig({
        command: OPENCLAW_OPENSHELL_COMMAND,
        gateway: gatewayName,
        workspace: openShellWorkspace,
        from: dockerfilePath,
        autoProviders: false,
        policy: denyPolicyPath,
        remoteWorkspaceDir: "/sandbox/project",
        remoteAgentWorkspaceDir: "/sandbox/agent",
      });
      const mirrorBackend = await createOpenShellSandboxBackendFactory({
        pluginConfig: mirrorPluginConfig,
      })({
        sessionKey: `session:openshell-e2e-mirror:${scopeSuffix}`,
        scopeKey: `session:openshell-e2e-mirror:${scopeSuffix}`,
        workspaceDir: mirrorWorkspaceDir,
        agentWorkspaceDir: mirrorWorkspaceDir,
        cfg: sandboxCfg,
      });
      const overlapBackend = await createOpenShellSandboxBackendFactory({
        pluginConfig: resolveOpenShellPluginConfig({
          command: OPENCLAW_OPENSHELL_COMMAND,
          gateway: gatewayName,
          workspace: openShellWorkspace,
          from: dockerfilePath,
          autoProviders: false,
          policy: denyPolicyPath,
          remoteWorkspaceDir: "/sandbox/agent/project",
          remoteAgentWorkspaceDir: "/sandbox/agent",
        }),
      })({
        sessionKey: `session:openshell-e2e-overlap:${scopeSuffix}`,
        scopeKey: `session:openshell-e2e-overlap:${scopeSuffix}`,
        workspaceDir: overlapWorkspaceDir,
        agentWorkspaceDir: overlapAgentWorkspaceDir,
        cfg: { ...sandboxCfg, workspaceAccess: "ro" },
      });
      const allowBackend = await createOpenShellSandboxBackendFactory({
        pluginConfig: { ...pluginConfig, policy: allowPolicyPath },
      })({
        sessionKey: `session:openshell-e2e-allow:${scopeSuffix}`,
        scopeKey: `session:openshell-e2e-allow:${scopeSuffix}`,
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg: sandboxCfg,
      });

      const failures: unknown[] = [];
      try {
        process.env.HOME = env.HOME;
        process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
        process.env.XDG_CACHE_HOME = env.XDG_CACHE_HOME;
        hostPolicyServer = await startHostPolicyServer();
        if (!hostPolicyServer) {
          throw new Error("failed to start host policy server");
        }
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(mirrorWorkspaceDir, { recursive: true });
        await fs.mkdir(overlapWorkspaceDir, { recursive: true });
        await fs.mkdir(overlapAgentWorkspaceDir, { recursive: true });
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
        await runCommand({
          command: OPENCLAW_OPENSHELL_COMMAND,
          args: ["workspace", "create", "--name", openShellWorkspace],
          env,
          timeoutMs: 30_000,
        });
        workspaceCreated = true;
        await fs.writeFile(path.join(workspaceDir, "seed.txt"), "seed-from-local\n", "utf8");
        await fs.writeFile(
          path.join(mirrorWorkspaceDir, "mirror-seed.txt"),
          "mirror-from-local\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(overlapWorkspaceDir, "primary-only.txt"),
          "primary-preserved\n",
        );
        await fs.writeFile(
          path.join(overlapAgentWorkspaceDir, "agent-only.txt"),
          "agent-preserved\n",
        );
        for (const protectedDirectory of [".git", "hooks", "git-hooks"]) {
          const protectedPath = path.join(mirrorWorkspaceDir, protectedDirectory);
          await fs.mkdir(protectedPath, { recursive: true });
          await fs.writeFile(path.join(protectedPath, "host-only.txt"), "private\n", "utf8");
        }
        const hostLinkTarget = path.join(rootDir, "host-link-target.txt");
        await fs.writeFile(hostLinkTarget, "host-only-link-target\n");
        const hostLinks = [
          "host-link",
          "links/nested/link",
          "links/removed/link",
          "links/conflict/link",
        ];
        for (const relativePath of hostLinks) {
          const linkPath = path.join(mirrorWorkspaceDir, relativePath);
          await fs.mkdir(path.dirname(linkPath), { recursive: true });
          await fs.symlink(hostLinkTarget, linkPath);
        }
        await fs.link(hostLinkTarget, path.join(mirrorWorkspaceDir, "links", "hardlinked.txt"));
        const mirrorFifoPath = path.join(mirrorWorkspaceDir, "host.fifo");
        const mirrorSocketPath = path.join(mirrorWorkspaceDir, "host.sock");
        const mkfifoResult = await runCommand({
          command: "mkfifo",
          args: [mirrorFifoPath],
          timeoutMs: 10_000,
        });
        expect(mkfifoResult.code).toBe(0);
        const socketServer = net.createServer();
        mirrorSocketServer = socketServer;
        socketServer.listen(mirrorSocketPath);
        await new Promise<void>((resolve, reject) => {
          socketServer.once("listening", resolve);
          socketServer.once("error", reject);
        });
        await fs.writeFile(dockerfilePath, CUSTOM_IMAGE_DOCKERFILE, "utf8");
        await fs.writeFile(
          denyPolicyPath,
          buildOpenShellPolicyYaml({
            port: hostPolicyServer.port,
            binaryPath: "/usr/bin/false",
            hostIp: OPENCLAW_OPENSHELL_HOST_IP,
          }),
          "utf8",
        );
        await fs.writeFile(
          allowPolicyPath,
          buildOpenShellPolicyYaml({
            port: hostPolicyServer.port,
            binaryPath: "/usr/bin/curl",
            hostIp: OPENCLAW_OPENSHELL_HOST_IP,
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

        const manager = createOpenShellSandboxBackendManager({ pluginConfig });
        const registryEntry = {
          containerName: backend.runtimeId,
          backendId: "openshell",
          runtimeLabel: backend.runtimeLabel,
          sessionKey: scopeKey,
          createdAtMs: Date.now(),
          lastUsedAtMs: Date.now(),
          image: pluginConfig.from,
          configLabelKind: "Source",
        };
        await expect(
          manager.describeRuntime({ entry: registryEntry, config: {} }),
        ).resolves.toMatchObject({
          running: true,
          configLabelMatch: true,
        });

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
          args: ["--workspace", openShellWorkspace, "sandbox", "ssh-config", backend.runtimeId],
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

        const mirrorExecResult = await runBackendExec({
          backend: mirrorBackend,
          command:
            "pwd && cat mirror-seed.txt && test ! -e .git && test ! -e hooks && test ! -e git-hooks",
          timeoutMs: 2 * 60_000,
        });
        expect(mirrorExecResult.stdout).toContain("/sandbox/project");
        expect(mirrorExecResult.stdout).toContain("mirror-from-local");
        expect((await fs.lstat(mirrorFifoPath)).isFIFO()).toBe(true);
        expect((await fs.lstat(mirrorSocketPath)).isSocket()).toBe(true);
        if (stressMode === "mirror") {
          await expect(
            runBackendExec({
              backend: overlapBackend,
              command:
                "cat primary-only.txt ../agent-only.txt && printf 'agent-remote\\n' > ../agent-only.txt",
              timeoutMs: 2 * 60_000,
            }),
          ).resolves.toMatchObject({
            code: 0,
            stdout: "primary-preserved\nagent-preserved\n",
          });
          await expect(
            fs.readFile(path.join(overlapAgentWorkspaceDir, "agent-only.txt"), "utf8"),
          ).resolves.toBe("agent-preserved\n");
        }
        for (const relativePath of hostLinks) {
          await expect(fs.readlink(path.join(mirrorWorkspaceDir, relativePath))).resolves.toBe(
            hostLinkTarget,
          );
        }
        await runBackendExec({
          backend: mirrorBackend,
          command:
            "test ! -e host-link && test ! -L host-link && test ! -e links/nested/link && test ! -L links/nested/link && rm -rf links/removed links/conflict && printf remote-file > links/conflict && printf remote-write > links/hardlinked.txt && ln -s /etc/passwd links/remote-link",
          timeoutMs: 60_000,
        });
        for (const relativePath of hostLinks) {
          await expect(fs.readlink(path.join(mirrorWorkspaceDir, relativePath))).resolves.toBe(
            hostLinkTarget,
          );
        }
        await expect(fs.readFile(hostLinkTarget, "utf8")).resolves.toBe("host-only-link-target\n");
        await expect(
          fs.readFile(path.join(mirrorWorkspaceDir, "links", "hardlinked.txt"), "utf8"),
        ).resolves.toBe("remote-write");
        await expect(
          fs.lstat(path.join(mirrorWorkspaceDir, "links", "remote-link")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
        for (const protectedDirectory of [".git", "hooks", "git-hooks"]) {
          await expect(
            fs.readFile(path.join(mirrorWorkspaceDir, protectedDirectory, "host-only.txt"), "utf8"),
          ).resolves.toBe("private\n");
        }

        const mirrorSandbox = createSandboxTestContext({
          overrides: {
            backendId: "openshell",
            workspaceDir: mirrorWorkspaceDir,
            agentWorkspaceDir: mirrorWorkspaceDir,
            runtimeId: mirrorBackend.runtimeId,
            runtimeLabel: mirrorBackend.runtimeLabel,
            containerName: mirrorBackend.runtimeId,
            containerWorkdir: mirrorBackend.workdir,
            backend: mirrorBackend,
          },
        });
        const mirrorBridge = mirrorBackend.createFsBridge?.({ sandbox: mirrorSandbox });
        if (!mirrorBridge) {
          throw new Error("openshell mirror backend did not create a filesystem bridge");
        }
        await mirrorBridge.writeFile({
          filePath: "nested/mirror-note.txt",
          data: "mirror-write\n",
          mkdir: true,
        });
        await expect(
          fs.readFile(path.join(mirrorWorkspaceDir, "nested", "mirror-note.txt"), "utf8"),
        ).resolves.toBe("mirror-write\n");
        await expect(
          runBackendExec({ backend: mirrorBackend, command: "cat nested/mirror-note.txt" }),
        ).resolves.toMatchObject({ code: 0, stdout: "mirror-write\n" });

        const allowedGetResult = await runBackendExec({
          backend: allowBackend,
          command: `curl --fail --silent --show-error --max-time 15 "http://host.openshell.internal:${hostPolicyServer.port}/policy-test"`,
          timeoutMs: 60_000,
        });
        expect(allowedGetResult.code).toBe(0);
        expect(allowedGetResult.stdout).toContain('"message":"hello-from-host"');

        const overlappingExec = await mirrorBackend.buildExecSpec({
          command: "sleep 0.2; printf 'exec-write\\n' > overlapping-exec.txt",
          env: {},
          usePty: false,
        });
        const overlappingResults = await Promise.allSettled([
          mirrorBridge.writeFile({ filePath: "overlapping-file.txt", data: "file-write\n" }),
          runPreparedBackendExec({
            backend: mirrorBackend,
            execSpec: overlappingExec,
            timeoutMs: 60_000,
          }),
        ]);
        for (const result of overlappingResults) {
          if (result.status === "rejected") {
            throw result.reason;
          }
        }
        await expect(
          fs.readFile(path.join(mirrorWorkspaceDir, "overlapping-file.txt"), "utf8"),
        ).resolves.toBe("file-write\n");
        await expect(
          runBackendExec({ backend: mirrorBackend, command: "cat overlapping-file.txt" }),
        ).resolves.toMatchObject({ code: 0, stdout: "file-write\n" });

        const mirrorTwin = await createOpenShellSandboxBackendFactory({
          pluginConfig: mirrorPluginConfig,
        })({
          sessionKey: `session:openshell-e2e-mirror:${scopeSuffix}`,
          scopeKey: `session:openshell-e2e-mirror:${scopeSuffix}`,
          workspaceDir: mirrorWorkspaceDir,
          agentWorkspaceDir: mirrorWorkspaceDir,
          cfg: sandboxCfg,
        });
        const remoteTwin = await backendFactory({
          sessionKey: scopeKey,
          scopeKey,
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          cfg: sandboxCfg,
        });
        if (stressMode === "remote") {
          await verifyRemoteExecOverlap({ backend, twin: remoteTwin, bridge });
        }
        await stressBackend(
          stressMode === "mirror"
            ? {
                backends: [mirrorBackend, mirrorTwin],
                bridge: mirrorBridge,
                mode: "mirror",
                workspaceDir: mirrorWorkspaceDir,
              }
            : {
                backends: [backend, remoteTwin],
                bridge,
                mode: "remote",
                workspaceDir,
              },
        );

        for (const [candidate, candidateBridge] of [
          [mirrorBackend, mirrorBridge],
          [backend, bridge],
        ] as const) {
          await expect(
            runBackendExec({ backend: candidate, command: "exit 23", timeoutMs: 60_000 }),
          ).rejects.toThrow("exit: 23");
          await candidateBridge.writeFile({ filePath: "after-failed-exec.txt", data: "recovered" });
          await expect(
            runBackendExec({ backend: candidate, command: "cat after-failed-exec.txt" }),
          ).resolves.toMatchObject({ code: 0, stdout: "recovered" });
          await expect(
            candidate.buildExecSpec({
              command: "true",
              env: { "INVALID-NAME": "fixture" },
              usePty: false,
            }),
          ).rejects.toThrow("Invalid SSH sandbox environment variable name");
          await expect(
            candidate.validateWorkdir?.(`${candidate.workdir}/missing-directory`),
          ).resolves.toBeNull();
          await expect(candidate.validateWorkdir?.(candidate.workdir)).resolves.toBe(
            candidate.workdir,
          );
          const unspawned = await candidate.buildExecSpec({
            command: "exit 99",
            env: {},
            usePty: false,
          });
          await candidate.finalizeExec?.({
            status: "failed",
            exitCode: 1,
            timedOut: false,
            token: unspawned.finalizeToken,
          });
          const sshConfigPath = unspawned.argv[unspawned.argv.indexOf("-F") + 1];
          expect(sshConfigPath).toBeTruthy();
          await expect(fs.stat(sshConfigPath!)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(
            runBackendExec({
              backend: candidate,
              command:
                "test -z \"$(find /tmp -maxdepth 1 -name 'openclaw-sandbox-exec-*' -print)\" && printf recovered",
            }),
          ).resolves.toMatchObject({ code: 0, stdout: "recovered" });
        }

        const held = await mirrorBackend.buildExecSpec({ command: "true", env: {}, usePty: false });
        try {
          await expect(
            runBackendExec({ backend, command: "printf independent", timeoutMs: 60_000 }),
          ).resolves.toMatchObject({ code: 0, stdout: "independent" });
        } finally {
          await mirrorBackend.finalizeExec?.({
            status: "failed",
            exitCode: 1,
            timedOut: false,
            token: held.finalizeToken,
          });
        }
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          if (workspaceCreated) {
            await cleanupOpenShellWorkspace({
              command: OPENCLAW_OPENSHELL_COMMAND,
              env,
              workspace: openShellWorkspace,
              sandboxNames: [
                backend.runtimeId,
                mirrorBackend.runtimeId,
                overlapBackend.runtimeId,
                allowBackend.runtimeId,
              ],
            });
          }
        } catch (error) {
          failures.push(error);
        } finally {
          try {
            const socketServer = mirrorSocketServer;
            if (socketServer) {
              await new Promise<void>((resolve, reject) => {
                socketServer.close((error) => (error ? reject(error) : resolve()));
              });
            }
          } catch (error) {
            failures.push(error);
          }
          try {
            await hostPolicyServer?.close();
          } catch (error) {
            failures.push(error);
          }
          try {
            await fs.rm(rootDir, { recursive: true, force: true });
          } catch (error) {
            failures.push(error);
          } finally {
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
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "OpenShell E2E or cleanup failed");
      }
    },
  );
});
