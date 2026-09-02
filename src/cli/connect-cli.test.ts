// Connect CLI tests cover accepted targets and handoff to the canonical node runtime.
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import type { NodeHostConfig } from "../node-host/config.js";
import { encodePairingSetupCode } from "../pairing/setup-code.js";
import { registerConnectCli } from "./connect-cli.js";

const mocks = vi.hoisted(() => ({
  runNodeHost: vi.fn(),
  runNodeDaemonInstall: vi.fn(),
  fetchWithSsrFGuard: vi.fn(),
  loadNodeHostConfig: vi.fn<() => Promise<NodeHostConfig | null>>(async () => null),
  mutateConfigFileWithRetry: vi.fn(),
  runtime: {
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../node-host/runner.js", () => ({ runNodeHost: mocks.runNodeHost }));
vi.mock("../node-host/config.js", () => ({ loadNodeHostConfig: mocks.loadNodeHostConfig }));
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
  mutateConfigFileWithRetry: mocks.mutateConfigFileWithRetry,
}));
vi.mock("./node-cli/daemon.js", () => ({
  runNodeDaemonInstall: mocks.runNodeDaemonInstall,
}));
vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/net/fetch-guard.js")>();
  mocks.fetchWithSsrFGuard.mockImplementation(actual.fetchWithSsrFGuard);
  return { fetchWithSsrFGuard: mocks.fetchWithSsrFGuard };
});
vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.runtime }));

const payload = {
  url: "wss://192.168.1.20:8443/openclaw-gw",
  urls: ["wss://192.168.1.20:8443/openclaw-gw", "wss://gateway.tailnet.example/tailnet-gw"],
  bootstrapToken: "bootstrap-token",
  tlsFingerprint: "ab".repeat(32),
};

function setupCode(): string {
  return encodePairingSetupCode(payload);
}

