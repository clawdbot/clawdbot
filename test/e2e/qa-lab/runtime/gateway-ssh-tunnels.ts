// Real OpenSSH and Gateway status proof for the SSH tunnel fallback path.
import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import { gatewayStatusCommand } from "../../../../src/commands/gateway-status.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import { startGatewayServer } from "../../../../src/gateway/server.js";
import { snapshotGatewayStartupEnv } from "../../../../src/gateway/test-helpers.env.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import type { OutputRuntimeEnv } from "../../../../src/runtime.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const execFile = promisify(execFileCallback);
const SOURCE_PATH = "test/e2e/qa-lab/runtime/gateway-ssh-tunnels.ts";
const STATUS_TIMEOUT_MS = 8_000;
const PROCESS_TIMEOUT_MS = 10_000;
const TEST_TOKEN = "qa-gateway-ssh-token";
const SSH_NAMESPACE_MARKER = "OPENCLAW_QA_SSH_NAMESPACE";

type ProducerOptions = {
  artifactBase: string;
  fixtureProcessPath?: string;
  fixtureReadyPath?: string;
  fixtureRoot?: string;
  repoRoot: string;
};

type StatusWarning = {
  code?: string;
  message?: string;
};

type StatusTarget = {
  connect?: {
    ok?: boolean;
  };
  kind?: string;
  tunnel?: {
    localPort?: number;
  } | null;
};

type StatusPayload = {
  ok?: boolean;
  primaryTargetId?: string | null;
  targets?: StatusTarget[];
  warnings?: StatusWarning[];
};

type IsolatedSshd = {
  clientKeyPath: string;
  knownHostsPath: string;
  port: number;
  setKnownHost: (mode: "correct" | "wrong") => Promise<void>;
  stop: () => Promise<void>;
};

function parseOptions(argv: readonly string[]): ProducerOptions {
  let artifactBase: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-base") {
      artifactBase = argv[++index];
      continue;
    }
    if (arg === "--") {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return {
    artifactBase: path.resolve(artifactBase),
    repoRoot: process.cwd(),
  };
}

async function resolveBinary(candidates: readonly string[], label: string): Promise<string> {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Keep checking trusted system locations.
    }
  }
  throw new Error(`missing required system OpenSSH ${label}`);
}

function privilegedInvocation(command: string, args: readonly string[]) {
  if (typeof process.getuid !== "function" || process.getuid() === 0) {
    return { command, args: [...args] };
  }
  return {
    command: "/usr/bin/sudo",
    args: ["-n", "--", command, ...args],
  };
}

