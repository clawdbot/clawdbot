import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  isSupportedOpenClawNodeVersion,
  PROCESS_NODE_VERSION_CHECK,
} from "../../../node-version.mjs";
import { NODE_RELEASE_VERSION_CASES } from "../../../test/helpers/node-version-cases.js";
import type { WorkerSshEndpoint } from "../../plugins/types.js";
import { runCommandWithTimeout, type SpawnResult } from "../../process/exec.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { bootstrapWorker as bootstrapWorkerCore } from "./bootstrap.js";
import { createWorkerBundleProducer, type WorkerInstallationArtifact } from "./bundle.js";

type WorkerBootstrapRequest = Parameters<typeof bootstrapWorkerCore>[0];
type WorkerBootstrapDependencies = Parameters<typeof bootstrapWorkerCore>[1];
type WorkerBootstrapCommandRunner = NonNullable<WorkerBootstrapDependencies["runCommand"]>;

const BUNDLE_HASH = "a".repeat(64);
const TARBALL_SHA256 = "b".repeat(64);
const VERSION = "2026.7.11";
const NPM_INTEGRITY = `sha512-${Buffer.alloc(64).toString("base64")}`;
const OUTPUT_TAG = "OPENCLAW_WORKER_BOOTSTRAP_V1";
const OPERATION_ID = "provision-operation-1";
const OPERATION_TOKEN = createHash("sha256").update(OPERATION_ID).digest("hex");
const UPLOAD_FILENAME = `openclaw-upload-${BUNDLE_HASH}.tgz.${OPERATION_TOKEN}`;
const REMOTE_TARBALL = `/home/worker/.openclaw-worker/.incoming/${UPLOAD_FILENAME}`;
const HOST_KEY = ["ssh-ed25519", "AAAA"].join(" ");
const RECEIPT_JSON = JSON.stringify({
  bundleHash: BUNDLE_HASH,
  openclawVersion: VERSION,
  protocolFeatures: ["admission-v1"],
});

const SSH: WorkerSshEndpoint = {
  host: "worker.example.com",
  port: 2222,
  user: "worker",
  hostKey: HOST_KEY,
  keyRef: { source: "file", provider: "worker-keys", id: "/development-key" },
};

const BUNDLE: WorkerInstallationArtifact = {
  install: "bundle",
  bundleHash: BUNDLE_HASH,
  openclawVersion: VERSION,
  protocolFeatures: ["admission-v1"],
  tarballBytes: 1,
  tarballSha256: TARBALL_SHA256,
  tarballPath: "/gateway/cache/worker.tgz",
};

function tagged(action: "current" | "install" | "receipt", payload: string): string {
  return `${OUTPUT_TAG}\t${action}\t${payload}\n`;
}