async function runConnect(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined });
  registerConnectCli(program);
  await program.parseAsync(["connect", ...args], { from: "user" });
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("connect cli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runNodeHost.mockResolvedValue(undefined);
    mocks.runNodeDaemonInstall.mockResolvedValue(undefined);
    mocks.mutateConfigFileWithRetry.mockResolvedValue(undefined);
    mocks.runtime.exit.mockImplementation(() => {});
  });

  it("advertises the wrapper-required connect options", () => {
    const program = new Command();
    registerConnectCli(program);
    const help = program.commands[0]?.helpInformation() ?? "";

    expect(help).toMatch(/^[ \t]+--target-file <path>(?:[ \t]|$)/mu);
    expect(help).toMatch(/^[ \t]+--service(?:[ \t]|$)/mu);
    expect(help).toMatch(/^[ \t]+--session-host(?:[ \t]|$)/mu);
  });

  it.each([
    { name: "bare setup code", target: () => setupCode(), fetched: false },
    { name: "oc-pair wrapper", target: () => `oc-pair://${setupCode()}`, fetched: false },
    {
      name: "HTTPS join URL",
      target: () => `https://gateway.example/openclaw-gw/j/${"a".repeat(22)}`,
      fetched: true,
    },
  ])("maps a $name into the existing node foreground runtime", async ({ target, fetched }) => {
    if (fetched) {
      mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
        response: new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
        finalUrl: target(),
        release: vi.fn().mockResolvedValue(undefined),
      });
    }

    await runConnect([target(), "--display-name", "Build Node"]);

    expect(mocks.runNodeHost).toHaveBeenCalledWith({
      gatewayHost: "192.168.1.20",
      gatewayPort: 8443,
      gatewayTls: true,
      gatewayTlsFingerprint: "ab".repeat(32),
      gatewayContextPath: "/openclaw-gw",
      gatewayCandidates: [
        {
          host: "192.168.1.20",
          port: 8443,
          contextPath: "/openclaw-gw",
          tls: true,
          tlsFingerprint: "ab".repeat(32),
        },
        {
          host: "gateway.tailnet.example",
          port: 443,
          contextPath: "/tailnet-gw",
          tls: true,
        },
      ],
      gatewayBootstrapToken: "bootstrap-token",
      preferGatewayBootstrapToken: true,
      displayName: "Build Node",
    });
    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(fetched ? 1 : 0);
    if (fetched) {
      expect(mocks.fetchWithSsrFGuard.mock.calls[0]?.[0]).not.toHaveProperty("init");
    }
    expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "environment-managed node",
      flag: "--ephemeral",
      displayName: "Cloud Node",
      preferGatewayBootstrapToken: false,
    },
    {
      name: "operator-approved node",
      flag: "--session-host",
      displayName: "Build Node",
      preferGatewayBootstrapToken: true,
    },
  ])(
    "runs a $name as a process-scoped session host",
    async ({ flag, displayName, preferGatewayBootstrapToken }) => {
      await runConnect([setupCode(), flag, "--display-name", displayName]);

      expect(mocks.runNodeHost).toHaveBeenCalledWith(
        expect.objectContaining({
          gatewayBootstrapToken: "bootstrap-token",
          preferGatewayBootstrapToken,
          forceWorkerRuns: true,
          displayName,
        }),
      );
      expect(mocks.runNodeHost.mock.calls[0]?.[0].ephemeral === true).toBe(flag === "--ephemeral");
      expect(mocks.mutateConfigFileWithRetry).not.toHaveBeenCalled();
      expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
    },
  );

  it("consumes an environment-managed target file before connecting", async () => {
    const root = tempDirs.make("openclaw-connect-target-");
    const targetFile = path.join(root, "setup-code");
    await fs.writeFile(targetFile, setupCode(), { mode: 0o600 });

    await runConnect(["--target-file", targetFile, "--ephemeral"]);

    expect(mocks.runNodeHost).toHaveBeenCalledWith(
      expect.objectContaining({ forceWorkerRuns: true }),
    );
    await expect(fs.stat(targetFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a socket target without removing it",
    async () => {
      // Darwin's Unix socket path limit includes the runner's temporary root.
      const root = tempDirs.make("oc-sock-");
      const targetFile = path.join(root, "target.sock");
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(targetFile, resolve);
      });
      try {
        await runConnect(["--target-file", targetFile, "--ephemeral"]);

        expect(mocks.runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("path must be a regular file"),
        );
        expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
        expect(mocks.runNodeHost).not.toHaveBeenCalled();
        const stat = await fs.lstat(targetFile);
        expect(stat.isSocket()).toBe(true);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it.each([
    {
      name: "empty",
      contents: Buffer.alloc(0),
      message: "Connect target file is empty.",
    },
    {
      name: "oversized",
      contents: Buffer.alloc(64 * 1024 + 1, 0x61),
      message: "max 65536 bytes",
    },
  ])("rejects an $name target file without removing it", async ({ contents, message }) => {
    const root = tempDirs.make("openclaw-connect-target-invalid-");
    const targetFile = path.join(root, "setup-code");
    await fs.writeFile(targetFile, contents, { mode: 0o600 });

    await runConnect(["--target-file", targetFile, "--ephemeral"]);

    expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runNodeHost).not.toHaveBeenCalled();
    await expect(fs.readFile(targetFile)).resolves.toEqual(contents);
  });

  it.skipIf(process.platform === "win32")(
    "consumes a symlinked target file and keeps the backing file intact",
    async () => {
      const root = tempDirs.make("openclaw-connect-target-symlink-");
      const targetFile = path.join(root, "setup-code");
      const backingFile = path.join(root, "backing-setup-code");
      await fs.writeFile(backingFile, setupCode(), { mode: 0o600 });
      await fs.symlink(backingFile, targetFile);
      await runConnect(["--target-file", targetFile, "--ephemeral"]);

      expect(mocks.runNodeHost).toHaveBeenCalledWith(
        expect.objectContaining({ forceWorkerRuns: true }),
      );
      await expect(fs.stat(targetFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(backingFile)).resolves.toBeDefined();
    },
  );

  it.each([
    {
      args: ["--ephemeral", "--service"],
      message: "--ephemeral cannot be combined with --service.",
    },
    {
      args: ["--ephemeral", "--session-host"],
      message: "--ephemeral cannot be combined with --session-host.",
    },
  ])("rejects incompatible flags: $args", async ({ args, message }) => {
    await runConnect([setupCode(), ...args]);

    expect(mocks.runtime.error).toHaveBeenCalledWith(message);
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runNodeHost).not.toHaveBeenCalled();
    expect(mocks.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
  });

  it("keeps the existing service path non-hosting", async () => {
    await runConnect([setupCode(), "--service", "--display-name", "Service Node"]);

    expect(mocks.runNodeHost).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayBootstrapToken: "bootstrap-token",
        stopAfterFirstConnect: true,
      }),
    );
    expect(mocks.runNodeHost.mock.calls[0]?.[0]).not.toHaveProperty("forceWorkerRuns");
    expect(mocks.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    expect(mocks.runNodeDaemonInstall).toHaveBeenCalledWith({
      displayName: "Service Node",
      force: true,
    });
  });

  it.each([false, true])(
    "forwards repeatable command restrictions through connect (service=%s)",
    async (service) => {
      await runConnect([
        setupCode(),
        ...(service ? ["--service"] : []),
        "--commands",
        "fixture.read,fixture.list",
        "--commands",
        "fixture.read",
      ]);
      const commands = ["fixture.list", "fixture.read"];
      expect(mocks.runNodeHost).toHaveBeenCalledWith(expect.objectContaining({ commands }));
      if (service) {
        expect(mocks.runNodeDaemonInstall).toHaveBeenCalledWith(
          expect.objectContaining({ commands, force: true }),
        );
      } else {
        expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    "forwards --all-commands through connect (service=%s)",
    async (service) => {
      await runConnect([setupCode(), "--all-commands", ...(service ? ["--service"] : [])]);
      expect(mocks.runNodeHost).toHaveBeenCalledWith(
        expect.objectContaining({ allCommands: true }),
      );
      if (service) {
        expect(mocks.runNodeDaemonInstall).toHaveBeenCalledWith(
          expect.objectContaining({ allCommands: true, force: true }),
        );
      } else {
        expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects --all-commands with --commands before consuming the join target", async () => {
    await expect(
      runConnect([setupCode(), "--all-commands", "--commands", "fixture.read"]),
    ).rejects.toThrow(/--all-commands.*--commands/);
    expect(mocks.loadNodeHostConfig).not.toHaveBeenCalled();
    expect(mocks.runNodeHost).not.toHaveBeenCalled();
    expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
  });

  it("authenticates before persisting hosting consent and installing the service", async () => {
    await runConnect([setupCode(), "--service", "--session-host", "--display-name", "Runner Node"]);

    expect(mocks.runNodeHost).toHaveBeenCalledWith(
      expect.objectContaining({
        stopAfterFirstConnect: true,
      }),
    );
    expect(mocks.runNodeHost.mock.calls[0]?.[0]).not.toHaveProperty("forceWorkerRuns");
    expect(mocks.mutateConfigFileWithRetry).toHaveBeenCalledWith({
      writeOptions: {
        auditOrigin: "cli",
        explicitSetPaths: [["nodeHost", "workerRuns", "enabled"]],
      },
      mutate: expect.any(Function),
    });
    const mutation = mocks.mutateConfigFileWithRetry.mock.calls[0]?.[0] as {
      mutate: (draft: OpenClawConfig) => void;
    };
    const draft: OpenClawConfig = {
      gateway: { port: 28443 },
      nodeHost: { skills: { enabled: false }, workerRuns: { enabled: false } },
    };
    mutation.mutate(draft);
    expect(draft).toEqual({
      gateway: { port: 28443 },
      nodeHost: { skills: { enabled: false }, workerRuns: { enabled: true } },
    });
    expect(mocks.runNodeDaemonInstall).toHaveBeenCalledWith({
      displayName: "Runner Node",
      force: true,
    });
    expect(mocks.runNodeHost.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.mutateConfigFileWithRetry.mock.invocationCallOrder[0]!,
    );
    expect(mocks.mutateConfigFileWithRetry.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runNodeDaemonInstall.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    { stage: "bootstrap connection", error: "bootstrap failed", mutationCalls: 0 },
    { stage: "durable consent write", error: "config write failed", mutationCalls: 1 },
  ])("does not install the service when the $stage fails", async ({ error, mutationCalls }) => {
    if (mutationCalls === 0) {
      mocks.runNodeHost.mockRejectedValueOnce(new Error(error));
    } else {
      mocks.mutateConfigFileWithRetry.mockRejectedValueOnce(new Error(error));
    }

    await runConnect([setupCode(), "--service", "--session-host"]);

    expect(mocks.runNodeHost).toHaveBeenCalledWith(
      expect.objectContaining({ stopAfterFirstConnect: true }),
    );
    expect(mocks.runNodeHost.mock.calls[0]?.[0]).not.toHaveProperty("forceWorkerRuns");
    expect(mocks.mutateConfigFileWithRetry).toHaveBeenCalledTimes(mutationCalls);
    expect(mocks.runtime.error).toHaveBeenCalledWith(error);
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
  });

  it("refuses plain HTTP join URLs for non-loopback gateways", async () => {
    await runConnect([`http://gateway.example/j/${"a".repeat(22)}`]);

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "Plain HTTP join URLs are allowed only for loopback gateways.",
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(mocks.runNodeHost).not.toHaveBeenCalled();
  });

  it("sends Cloudflare Access credentials on the pinned HTTPS join request", async () => {
    const clientId = ["cf", "client", "id"].join("-");
    const clientSecret = ["cf", "client", "secret"].join("-");
    mocks.loadNodeHostConfig.mockResolvedValueOnce({
      version: 1,
      nodeId: "node-test",
      gateway: {
        host: "gateway.example",
        port: 443,
        tls: true,
        cloudflareAccess: { clientId, clientSecret },
      },
    });
    const target = `https://gateway.example/j/${"a".repeat(22)}`;
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      finalUrl: target,
      release: vi.fn(async () => undefined),
    });

    await runConnect([target]);

    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRedirects: 0,
        init: {
          headers: {
            "CF-Access-Client-Id": clientId,
            "CF-Access-Client-Secret": clientSecret,
          },
        },
      }),
    );
  });

  it("rejects Cloudflare Access credentials before a plaintext join request", async () => {
    const clientSecret = ["cf", "plaintext", "secret"].join("-");
    mocks.loadNodeHostConfig.mockResolvedValueOnce({
      version: 1,
      nodeId: "node-test",
      gateway: {
        host: "127.0.0.1",
        port: 80,
        tls: false,
        cloudflareAccess: { clientId: "cf-plaintext-id", clientSecret },
      },
    });

    await runConnect([`http://127.0.0.1/j/${"a".repeat(22)}`]);

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "Cloudflare Access credentials require an HTTPS join URL.",
    );
    expect(String(mocks.runtime.error.mock.calls[0]?.[0])).not.toContain(clientSecret);
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(mocks.runNodeHost).not.toHaveBeenCalled();
  });
});
