// Real SSH transport and Gateway pairing policy proof; only the remote identity command is synthetic.
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { GatewayNodePairingConfig } from "../../../../src/config/types.gateway.js";
import type { GatewayClient } from "../../../../src/gateway/client.js";
import {
  loadOrCreateDeviceIdentity,
  type DeviceIdentity,
} from "../../../../src/infra/device-identity.js";
import {
  connectHotReloadClient,
  waitForHotReloadFact,
  type HotReloadConnection,
} from "./gateway-config-hot-reload-fixtures.js";

const execFile = promisify(execFileCallback);
type PairingList = {
  pending: Array<{ deviceId: string }>;
  paired: Array<{ deviceId: string; approvedVia?: string }>;
};

async function runSystem(command: string, args: string[], privileged = false) {
  const useSudo = privileged && process.getuid?.() !== 0;
  return await execFile(
    useSudo ? "/usr/bin/sudo" : command,
    useSudo ? ["-n", "--", command, ...args] : args,
    {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    },
  );
}

async function portOpen(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

export async function prepareGatewayPairingFixture(temporaryRoot: string) {
  assert.equal(
    process.env.OPENCLAW_TESTBOX,
    "1",
    "Real SSH pairing proof requires a disposable Testbox",
  );
  const address = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
  assert(address, "Real pairing proof needs a non-loopback IPv4 address");
  const root = path.join(temporaryRoot, "pairing-ssh");
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true, mode: 0o700 });
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, address, resolve);
  });
  const reserved = server.address();
  assert(reserved && typeof reserved !== "string");
  const port = reserved.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  const hostKey = path.join(root, "host-key");
  const clientKeys = [path.join(root, "client-a"), path.join(root, "client-b")] as const;
  await Promise.all(
    [hostKey, ...clientKeys].map((file) =>
      runSystem("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file]),
    ),
  );
  const authorizedKeys = path.join(root, "authorized_keys");
  await fs.writeFile(
    authorizedKeys,
    (await Promise.all(clientKeys.map((key) => fs.readFile(`${key}.pub`, "utf8")))).join(""),
    { mode: 0o600 },
  );
  const knownHosts = path.join(root, "known_hosts");
  await fs.writeFile(
    knownHosts,
    `[${address}]:${port} ${await fs.readFile(`${hostKey}.pub`, "utf8")}`,
    { mode: 0o600 },
  );
  const manifest = path.join(root, "identity-command.json");
  const identityCommand = path.join(root, "identity-command.cjs");
  await fs.writeFile(
    identityCommand,
    `
const fs = require("node:fs/promises");
const delay = require("node:timers/promises").setTimeout;
(async () => {
  if (process.env.SSH_ORIGINAL_COMMAND !== "sh -lc 'openclaw node identity --json'") throw new Error("unexpected fixture SSH command");
  const { deviceId, publicKey, started, release } = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
  await fs.writeFile(started, "started");
  const deadline = Date.now() + 30000;
  while (!(await fs.stat(release).catch(() => undefined))) {
    if (Date.now() >= deadline) throw new Error("fixture identity release timed out");
    await delay(25);
  }
  process.stdout.write(JSON.stringify({ deviceId, publicKey }) + "\\n");
})().catch(() => { process.exitCode = 1; });
`,
  );
  // Keep the production SSH argument contract intact except its fixed port and the
  // operator-owned trust files. No real account keys, agent, or known_hosts are read.
  await fs.writeFile(
    path.join(bin, "ssh"),
    `#!${process.execPath}
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const portFlag = args.indexOf("-p");
if (portFlag < 0) throw new Error("missing production SSH port");
args.splice(portFlag, 2);
const child = spawn("/usr/bin/ssh", ["-F", "/dev/null", "-p", ${JSON.stringify(String(port))}, "-o", ${JSON.stringify(`UserKnownHostsFile=${knownHosts}`)}, "-o", "GlobalKnownHostsFile=/dev/null", ...args], { stdio: "inherit" });
child.once("error", () => { process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
`,
    { mode: 0o700 },
  );
  const username = os.userInfo().username;
  const config = path.join(root, "sshd_config");
  await fs.writeFile(
    config,
    [
      `Port ${port}`,
      `ListenAddress ${address}`,
      `HostKey ${hostKey}`,
      `PidFile ${path.join(root, "sshd.pid")}`,
      `AuthorizedKeysFile ${authorizedKeys}`,
      `AllowUsers ${username}`,
      "AuthenticationMethods publickey",
      "PubkeyAuthentication yes",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PermitRootLogin prohibit-password",
      // Testbox runner accounts are password-locked; PAM permits generated-key auth.
      "UsePAM yes",
      "StrictModes no",
      "AllowTcpForwarding no",
      "X11Forwarding no",
      "PermitTunnel no",
      "PrintMotd no",
      "LogLevel ERROR",
      `ForceCommand ${process.execPath} ${identityCommand} ${manifest}`,
      "",
    ].join("\n"),
  );
  await runSystem("/bin/mkdir", ["-p", "/run/sshd"], true);
  await runSystem("/usr/sbin/sshd", ["-t", "-f", config], true);
  const useSudo = process.getuid?.() !== 0;
  const daemon = spawn(
    useSudo ? "/usr/bin/sudo" : "/usr/sbin/sshd",
    [...(useSudo ? ["-n", "--", "/usr/sbin/sshd"] : []), "-D", "-e", "-f", config],
    { detached: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  let daemonError = "";
  daemon.stderr?.on("data", (chunk) => {
    daemonError = `${daemonError}${String(chunk)}`.slice(-4000);
  });
  daemon.once("error", (error) => {
    daemonError = error.message;
  });
  const releases: string[] = [];
  let stopped = false;
  const close = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    await Promise.all(releases.map((release) => fs.writeFile(release, "release")));
    if (daemon.pid && daemon.exitCode === null && daemon.signalCode === null) {
      await runSystem("/bin/kill", ["-TERM", "--", `-${daemon.pid}`], true);
    }
    await waitForHotReloadFact("isolated sshd cleanup", async () =>
      !(await portOpen(address, port)) ? true : undefined,
    );
  };
  try {
    await waitForHotReloadFact("isolated sshd listening", async () => {
      if (daemon.exitCode !== null || daemon.signalCode !== null || daemonError) {
        throw new Error(`Isolated sshd failed: ${daemonError}`);
      }
      return (await portOpen(address, port)) ? true : undefined;
    });
  } catch (error) {
    await close();
    throw error;
  }
  const stage = async (identity: DeviceIdentity, delayed: boolean) => {
    const id = randomUUID();
    const started = path.join(root, `${id}.started`);
    const release = path.join(root, `${id}.release`);
    releases.push(release);
    await fs.writeFile(
      manifest,
      JSON.stringify({
        deviceId: identity.deviceId,
        publicKey: identity.publicKeyPem,
        started,
        release,
      }),
    );
    if (!delayed) {
      await fs.writeFile(release, "release");
    }
    return {
      waitStarted: () =>
        waitForHotReloadFact(
          "real SSH identity command",
          async () => await fs.stat(started).catch(() => undefined),
        ),
      release: () => fs.writeFile(release, "release"),
    };
  };
  try {
    const fixtureIdentity = loadOrCreateDeviceIdentity({
      path: path.join(root, "state", "openclaw.sqlite"),
      identityKey: "hot-reload-fixture",
    });
    await stage(fixtureIdentity, false);
    const fixtureProbe = await runSystem(path.join(bin, "ssh"), [
      "-p",
      "22",
      "-i",
      clientKeys[0],
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "BatchMode=yes",
      "--",
      `${username}@${address}`,
      "sh -lc 'openclaw node identity --json'",
    ]);
    assert.equal(JSON.parse(fixtureProbe.stdout).deviceId, fixtureIdentity.deviceId);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    runtimeEnvPatch: {
      // The fixture owns this PATH: normal CLI bootstrap puts /usr/bin first and
      // would bypass the real-SSH adapter's isolated trust files and high port.
      OPENCLAW_PATH_BOOTSTRAPPED: "1",
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    },
    close,
    async run(params: {
      gateway: QaGatewayChild;
      operator: GatewayClient;
      patchConfig: (change: unknown, replacePaths?: string[]) => Promise<unknown>;
      existingNode: HotReloadConnection;
    }): Promise<string> {
      const url = new URL(params.gateway.wsUrl);
      url.hostname = address;
      const gateway = { ...params.gateway, wsUrl: url.href };
      const connections: HotReloadConnection[] = [];
      const identity = () =>
        loadOrCreateDeviceIdentity({
          path: path.join(root, "state", "openclaw.sqlite"),
          identityKey: `hot-reload-${randomUUID()}`,
        });
      const patchPairing = (pairing: GatewayNodePairingConfig) =>
        params.patchConfig({ gateway: { nodes: { pairing } } }, [
          "gateway.nodes.pairing.autoApproveCidrs",
          // Replacing the SSH policy with false removes its nested CIDRs too.
          "gateway.nodes.pairing.sshVerify.cidrs",
        ]);
      const list = () => params.operator.request<PairingList>("device.pair.list", {});
      const expectPending = async (device: DeviceIdentity) => {
        const result = await list();
        assert(
          result.pending.some((row) => row.deviceId === device.deviceId),
          "Revoked automatic approval must remain visible as pending",
        );
        assert(
          !result.paired.some((row) => row.deviceId === device.deviceId),
          "Revoked automatic approval must not create a paired device",
        );
      };
      const rejected = (device: DeviceIdentity) =>
        assert.rejects(
          connectHotReloadClient(gateway, { identity: device }),
          /pairing|NOT_PAIRED/i,
        );
      const connected = async (device: DeviceIdentity) => {
        const connection = await connectHotReloadClient(gateway, { identity: device });
        connections.push(connection);
        return connection;
      };
      const policy = (key: string) => ({
        user: username,
        identity: key,
        timeoutMs: 20_000,
        cidrs: [`${address}/32`],
      });
      const waitApproved = (device: DeviceIdentity) =>
        waitForHotReloadFact("SSH pairing approval", async () =>
          (await list()).paired.find(
            (row) => row.deviceId === device.deviceId && row.approvedVia === "ssh-verified",
          ),
        );
      const waitRevoked = async (device: DeviceIdentity) => {
        await waitForHotReloadFact("authoritative SSH policy rejection", () =>
          params.gateway
            .logs()
            .includes(`approval skipped device=${device.deviceId} (approval-policy-changed)`)
            ? true
            : undefined,
        );
        await expectPending(device);
      };
      try {
        await patchPairing({
          autoApproveLocal: false,
          autoApproveCidrs: [`${address}/32`],
          sshVerify: false,
        });
        const cidrNode = identity();
        await connected(cidrNode);
        assert.equal(
          (await list()).paired.find((row) => row.deviceId === cidrNode.deviceId)?.approvedVia,
          "trusted-cidr",
        );
        await patchPairing({ autoApproveCidrs: [] });
        const deniedCidrNode = identity();
        await rejected(deniedCidrNode);
        await expectPending(deniedCidrNode);

        const disabledNode = identity();
        const disabledProbe = await stage(disabledNode, true);
        await patchPairing({ sshVerify: policy(clientKeys[0]) });
        await rejected(disabledNode);
        await disabledProbe.waitStarted();
        await patchPairing({ sshVerify: false });
        await disabledProbe.release();
        await waitRevoked(disabledNode);
        await stage(disabledNode, false);
        await patchPairing({ sshVerify: policy(clientKeys[0]) });
        await rejected(disabledNode);
        await waitApproved(disabledNode);
        await connected(disabledNode);

        const changedNode = identity();
        const oldProbe = await stage(changedNode, true);
        await rejected(changedNode);
        await oldProbe.waitStarted();
        const newProbe = await stage(changedNode, true);
        await patchPairing({ sshVerify: policy(clientKeys[1]) });
        await rejected(changedNode);
        await newProbe.waitStarted();
        await oldProbe.release();
        await waitRevoked(changedNode);
        await newProbe.release();
        await waitApproved(changedNode);
        await connected(changedNode);
        assert.equal(
          params.existingNode.closes,
          0,
          "Pairing changes disconnected a previously paired node",
        );
        await patchPairing({ autoApproveLocal: true, autoApproveCidrs: [], sshVerify: false });
        return "CIDR admission revoked on the same listener; real SSH proofs were fenced after disable and key-policy replacement, fresh retries approved, and existing paired nodes stayed connected";
      } finally {
        await Promise.allSettled(
          connections.map((connection) => connection.client.stopAndWait({ timeoutMs: 2_000 })),
        );
      }
    },
  };
}