async function runChecked(command: string, args: readonly string[]) {
  try {
    return await execFile(command, [...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: PROCESS_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(`${command} failed: ${formatErrorMessage(error)}`, { cause: error });
  }
}

async function runPrivileged(command: string, args: readonly string[]) {
  const invocation = privilegedInvocation(command, args);
  return await runChecked(invocation.command, invocation.args);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to reserve loopback port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (connected: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

async function waitForPortState(port: number, open: boolean, timeoutMs = PROCESS_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await canConnect(port)) === open) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`localhost:${port} did not become ${open ? "reachable" : "unreachable"}`);
}

async function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function generateKey(sshKeygen: string, filePath: string) {
  await runChecked(sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-f", filePath]);
}

async function readPublicKeyLine(filePath: string) {
  const publicKey = (await fs.readFile(`${filePath}.pub`, "utf8")).trim().split(/\s+/);
  const keyType = publicKey[0];
  const key = publicKey[1];
  if (!keyType || !key) {
    throw new Error(`invalid generated public key: ${path.basename(filePath)}`);
  }
  return `${keyType} ${key}`;
}

async function startIsolatedSshd(
  root: string,
  onTrustPrepared?: () => Promise<void>,
): Promise<IsolatedSshd> {
  const sshd = await resolveBinary(
    ["/usr/sbin/sshd", "/usr/local/sbin/sshd", "/opt/homebrew/sbin/sshd"],
    "daemon (sshd)",
  );
  const sshKeygen = await resolveBinary(
    ["/usr/bin/ssh-keygen", "/usr/local/bin/ssh-keygen", "/opt/homebrew/bin/ssh-keygen"],
    "key generator (ssh-keygen)",
  );
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    await fs.access("/usr/bin/sudo");
    await runChecked("/usr/bin/sudo", ["-n", "true"]);
  }

  const port = await reserveLoopbackPort();
  const hostKeyPath = path.join(root, "host-key");
  const wrongHostKeyPath = path.join(root, "wrong-host-key");
  const clientKeyPath = path.join(root, "client-key");
  const authorizedKeysPath = path.join(root, "authorized-keys");
  const configPath = path.join(root, "sshd_config");
  const pidPath = path.join(root, "sshd.pid");
  await Promise.all([
    generateKey(sshKeygen, hostKeyPath),
    generateKey(sshKeygen, wrongHostKeyPath),
    generateKey(sshKeygen, clientKeyPath),
  ]);
  await fs.writeFile(authorizedKeysPath, `${await readPublicKeyLine(clientKeyPath)}\n`, {
    mode: 0o600,
  });
  await fs.chmod(clientKeyPath, 0o600);

  const username = os.userInfo().username;
  await fs.writeFile(
    configPath,
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${hostKeyPath}`,
      `PidFile ${pidPath}`,
      `AuthorizedKeysFile ${authorizedKeysPath}`,
      `AllowUsers ${username}`,
      "AuthenticationMethods publickey",
      "PubkeyAuthentication yes",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PermitEmptyPasswords no",
      "PermitRootLogin prohibit-password",
      // Testbox runner accounts are password-locked; PAM still permits generated-key auth.
      "UsePAM yes",
      "StrictModes no",
      "AllowTcpForwarding yes",
      "GatewayPorts no",
      "X11Forwarding no",
      "PermitTunnel no",
      "PrintMotd no",
      "LogLevel INFO",
      "",
    ].join("\n"),
    "utf8",
  );

  const knownHostsPath = path.join(root, "known_hosts");
  const targetPrefix = `[127.0.0.1]:${port} `;
  const hostKeyLine = `${targetPrefix}${await readPublicKeyLine(hostKeyPath)}`;
  const wrongHostKeyLine = `${targetPrefix}${await readPublicKeyLine(wrongHostKeyPath)}`;
  const setKnownHost = async (mode: "correct" | "wrong") => {
    const line = mode === "correct" ? hostKeyLine : wrongHostKeyLine;
    await fs.writeFile(knownHostsPath, `${line}\n`, { mode: 0o600 });
  };

  await setKnownHost("correct");
  await runPrivileged(sshd, ["-t", "-f", configPath]);
  await onTrustPrepared?.();

  const invocation = privilegedInvocation(sshd, ["-D", "-e", "-f", configPath]);
  const child = spawn(invocation.command, invocation.args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  let stopPromise: Promise<void> | undefined;
  const stop = async () => {
    stopPromise ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await waitForExit(child, 2_000);
      }
      if (await canConnect(port)) {
        const pid = (await fs.readFile(pidPath, "utf8").catch(() => "")).trim();
        if (/^[1-9]\d*$/.test(pid)) {
          await runPrivileged("/bin/kill", ["-TERM", pid]).catch(() => {});
          await waitForPortState(port, false, 2_000).catch(() => {});
        }
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child, 2_000);
      }
      if (await canConnect(port)) {
        const pid = (await fs.readFile(pidPath, "utf8").catch(() => "")).trim();
        if (/^[1-9]\d*$/.test(pid)) {
          await runPrivileged("/bin/kill", ["-KILL", pid]).catch(() => {});
        }
      }
      await waitForPortState(port, false);
    })();
    await stopPromise;
  };

  try {
    await Promise.race([
      waitForPortState(port, true),
      new Promise<never>((_, reject) => {
        child.once("exit", (code, signal) => {
          reject(
            new Error(
              `isolated sshd exited before listening (${code ?? "null"}/${signal ?? "none"}): ${stderr.trim()}`,
            ),
          );
        });
        child.once("error", reject);
      }),
    ]);
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    clientKeyPath,
    knownHostsPath,
    port,
    setKnownHost,
    stop,
  };
}

async function runInSshNamespace(options: ProducerOptions): Promise<QaEvidenceSummaryJson> {
  if (process.platform !== "linux") {
    throw new Error("Gateway SSH tunnel QA requires a Linux Testbox mount namespace");
  }
  const ssh = await resolveBinary(["/usr/bin/ssh", "/bin/ssh"], "client (ssh)");
  const mount = await resolveBinary(["/usr/bin/mount", "/bin/mount"], "mount utility");
  const unshare = await resolveBinary(["/usr/bin/unshare", "/bin/unshare"], "unshare utility");
  const namespaceDir = path.join(options.artifactBase, ".ssh-namespace");
  const realSshPath = path.join(namespaceDir, "system-ssh");
  const wrapperPath = path.join(namespaceDir, "ssh");
  await fs.mkdir(namespaceDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(realSshPath, "", { mode: 0o700 });
  await fs.writeFile(
    wrapperPath,
    [
      "#!/bin/sh",
      ': "${OPENCLAW_QA_REAL_SSH:?missing system SSH path}"',
      ': "${OPENCLAW_QA_SSH_KNOWN_HOSTS:?missing isolated known-hosts path}"',
      'exec "$OPENCLAW_QA_REAL_SSH" -F /dev/null -o "UserKnownHostsFile=$OPENCLAW_QA_SSH_KNOWN_HOSTS" -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no "$@"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );

  const childSource = `
import { pathToFileURL } from "node:url";
const modulePath = process.env.OPENCLAW_QA_PRODUCER_PATH;
const rawOptions = process.env.OPENCLAW_QA_PRODUCER_OPTIONS;
if (!modulePath || !rawOptions) {
  throw new Error("missing namespaced producer configuration");
}
const { runGatewaySshTunnels } = await import(pathToFileURL(modulePath).href);
const evidence = await runGatewaySshTunnels(JSON.parse(rawOptions));
process.exitCode = evidence.entries[0]?.result.status === "pass" ? 0 : 1;
`;
  const shellScript = `
set -eu
${mount} --bind "$1" "$2"
${mount} --bind "$3" "$1"
export ${SSH_NAMESPACE_MARKER}=1
export OPENCLAW_TESTBOX=1
export OPENCLAW_QA_REAL_SSH="$2"
export OPENCLAW_QA_PRODUCER_PATH="$4"
export OPENCLAW_QA_PRODUCER_OPTIONS="$5"
shift 5
exec "$@"
`;
  const invocation = privilegedInvocation(unshare, [
    "--mount",
    "--propagation",
    "private",
    "/bin/sh",
    "-c",
    shellScript,
    "openclaw-qa-ssh-namespace",
    ssh,
    realSshPath,
    wrapperPath,
    path.join(options.repoRoot, SOURCE_PATH),
    JSON.stringify(options),
    process.execPath,
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    childSource,
  ]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.repoRoot,
    detached: true,
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (options.fixtureProcessPath && child.pid) {
    await fs.writeFile(options.fixtureProcessPath, `${child.pid}\n`, "utf8");
  }
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  try {
    const { code, signal } = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const evidencePath = path.join(options.artifactBase, QA_EVIDENCE_FILENAME);
    const evidence = await fs
      .readFile(evidencePath, "utf8")
      .then((value) => JSON.parse(value) as QaEvidenceSummaryJson)
      .catch(() => undefined);
    if (evidence) {
      return evidence;
    }
    throw new Error(
      `namespaced Gateway SSH tunnel producer exited ${code ?? "null"}/${signal ?? "none"}: ${stderr.trim()}`,
    );
  } finally {
    await fs.rm(namespaceDir, { force: true, recursive: true });
  }
}

function requireStatusPayload(value: unknown): StatusPayload {
  if (typeof value !== "object" || value === null) {
    throw new Error("gateway status did not emit a JSON object");
  }
  return value as StatusPayload;
}

function requireWarning(payload: StatusPayload, code: string): StatusWarning {
  const warning = payload.warnings?.find((entry) => entry.code === code);
  if (!warning) {
    throw new Error(`gateway status did not emit ${code} warning`);
  }
  return warning;
}

async function runGatewayStatus(params: {
  gatewayPort: number;
  identityPath: string;
  sshPort: number;
}) {
  let payload: unknown;
  let exitCode: number | null = null;
  const errors: string[] = [];
  const runtime: OutputRuntimeEnv = {
    log: () => {},
    error: (...args) => errors.push(args.map(String).join(" ")),
    exit: (code) => {
      exitCode = code;
    },
    writeJson: (value) => {
      payload = value;
    },
    writeStdout: () => {},
  };
  await gatewayStatusCommand(
    {
      json: true,
      port: params.gatewayPort,
      ssh: `${os.userInfo().username}@127.0.0.1:${params.sshPort}`,
      sshIdentity: params.identityPath,
      timeout: String(STATUS_TIMEOUT_MS),
      token: TEST_TOKEN,
    },
    runtime,
  );
  if (errors.length > 0) {
    throw new Error(`gateway status wrote stderr: ${errors.join("\n")}`);
  }
  return { exitCode, payload: requireStatusPayload(payload) };
}

function sanitizeDiagnostic(text: string, roots: readonly string[]) {
  let sanitized = text;
  for (const root of roots) {
    sanitized = sanitized.replaceAll(root, "<temp>");
  }
  sanitized = sanitized.replaceAll(os.userInfo().homedir, "<home>");
  return sanitized;
}

export async function runGatewaySshTunnels(
  options: ProducerOptions,
): Promise<QaEvidenceSummaryJson> {
  if (process.env.OPENCLAW_TESTBOX !== "1") {
    throw new Error("Gateway SSH tunnel QA requires OPENCLAW_TESTBOX=1 before privileged setup");
  }
  if (process.env[SSH_NAMESPACE_MARKER] !== "1") {
    return await runInSshNamespace(options);
  }
  await fs.mkdir(options.artifactBase, { recursive: true });
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "gateway-ssh-tunnels.log",
    primaryModel: "gateway/status",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: "gateway-ssh-tunnels",
      title: "Gateway SSH tunnel fallback",
      sourcePath: "qa/scenarios/runtime/gateway-ssh-tunnels.yaml",
      docsRefs: ["docs/gateway/remote.md", "docs/cli/gateway.md"],
      codeRefs: [
        SOURCE_PATH,
        "src/infra/ssh-tunnel.ts",
        "src/commands/gateway-status/probe-run.ts",
      ],
    },
  });
  const startedAt = Date.now();
  // openclaw-temp-dir: normal runs remove the fixture root; the SIGKILL test tracks its injected root
  const root =
    options.fixtureRoot ?? (await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-ssh-")));
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  const summaryPath = path.join(options.artifactBase, "gateway-ssh-tunnels-summary.json");
  let sshd: IsolatedSshd | undefined;
  let gateway: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  try {
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    const fixtureReadyPath = options.fixtureReadyPath;
    const isolatedSshd = await startIsolatedSshd(
      root,
      fixtureReadyPath
        ? async () => {
            await fs.writeFile(fixtureReadyPath, "ready\n", "utf8");
            await new Promise<void>(() => {});
          }
        : undefined,
    );
    sshd = isolatedSshd;
    const gatewayPort = await reserveLoopbackPort();
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          gateway: {
            auth: { mode: "token", token: TEST_TOKEN },
            bind: "loopback",
            mode: "local",
            port: gatewayPort,
          },
          plugins: { enabled: false },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await withEnvAsync(
      {
        ...snapshotGatewayStartupEnv(),
        HOME: homeDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_HOME: homeDir,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_QA_SSH_KNOWN_HOSTS: isolatedSshd.knownHostsPath,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      },
      async () => {
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        gateway = await startGatewayServer(gatewayPort, {
          auth: { mode: "token", token: TEST_TOKEN },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });

        const success = await runGatewayStatus({
          gatewayPort,
          identityPath: isolatedSshd.clientKeyPath,
          sshPort: isolatedSshd.port,
        });
        const successTarget = success.payload.targets?.find((entry) => entry.kind === "sshTunnel");
        if (!successTarget) {
          throw new Error(
            `gateway status did not emit sshTunnel target: ${JSON.stringify(success.payload.warnings ?? [])}`,
          );
        }
        const localPort = successTarget.tunnel?.localPort;
        if (
          success.exitCode !== null ||
          success.payload.ok !== true ||
          success.payload.primaryTargetId !== "sshTunnel" ||
          successTarget.connect?.ok !== true ||
          !Number.isInteger(localPort)
        ) {
          throw new Error("gateway status did not reach the Gateway through the SSH tunnel");
        }
        await waitForPortState(Number(localPort), false);

        await isolatedSshd.setKnownHost("wrong");
        const hostKeyFailure = await runGatewayStatus({
          gatewayPort,
          identityPath: isolatedSshd.clientKeyPath,
          sshPort: isolatedSshd.port,
        });
        const hostKeyWarning = requireWarning(hostKeyFailure.payload, "ssh_tunnel_failed");
        if (
          hostKeyFailure.payload.ok !== true ||
          !/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(
            hostKeyWarning.message ?? "",
          )
        ) {
          throw new Error("gateway status did not expose the strict host-key rejection");
        }

        await isolatedSshd.setKnownHost("correct");
        await isolatedSshd.stop();
        const unreachable = await runGatewayStatus({
          gatewayPort,
          identityPath: isolatedSshd.clientKeyPath,
          sshPort: isolatedSshd.port,
        });
        const unreachableWarning = requireWarning(unreachable.payload, "ssh_tunnel_failed");
        if (
          unreachable.payload.ok !== true ||
          !/Connection refused|connect to host|ssh exited/i.test(unreachableWarning.message ?? "")
        ) {
          throw new Error("gateway status did not expose the unreachable SSH daemon");
        }

        return {
          cleanupReleased: true,
          gatewayPort,
          hostKeyDiagnostic: sanitizeDiagnostic(hostKeyWarning.message ?? "", [
            root,
            options.repoRoot,
          ]),
          knownHostsIsolated: true,
          sshdPort: isolatedSshd.port,
          tunnelPort: localPort,
          unreachableDiagnostic: sanitizeDiagnostic(unreachableWarning.message ?? "", [
            root,
            options.repoRoot,
          ]),
        };
      },
    );

    await fs.writeFile(summaryPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    writer.appendLog(
      "pass: real SSH tunnel, isolated trust, cleanup, host-key, and unreachable diagnostics\n",
    );
    return await writer.write({
      artifacts: [{ kind: "summary", filePath: summaryPath }],
      details:
        "Reached the authenticated Gateway through real OpenSSH with scenario-owned host trust, observed tunnel cleanup, and surfaced host-key and unreachable-daemon diagnostics.",
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = sanitizeDiagnostic(formatErrorMessage(error), [root, options.repoRoot]);
    writer.appendLog(`fail: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  } finally {
    await gateway?.close({ reason: "Gateway SSH tunnel QA complete" }).catch(() => {});
    await sshd?.stop().catch(() => {});
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await fs.rm(root, { force: true, recursive: true });
  }
}

async function main(argv: readonly string[]) {
  const evidence = await runGatewaySshTunnels(parseOptions(argv));
  const status = evidence.entries[0]?.result.status;
  process.stdout.write(`Gateway SSH tunnel evidence: ${QA_EVIDENCE_FILENAME}\n`);
  process.stdout.write(`Gateway SSH tunnel status: ${status}\n`);
  return status === "pass" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`Gateway SSH tunnel producer failed: ${formatErrorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