function result(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

function fakeRunner(
  responses: SpawnResult[],
  inspectCall?: (
    argv: string[],
    options: Parameters<WorkerBootstrapCommandRunner>[1],
  ) => void | Promise<void>,
) {
  const calls: Array<{
    argv: string[];
    options: Parameters<WorkerBootstrapCommandRunner>[1];
  }> = [];
  const runCommand: WorkerBootstrapCommandRunner = async (argv, options) => {
    calls.push({ argv, options });
    await inspectCall?.(argv, options);
    const response = responses.shift();
    if (!response) {
      throw new Error("unexpected bootstrap command");
    }
    return response;
  };
  return { calls, runCommand };
}

function commandPort(argv: string[]): number {
  const portFlag = argv[0] === "scp" ? "-P" : "-p";
  return Number(argv[argv.indexOf(portFlag) + 1]);
}

const resolveIdentity = async () => ({ kind: "path", path: "/keys/worker" }) as const;
const bootstrapWorker = (
  request: Omit<WorkerBootstrapRequest, "operationId"> & { operationId?: string },
  dependencies: WorkerBootstrapDependencies,
) =>
  bootstrapWorkerCore(
    { operationId: OPERATION_ID, pinnedHostKey: request.ssh.hostKey, ...request },
    dependencies,
  );

describe("bootstrapWorker", () => {
  it("skips a matching installed bundle and uses the pinned host key", async () => {
    let knownHosts = "";
    const runner = fakeRunner(
      [result({ stdout: `shell banner\n${tagged("current", RECEIPT_JSON)}login footer\n` })],
      async (argv) => {
        const option = argv.find((value) => value.startsWith("UserKnownHostsFile="));
        if (!option) {
          throw new Error("missing known-hosts option");
        }
        knownHosts = await fs.readFile(option.slice("UserKnownHostsFile=".length), "utf8");
      },
    );

    await expect(
      bootstrapWorker(
        {
          ssh: SSH,
          artifact: BUNDLE,
        },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).resolves.toEqual({
      bundleHash: BUNDLE_HASH,
      openclawVersion: VERSION,
      protocolFeatures: ["admission-v1"],
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.argv[0]).toBe("ssh");
    expect(runner.calls[0]?.argv).toContain("StrictHostKeyChecking=yes");
    expect(runner.calls[0]?.options.input).toContain("actual.openclawVersion");
    expect(runner.calls[0]?.options.input).toContain("openclaw-worker-bundle-v1");
    expect(runner.calls[0]?.options.input).not.toContain("$root/current");
    expect(knownHosts).toBe(`[worker.example.com]:2222 ${HOST_KEY}\n`);
  });

  it("fails before resolving identity or opening SSH when the host-key pin is missing", async () => {
    const runner = fakeRunner([]);
    let identityResolutionCount = 0;

    await expect(
      bootstrapWorkerCore(
        { ssh: SSH, artifact: BUNDLE, operationId: OPERATION_ID },
        {
          resolveIdentity: async () => {
            identityResolutionCount += 1;
            return { kind: "path", path: "/keys/worker" };
          },
          runCommand: runner.runCommand,
        },
      ),
    ).rejects.toThrow("WorkerProvider.provision() must return ssh.hostKey");

    expect(identityResolutionCount).toBe(0);
    expect(runner.calls).toHaveLength(0);
  });

  it("transfers and installs a fresh bundle despite terminal cleanup failure", async () => {
    const runner = fakeRunner([
      result({ stdout: tagged("install", REMOTE_TARBALL) }),
      result(),
      result({ stdout: tagged("receipt", RECEIPT_JSON) }),
      result({ code: 1, stderr: "synthetic cleanup failure" }),
    ]);

    await expect(
      bootstrapWorker(
        { ssh: SSH, artifact: BUNDLE },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).resolves.toEqual({
      bundleHash: BUNDLE_HASH,
      openclawVersion: VERSION,
      protocolFeatures: ["admission-v1"],
    });

    expect(runner.calls.map((call) => call.argv[0])).toEqual(["ssh", "scp", "ssh", "ssh"]);
    expect(runner.calls[0]?.argv).toContain("StrictHostKeyChecking=yes");
    expect(runner.calls.flatMap((call) => call.argv)).not.toContain("StrictHostKeyChecking=no");
    expect(runner.calls[1]?.argv).toContain(BUNDLE.tarballPath);
    expect(runner.calls[1]?.argv).toContain(`worker@worker.example.com:${REMOTE_TARBALL}`);
    expect(runner.calls.flatMap((call) => call.argv).join(" ")).not.toContain(OPERATION_ID);
    expect(runner.calls[0]?.argv.at(-1)).toContain(OPERATION_TOKEN);
    expect(runner.calls[2]?.options.input).toContain("bootstrap-receipt.json");
    expect(runner.calls[2]?.options.input).toContain("lock=$lock_root/$hash");
    expect(runner.calls[2]?.options.input).toContain('ln -s "$lock_identity" "$lock"');
    expect(runner.calls[2]?.options.input).toContain("worker bundle archive digest mismatch");
    expect(runner.calls[2]?.options.input).toContain(
      'const artifactPaths = ["github-exec-launcher.mjs","worker.mjs","workspace-rsync-receiver.mjs"]',
    );
    expect(runner.calls[2]?.options.input).not.toContain('npm install --prefix "$staging"');
    expect(runner.calls[2]?.options.input).toContain("worker install content does not match");
    expect(runner.calls[2]?.options.input).toContain(
      'mv "$staging" "$install_dir"\nfinish_with_receipt',
    );
    expect(runner.calls[2]?.options.input).toMatch(
      /finish_with_receipt\(\) \{[\s\S]*?rm -f -- "\$upload"\s+printf [^\n]+ receipt/u,
    );
    expect(runner.calls[2]?.options.input).toMatch(
      /if receipt_matches; then\s+finish_with_receipt/u,
    );
    expect(runner.calls[2]?.argv.at(-1)).toContain(BUNDLE_HASH);
    expect(runner.calls[2]?.argv.at(-1)).toContain(TARBALL_SHA256);
    expect(runner.calls[2]?.argv.at(-1)).toContain(VERSION);
  });

  it.each([
    { name: "keeps the floor for a small bundle", tarballBytes: 1, transferTimeoutMs: 600_000 },
    {
      name: "scales the transfer timeout for a large bundle",
      tarballBytes: 243_000_000,
      transferTimeoutMs: 1_944_000,
    },
    {
      name: "caps the transfer timeout for an absurdly large bundle",
      tarballBytes: Number.MAX_SAFE_INTEGER,
      transferTimeoutMs: 3_600_000,
    },
  ])(
    "$name while other phases keep the base timeout",
    async ({ tarballBytes, transferTimeoutMs }) => {
      const baseTimeoutMs = 600_000;
      const runner = fakeRunner([
        result({ stdout: tagged("install", REMOTE_TARBALL) }),
        result(),
        result({ stdout: tagged("receipt", RECEIPT_JSON) }),
        result(),
      ]);

      await expect(
        bootstrapWorker(
          { ssh: SSH, artifact: { ...BUNDLE, tarballBytes } },
          { resolveIdentity, runCommand: runner.runCommand, timeoutMs: baseTimeoutMs },
        ),
      ).resolves.toEqual(JSON.parse(RECEIPT_JSON));

      const [preflight, transfer, install] = runner.calls;
      expect(preflight?.options.timeoutMs).toBeLessThanOrEqual(baseTimeoutMs);
      expect(preflight?.options.timeoutMs).toBeGreaterThanOrEqual(baseTimeoutMs - 100);
      expect(transfer?.argv[0]).toBe("scp");
      expect(transfer?.options.timeoutMs).toBeLessThanOrEqual(transferTimeoutMs);
      expect(transfer?.options.timeoutMs).toBeGreaterThanOrEqual(transferTimeoutMs - 100);
      expect(install?.options.timeoutMs).toBeLessThanOrEqual(baseTimeoutMs);
      expect(install?.options.timeoutMs).toBeGreaterThanOrEqual(baseTimeoutMs - 100);
    },
  );

  it.each([Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects invalid bundle tarball size %s before any remote work",
    async (tarballBytes) => {
      const runner = fakeRunner([]);
      await expect(
        bootstrapWorker(
          { ssh: SSH, artifact: { ...BUNDLE, tarballBytes } },
          { resolveIdentity, runCommand: runner.runCommand },
        ),
      ).rejects.toThrow("Worker bundle artifact has an invalid tarball size");
      expect(runner.calls).toHaveLength(0);
    },
  );

  it.each([
    `/home/worker/other/.incoming/${UPLOAD_FILENAME}`,
    `/home/worker/.openclaw-worker/other/${UPLOAD_FILENAME}`,
    `/home/worker/.openclaw-worker/.incoming/../.incoming/${UPLOAD_FILENAME}`,
    `/home/worker/./.openclaw-worker/.incoming/${UPLOAD_FILENAME}`,
    `/home//worker/.openclaw-worker/.incoming/${UPLOAD_FILENAME}`,
    `/home/worker/.openclaw-worker/.incoming/${UPLOAD_FILENAME}.other`,
  ])("rejects a noncanonical or non-owned upload path: %s", async (remotePath) => {
    const runner = fakeRunner([result({ stdout: tagged("install", remotePath) }), result()]);

    await expect(
      bootstrapWorker(
        { ssh: SSH, artifact: BUNDLE },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).rejects.toThrow("preflight returned an invalid upload path");
    expect(runner.calls).toHaveLength(2);
  });

  it("selects an authenticated fallback before transfer and install", async () => {
    const runner = fakeRunner([
      result({ code: 255, stderr: "primary transport unavailable" }),
      result({ stdout: tagged("install", REMOTE_TARBALL) }),
      result(),
      result({ stdout: tagged("receipt", RECEIPT_JSON) }),
      result(),
    ]);

    await expect(
      bootstrapWorker(
        { ssh: { ...SSH, fallbackPorts: [22] }, artifact: BUNDLE },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).resolves.toEqual(JSON.parse(RECEIPT_JSON));

    expect(runner.calls.map((call) => call.argv[0])).toEqual(["ssh", "ssh", "scp", "ssh", "ssh"]);
    expect(runner.calls.map((call) => commandPort(call.argv))).toEqual([2222, 22, 22, 22, 22]);
    expect(new Set(runner.calls.map((call) => call.argv[call.argv.indexOf("-i") + 1]))).toEqual(
      new Set(["/keys/worker"]),
    );
    expect(
      new Set(
        runner.calls.map((call) =>
          call.argv.find((value) => value.startsWith("UserKnownHostsFile=")),
        ),
      ).size,
    ).toBe(1);
  });

  it("retries bundle transfer when the selected port changes after preflight", async () => {
    const runner = fakeRunner([
      result({ stdout: tagged("install", REMOTE_TARBALL) }),
      result({ code: 255, stderr: "primary transport unavailable" }),
      result(),
      result({ stdout: tagged("receipt", RECEIPT_JSON) }),
      result(),
    ]);

    await expect(
      bootstrapWorker(
        { ssh: { ...SSH, fallbackPorts: [22] }, artifact: BUNDLE },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).resolves.toEqual(JSON.parse(RECEIPT_JSON));

    expect(runner.calls.map((call) => call.argv[0])).toEqual(["ssh", "scp", "scp", "ssh", "ssh"]);
    expect(runner.calls.map((call) => commandPort(call.argv))).toEqual([2222, 2222, 22, 22, 22]);
  });

  it("retries install when the selected port changes after bundle transfer", async () => {
    const runner = fakeRunner([
      result({ stdout: tagged("install", REMOTE_TARBALL) }),
      result(),
      result({ code: 255, stderr: "primary transport unavailable" }),
      result({ stdout: tagged("receipt", RECEIPT_JSON) }),
      result(),
    ]);

    await expect(
      bootstrapWorker(
        { ssh: { ...SSH, fallbackPorts: [22] }, artifact: BUNDLE },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).resolves.toEqual(JSON.parse(RECEIPT_JSON));

    expect(runner.calls.map((call) => call.argv[0])).toEqual(["ssh", "scp", "ssh", "ssh", "ssh"]);
    expect(runner.calls.map((call) => commandPort(call.argv))).toEqual([2222, 2222, 2222, 22, 22]);
  });

  it("fails with provider setup guidance when Node.js is missing", async () => {
    const runner = fakeRunner([
      result({
        code: 42,
        stderr: "OPENCLAW_WORKER_NODE_MISSING\n",
      }),
      result(),
    ]);

    await expect(
      bootstrapWorker(
        { ssh: SSH, artifact: BUNDLE },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).rejects.toThrow("install Node in the provider setup phase");
    expect(runner.calls).toHaveLength(2);
  });

  it("fails with provider setup guidance when Node.js is unsupported", async () => {
    const runner = fakeRunner([
      result({
        code: 45,
        stderr: "OPENCLAW_WORKER_NODE_UNSUPPORTED: v24.14.1\n",
      }),
      result(),
    ]);

    await expect(
      bootstrapWorker(
        { ssh: SSH, artifact: BUNDLE },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).rejects.toThrow("Node 22.22.3+, 24.15.0+, or 25.9.0+ with WAL-reset-safe SQLite");
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.options.input).toContain(
      `const nodeSafe = ${PROCESS_NODE_VERSION_CHECK};`,
    );
    expect(runner.calls[0]?.options.input).toContain("SELECT sqlite_version() AS version");
  });

  it("embeds a shell-safe Node release check matching the canonical contract", () => {
    expect(PROCESS_NODE_VERSION_CHECK).not.toContain("'");
    for (const version of NODE_RELEASE_VERSION_CASES) {
      const actual = runInNewContext(PROCESS_NODE_VERSION_CHECK, {
        process: { versions: { node: version } },
      });
      expect(actual, version).toBe(isSupportedOpenClawNodeVersion(version));
    }
  });

  it("installs only the exact npm package without transferring a tarball", async () => {
    const artifact: WorkerInstallationArtifact = {
      install: "npm",
      bundleHash: BUNDLE_HASH,
      openclawVersion: VERSION,
      protocolFeatures: [],
      packageIntegrity: NPM_INTEGRITY,
      packageSpec: `openclaw@${VERSION}`,
    };
    const npmReceipt = JSON.stringify({
      bundleHash: BUNDLE_HASH,
      openclawVersion: VERSION,
      protocolFeatures: [],
    });
    const npmRunner = fakeRunner([
      result({ stdout: tagged("install", REMOTE_TARBALL) }),
      result({ stdout: tagged("receipt", npmReceipt) }),
      result(),
    ]);

    await bootstrapWorker(
      { ssh: SSH, artifact },
      { resolveIdentity, runCommand: npmRunner.runCommand },
    );

    expect(npmRunner.calls.map((call) => call.argv[0])).toEqual(["ssh", "ssh", "ssh"]);
    expect(npmRunner.calls[1]?.options.input).toContain("npm pack");
    expect(npmRunner.calls[1]?.options.input).not.toContain("npm install");
    expect(npmRunner.calls[1]?.options.input).toContain("--registry=https://registry.npmjs.org/");
    expect(npmRunner.calls[1]?.options.input).toContain("package/dist/worker/worker.mjs");
    expect(npmRunner.calls[1]?.options.input).toContain(
      "package/dist/worker/github-exec-launcher.mjs",
    );
    expect(npmRunner.calls[1]?.options.input).toContain(
      "package/dist/worker/workspace-rsync-receiver.mjs",
    );
    expect(npmRunner.calls[1]?.options.input).not.toContain("node_modules");
    expect(npmRunner.calls[1]?.argv.at(-1)).toContain(`openclaw@${VERSION}`);
  });

  it("rejects a non-exact npm package before opening SSH", async () => {
    const runner = fakeRunner([]);
    const artifact: WorkerInstallationArtifact = {
      install: "npm",
      bundleHash: BUNDLE_HASH,
      openclawVersion: VERSION,
      protocolFeatures: [],
      packageIntegrity: NPM_INTEGRITY,
      packageSpec: "openclaw@latest",
    };

    await expect(
      bootstrapWorker({ ssh: SSH, artifact }, { resolveIdentity, runCommand: runner.runCommand }),
    ).rejects.toThrow(`exact package openclaw@${VERSION}`);
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects latest even when the npm package and version strings match", async () => {
    const runner = fakeRunner([]);
    const artifact: WorkerInstallationArtifact = {
      install: "npm",
      bundleHash: BUNDLE_HASH,
      openclawVersion: "latest",
      protocolFeatures: [],
      packageIntegrity: NPM_INTEGRITY,
      packageSpec: "openclaw@latest",
    };

    await expect(
      bootstrapWorker({ ssh: SSH, artifact }, { resolveIdentity, runCommand: runner.runCommand }),
    ).rejects.toThrow("must use exact package");
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects an explicitly supplied empty host key instead of falling back", async () => {
    const runner = fakeRunner([]);

    await expect(
      bootstrapWorker(
        { ssh: SSH, artifact: BUNDLE, pinnedHostKey: "" },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).rejects.toThrow("OpenSSH public-key format");
    expect(runner.calls).toHaveLength(0);
  });

  it("materializes inline identity data privately and removes it after use", async () => {
    let identityPath = "";
    let identityContents = "";
    let identityMode = 0;
    const runCommand: WorkerBootstrapCommandRunner = async (argv) => {
      const identityIndex = argv.indexOf("-i");
      identityPath = argv[identityIndex + 1] ?? "";
      identityContents = await fs.readFile(identityPath, "utf8");
      identityMode = (await fs.stat(identityPath)).mode & 0o777;
      return result({ stdout: tagged("current", RECEIPT_JSON) });
    };

    await bootstrapWorker(
      { ssh: SSH, artifact: BUNDLE },
      {
        resolveIdentity: async () => ({
          kind: "material",
          contents: "fake-key-start\\nkey-data\\r\\nfake-key-end",
        }),
        runCommand,
      },
    );

    expect(identityContents).toBe("fake-key-start\nkey-data\nfake-key-end\n");
    if (process.platform !== "win32") {
      expect(identityMode).toBe(0o600);
    }
    await expect(fs.stat(identityPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a stale remote receipt instead of synthesizing the expected fields", async () => {
    const staleReceipt = JSON.stringify({
      bundleHash: BUNDLE_HASH,
      openclawVersion: "2026.7.10",
      protocolFeatures: ["admission-v1"],
    });
    const runner = fakeRunner([result({ stdout: tagged("current", staleReceipt) }), result()]);

    await expect(
      bootstrapWorker(
        { ssh: SSH, artifact: BUNDLE },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).rejects.toThrow("receipt does not match");
    expect(runner.calls).toHaveLength(2);
  });

  it.each([
    {
      phase: "bundle transfer",
      phaseCommand: "scp",
      responses: [
        result({ stdout: tagged("install", REMOTE_TARBALL) }),
        result({ code: 1, stderr: "transfer rejected" }),
        result({ code: 255, stderr: "selected port changed" }),
        result(),
      ],
      commands: ["ssh", "scp", "ssh", "ssh"],
      cleanupPorts: [2222, 22],
    },
    {
      phase: "install",
      phaseCommand: "install",
      responses: [
        result({ stdout: tagged("install", REMOTE_TARBALL) }),
        result(),
        result({ code: 1, stderr: "install rejected" }),
        result(),
      ],
      commands: ["ssh", "scp", "ssh", "ssh"],
      cleanupPorts: [2222],
    },
  ])(
    "does not retry fallback after a non-255 $phase failure and cleans up the upload",
    async ({ phase, phaseCommand, responses, commands, cleanupPorts }) => {
      const runner = fakeRunner(responses);

      await expect(
        bootstrapWorker(
          { ssh: { ...SSH, fallbackPorts: [22] }, artifact: BUNDLE },
          { resolveIdentity, runCommand: runner.runCommand },
        ),
      ).rejects.toThrow(`Worker bootstrap ${phase} failed`);

      expect(runner.calls.map((call) => call.argv[0])).toEqual(commands);
      const phaseCalls = runner.calls.filter((call) =>
        phaseCommand === "scp"
          ? call.argv[0] === "scp"
          : typeof call.options.input === "string" &&
            call.options.input.includes("receipt_json=$5"),
      );
      expect(phaseCalls).toHaveLength(1);
      expect(commandPort(phaseCalls[0]!.argv)).toBe(2222);

      const cleanupCalls = runner.calls.filter(
        (call) =>
          typeof call.options.input === "string" &&
          call.options.input.includes("operation_token=$2"),
      );
      expect(cleanupCalls.map((call) => commandPort(call.argv))).toEqual(cleanupPorts);
      expect(cleanupCalls.every((call) => call.argv.at(-1)?.includes(BUNDLE_HASH))).toBe(true);
      expect(cleanupCalls.every((call) => call.argv.at(-1)?.includes(OPERATION_TOKEN))).toBe(true);
      expect(cleanupCalls.every((call) => call.options.signal === undefined)).toBe(true);
    },
  );

  it("keeps bootstrap failure details on a valid UTF-16 boundary", async () => {
    const prefix = "e".repeat(511);
    const runner = fakeRunner([result({ code: 1, stderr: `${prefix}😀 tail` }), result()]);

    await expect(
      bootstrapWorker(
        { ssh: SSH, artifact: BUNDLE },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).rejects.toThrow(`Worker bootstrap preflight failed (exit 1): ${prefix}`);
  });

  it("rejects unpinned artifact digests before opening SSH", async () => {
    const runner = fakeRunner([]);

    await expect(
      bootstrapWorker(
        { ssh: SSH, artifact: { ...BUNDLE, tarballSha256: "invalid" } },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).rejects.toThrow("archive digest");
    expect(runner.calls).toHaveLength(0);
  });

  it.skipIf(process.platform === "win32")(
    "reuses and finally cleans the operation upload across ambiguous candidate attempts",
    async () => {
      await withTestDir({ prefix: "openclaw-worker-bootstrap-script-" }, async (root) => {
        const packageRoot = path.join(root, "package");
        const remoteHome = path.join(root, "remote-home");
        await fs.mkdir(path.join(packageRoot, "dist", "worker"), { recursive: true });
        await fs.writeFile(
          path.join(packageRoot, "package.json"),
          `${JSON.stringify({ name: "openclaw", version: VERSION, files: ["dist/"] })}\n`,
        );
        for (const artifact of [
          "github-exec-launcher.mjs",
          "worker.mjs",
          "workspace-rsync-receiver.mjs",
        ]) {
          await fs.writeFile(path.join(packageRoot, "dist/worker", artifact), "export {};\n", {
            mode: 0o755,
          });
        }
        const artifact = await createWorkerBundleProducer({
          packageRoot,
          cacheDir: path.join(root, "cache"),
          openclawVersion: VERSION,
          protocolFeatures: ["admission-v1"],
        }).prepare();
        const fakeBin = path.join(root, "fake-bin");
        await fs.mkdir(fakeBin);
        await fs.writeFile(path.join(fakeBin, "tar"), "#!/bin/sh\nexit 255\n", { mode: 0o755 });
        const receiptJson = JSON.stringify({
          bundleHash: artifact.bundleHash,
          openclawVersion: VERSION,
          protocolFeatures: ["admission-v1"],
        });
        const staleStaging = path.join(
          remoteHome,
          ".openclaw-worker",
          `.staging-${artifact.bundleHash}-99999`,
        );
        await fs.mkdir(staleStaging, { recursive: true });
        await fs.writeFile(path.join(staleStaging, "partial"), "abandoned install");
        const staleLock = path.join(remoteHome, ".openclaw-worker", ".locks", artifact.bundleHash);
        await fs.mkdir(path.dirname(staleLock), { recursive: true });
        // A reused live PID must not keep a crashed install locked forever.
        await fs.symlink(`${process.pid}:1`, staleLock);
        let remoteTarball = "";
        let transfers = 0;
        let syntheticPreflightFailures = 2;
        let installAttempts = 0;
        let uploadSurvivedAmbiguousInstall = false;
        let cleanupAttempts = 0;
        const preflightPaths: string[] = [];
        const runCommand: WorkerBootstrapCommandRunner = async (argv, options) => {
          if (argv[0] === "scp") {
            transfers += 1;
            const destination = argv.at(-1) ?? "";
            remoteTarball = destination.slice(destination.indexOf(":") + 1);
            await fs.copyFile(artifact.tarballPath, remoteTarball);
            return result();
          }
          const isPreflight =
            typeof options.input === "string" && options.input.includes("expected_receipt=$2");
          const isInstall =
            typeof options.input === "string" && options.input.includes("receipt_json=$5");
          const isCleanup =
            typeof options.input === "string" && options.input.includes("operation_token=$2");
          if (isCleanup) {
            cleanupAttempts += 1;
          }
          const scriptArgs = isPreflight
            ? [artifact.bundleHash, receiptJson, "bundle", OPERATION_TOKEN]
            : isInstall
              ? [
                  "bundle",
                  artifact.bundleHash,
                  "",
                  "",
                  receiptJson,
                  remoteTarball,
                  artifact.tarballSha256,
                ]
              : isCleanup
                ? [artifact.bundleHash, OPERATION_TOKEN]
                : [];
          if (isInstall && installAttempts === 1) {
            uploadSurvivedAmbiguousInstall = await fs
              .stat(remoteTarball)
              .then((stats) => stats.isFile())
              .catch(() => false);
          }
          const useFailingTar = isInstall && installAttempts === 0;
          if (isInstall) {
            installAttempts += 1;
          }
          const shellResult = await runCommandWithTimeout(["sh", "-s", "--", ...scriptArgs], {
            ...options,
            baseEnv: {
              ...options.baseEnv,
              HOME: remoteHome,
              PATH: useFailingTar
                ? `${fakeBin}:${options.baseEnv?.PATH ?? ""}`
                : options.baseEnv?.PATH,
            },
          });
          if (isPreflight) {
            const taggedRecord = shellResult.stdout
              .split(/\r?\n/u)
              .find((line) => line.startsWith(`${OUTPUT_TAG}\tinstall\t`));
            if (taggedRecord) {
              preflightPaths.push(taggedRecord.slice(taggedRecord.lastIndexOf("\t") + 1));
            }
            if (syntheticPreflightFailures > 0) {
              syntheticPreflightFailures -= 1;
              return result({ code: 255, stderr: "synthetic ambiguous preflight" });
            }
          }
          return shellResult;
        };

        const bootstrapRequest = { ssh: { ...SSH, fallbackPorts: [22] }, artifact };
        await expect(
          bootstrapWorker(bootstrapRequest, { resolveIdentity, runCommand }),
        ).rejects.toThrow("Worker bootstrap preflight failed (exit 255)");
        expect(preflightPaths).toHaveLength(2);
        await expect(fs.stat(preflightPaths[0]!)).rejects.toMatchObject({ code: "ENOENT" });

        syntheticPreflightFailures = 1;
        await expect(
          bootstrapWorker(bootstrapRequest, { resolveIdentity, runCommand }),
        ).resolves.toEqual(JSON.parse(receiptJson));

        const tamperedDependency = path.join(
          remoteHome,
          ".openclaw-worker",
          artifact.bundleHash,
          "node_modules",
          "tampered.js",
        );
        await fs.mkdir(path.dirname(tamperedDependency), { recursive: true });
        await fs.writeFile(tamperedDependency, "export const trusted = false;\n");
        await expect(
          bootstrapWorker(bootstrapRequest, { resolveIdentity, runCommand }),
        ).resolves.toEqual(JSON.parse(receiptJson));
        await expect(fs.stat(tamperedDependency)).rejects.toMatchObject({ code: "ENOENT" });

        const operationUpload = preflightPaths[0]!;
        const staleUpload = path.join(
          path.dirname(operationUpload),
          `openclaw-upload-${"c".repeat(64)}.tgz.${"d".repeat(64)}`,
        );
        await fs.writeFile(operationUpload, "ambiguous prior upload");
        await fs.writeFile(staleUpload, "stale upload");
        const staleTime = new Date(Date.now() - 61 * 60_000);
        await fs.utimes(staleUpload, staleTime, staleTime);
        const cleanupAttemptsBeforeCurrent = cleanupAttempts;
        await expect(
          bootstrapWorker({ ssh: SSH, artifact }, { resolveIdentity, runCommand }),
        ).resolves.toEqual(JSON.parse(receiptJson));
        expect(cleanupAttempts).toBe(cleanupAttemptsBeforeCurrent);

        expect(transfers).toBe(2);
        expect(preflightPaths).toHaveLength(5);
        expect(new Set(preflightPaths).size).toBe(1);
        expect(path.basename(preflightPaths[0]!)).toBe(
          `openclaw-upload-${artifact.bundleHash}.tgz.${OPERATION_TOKEN}`,
        );
        expect(installAttempts).toBe(3);
        expect(uploadSurvivedAmbiguousInstall).toBe(true);
        await expect(fs.stat(remoteTarball)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(operationUpload)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(staleUpload)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(staleStaging)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.lstat(staleLock)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          fs.readFile(
            path.join(
              remoteHome,
              ".openclaw-worker",
              artifact.bundleHash,
              "bootstrap-receipt.json",
            ),
            "utf8",
          ),
        ).resolves.toBe(`${receiptJson}\n`);
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed instead of following a poisoned incoming directory",
    async () => {
      await withTestDir({ prefix: "openclaw-worker-bootstrap-path-" }, async (root) => {
        const remoteHome = path.join(root, "remote-home");
        const unrelated = path.join(root, "unrelated");
        const bootstrapRoot = path.join(remoteHome, ".openclaw-worker");
        await fs.mkdir(bootstrapRoot, { recursive: true });
        await fs.mkdir(unrelated);
        await fs.writeFile(path.join(unrelated, "sentinel"), "keep");
        await fs.symlink(unrelated, path.join(bootstrapRoot, ".incoming"));
        const runCommand: WorkerBootstrapCommandRunner = async (_argv, options) => {
          const isPreflight =
            typeof options.input === "string" && options.input.includes("expected_receipt=$2");
          const scriptArgs = isPreflight
            ? [BUNDLE_HASH, RECEIPT_JSON, "bundle", OPERATION_TOKEN]
            : [BUNDLE_HASH, OPERATION_TOKEN];
          return await runCommandWithTimeout(["sh", "-s", "--", ...scriptArgs], {
            ...options,
            baseEnv: { ...options.baseEnv, HOME: remoteHome },
          });
        };

        await expect(
          bootstrapWorker({ ssh: SSH, artifact: BUNDLE }, { resolveIdentity, runCommand }),
        ).rejects.toThrow("unsafe worker bootstrap directory");
        await expect(fs.readFile(path.join(unrelated, "sentinel"), "utf8")).resolves.toBe("keep");
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not follow a poisoned bootstrap root during terminal cleanup",
    async () => {
      await withTestDir({ prefix: "openclaw-worker-bootstrap-cleanup-root-" }, async (root) => {
        const remoteHome = path.join(root, "remote-home");
        const unrelated = path.join(root, "unrelated");
        const incoming = path.join(unrelated, ".incoming");
        const upload = path.join(incoming, UPLOAD_FILENAME);
        await fs.mkdir(remoteHome);
        await fs.mkdir(incoming, { recursive: true });
        await fs.writeFile(upload, "keep");
        await fs.symlink(unrelated, path.join(remoteHome, ".openclaw-worker"));

        const runCommand: WorkerBootstrapCommandRunner = async (_argv, options) => {
          const isPreflight =
            typeof options.input === "string" && options.input.includes("expected_receipt=$2");
          const scriptArgs = isPreflight
            ? [BUNDLE_HASH, RECEIPT_JSON, "bundle", OPERATION_TOKEN]
            : [BUNDLE_HASH, OPERATION_TOKEN];
          return await runCommandWithTimeout(["sh", "-s", "--", ...scriptArgs], {
            ...options,
            baseEnv: { ...options.baseEnv, HOME: remoteHome },
          });
        };

        await expect(
          bootstrapWorker({ ssh: SSH, artifact: BUNDLE }, { resolveIdentity, runCommand }),
        ).rejects.toThrow("unsafe worker bootstrap directory");
        await expect(fs.readFile(upload, "utf8")).resolves.toBe("keep");
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "verifies npm installs from the dedicated worker artifact",
    async () => {
      await withTestDir({ prefix: "openclaw-worker-bootstrap-npm-artifact-" }, async (root) => {
        const packageRoot = path.join(root, "package");
        const remoteHome = path.join(root, "remote-home");
        await fs.mkdir(path.join(packageRoot, "dist", "worker"), { recursive: true });
        await fs.writeFile(
          path.join(packageRoot, "package.json"),
          `${JSON.stringify({ name: "openclaw", version: VERSION, files: ["dist/"] })}\n`,
        );
        const artifacts = [
          "github-exec-launcher.mjs",
          "worker.mjs",
          "workspace-rsync-receiver.mjs",
        ];
        for (const artifact of artifacts) {
          await fs.writeFile(path.join(packageRoot, "dist/worker", artifact), "export {};\n", {
            mode: 0o755,
          });
        }
        const bundle = await createWorkerBundleProducer({
          packageRoot,
          cacheDir: path.join(root, "cache"),
          openclawVersion: VERSION,
        }).prepare();
        const artifact: WorkerInstallationArtifact = {
          install: "npm",
          bundleHash: bundle.bundleHash,
          openclawVersion: VERSION,
          protocolFeatures: [],
          packageIntegrity: NPM_INTEGRITY,
          packageSpec: `openclaw@${VERSION}`,
        };
        const receiptJson = JSON.stringify({
          bundleHash: bundle.bundleHash,
          openclawVersion: VERSION,
          protocolFeatures: [],
        });
        const installRoot = path.join(remoteHome, ".openclaw-worker", bundle.bundleHash);
        await fs.mkdir(installRoot, { recursive: true });
        for (const artifactName of artifacts) {
          await fs.copyFile(
            path.join(packageRoot, "dist", "worker", artifactName),
            path.join(installRoot, artifactName),
          );
          await fs.chmod(path.join(installRoot, artifactName), 0o700);
        }
        await fs.writeFile(path.join(installRoot, "bootstrap-receipt.json"), `${receiptJson}\n`);
        const runCommand: WorkerBootstrapCommandRunner = async (_argv, options) => {
          const isPreflight =
            typeof options.input === "string" && options.input.includes("expected_receipt=$2");
          const scriptArgs = isPreflight
            ? [bundle.bundleHash, receiptJson, "npm", OPERATION_TOKEN]
            : [bundle.bundleHash, OPERATION_TOKEN];
          return await runCommandWithTimeout(["sh", "-s", "--", ...scriptArgs], {
            ...options,
            baseEnv: { ...options.baseEnv, HOME: remoteHome },
          });
        };

        await expect(
          bootstrapWorker({ ssh: SSH, artifact }, { resolveIdentity, runCommand }),
        ).resolves.toEqual(JSON.parse(receiptJson));
      });
    },
  );
});
