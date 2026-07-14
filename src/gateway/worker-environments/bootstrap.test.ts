import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkerSshEndpoint } from "../../plugins/types.js";
import { runCommandWithTimeout, type SpawnResult } from "../../process/exec.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
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
const REMOTE_TARBALL = `/home/worker/.openclaw-worker/.incoming/${BUNDLE_HASH}.tgz.ABCDEFGH`;
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

const resolveIdentity = async () => ({ kind: "path", path: "/keys/worker" }) as const;
const bootstrapWorker = (
  request: WorkerBootstrapRequest,
  dependencies: WorkerBootstrapDependencies,
) => bootstrapWorkerCore({ pinnedHostKey: request.ssh.hostKey, ...request }, dependencies);

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
        { ssh: SSH, artifact: BUNDLE },
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

  it("transfers and installs a fresh bundle with a receipt", async () => {
    const runner = fakeRunner([
      result({ stdout: tagged("install", REMOTE_TARBALL) }),
      result(),
      result({ stdout: tagged("receipt", RECEIPT_JSON) }),
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

    expect(runner.calls.map((call) => call.argv[0])).toEqual(["ssh", "scp", "ssh"]);
    expect(runner.calls[0]?.argv).toContain("StrictHostKeyChecking=yes");
    expect(runner.calls.flatMap((call) => call.argv)).not.toContain("StrictHostKeyChecking=no");
    expect(runner.calls[1]?.argv).toContain(BUNDLE.tarballPath);
    expect(runner.calls[1]?.argv).toContain(`worker@worker.example.com:${REMOTE_TARBALL}`);
    expect(runner.calls[2]?.options.input).toContain("bootstrap-receipt.json");
    expect(runner.calls[2]?.options.input).toContain("lock=$lock_root/$hash");
    expect(runner.calls[2]?.options.input).toContain('ln -s "$lock_identity" "$lock"');
    expect(runner.calls[2]?.options.input).toContain("worker bundle archive digest mismatch");
    expect(runner.calls[2]?.options.input).toContain("worker install content does not match");
    expect(runner.calls[2]?.argv.at(-1)).toContain(BUNDLE_HASH);
    expect(runner.calls[2]?.argv.at(-1)).toContain(TARBALL_SHA256);
    expect(runner.calls[2]?.argv.at(-1)).toContain(VERSION);
  });

  it("fails with provider setup guidance when Node.js is missing", async () => {
    const runner = fakeRunner([
      result({
        code: 42,
        stderr: "OPENCLAW_WORKER_NODE_MISSING\n",
      }),
    ]);

    await expect(
      bootstrapWorker(
        { ssh: SSH, artifact: BUNDLE },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).rejects.toThrow("install Node in the provider setup phase");
    expect(runner.calls).toHaveLength(1);
  });

  it("fails with provider setup guidance when Node.js is unsupported", async () => {
    const runner = fakeRunner([
      result({
        code: 45,
        stderr: "OPENCLAW_WORKER_NODE_UNSUPPORTED: v24.14.1\n",
      }),
    ]);

    await expect(
      bootstrapWorker(
        { ssh: SSH, artifact: BUNDLE },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).rejects.toThrow("Node 22.22.3+, 24.15.0+, or 25.9.0+ with WAL-reset-safe SQLite");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.options.input).toContain("process.versions.node");
    expect(runner.calls[0]?.options.input).toContain("SELECT sqlite_version() AS version");
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
    ]);

    await bootstrapWorker(
      { ssh: SSH, artifact },
      { resolveIdentity, runCommand: npmRunner.runCommand },
    );

    expect(npmRunner.calls.map((call) => call.argv[0])).toEqual(["ssh", "ssh"]);
    expect(npmRunner.calls[1]?.options.input).toContain("npm pack");
    expect(npmRunner.calls[1]?.options.input).toContain("npm install --global");
    expect(npmRunner.calls[1]?.options.input).toContain("--registry=https://registry.npmjs.org/");
    expect(npmRunner.calls[1]?.options.input).toContain(
      "OPENCLAW_DISABLE_PLUGIN_REGISTRY_MIGRATION=1",
    );
    expect(npmRunner.calls[1]?.options.input).toContain("postinstall-inventory.json");
    expect(npmRunner.calls[1]?.options.input).toContain("lib/node_modules/openclaw");
    expect(npmRunner.calls[1]?.options.input).toContain('cp -R "$package_dir/." "$staging/"');
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
    const runner = fakeRunner([result({ stdout: tagged("current", staleReceipt) })]);

    await expect(
      bootstrapWorker(
        { ssh: SSH, artifact: BUNDLE },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).rejects.toThrow("receipt does not match");
    expect(runner.calls).toHaveLength(1);
  });

  it("removes a partial remote upload after transfer failure", async () => {
    const runner = fakeRunner([
      result({ stdout: tagged("install", REMOTE_TARBALL) }),
      result({ code: 1, stderr: "connection reset" }),
      result(),
    ]);

    await expect(
      bootstrapWorker(
        { ssh: SSH, artifact: BUNDLE },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).rejects.toThrow("bundle transfer failed");

    expect(runner.calls.map((call) => call.argv[0])).toEqual(["ssh", "scp", "ssh"]);
    expect(runner.calls[2]?.options.input).toContain('rm -f -- "$1"');
    expect(runner.calls[2]?.argv.at(-1)).toContain(REMOTE_TARBALL);
    expect(runner.calls[2]?.options.signal).toBeUndefined();
  });

  it("keeps bootstrap failure details on a valid UTF-16 boundary", async () => {
    const prefix = "e".repeat(511);
    const runner = fakeRunner([result({ code: 1, stderr: `${prefix}😀 tail` })]);

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
    "verifies the transferred archive and installed manifest before a receipt",
    async () => {
      await withTempDir({ prefix: "openclaw-worker-bootstrap-script-" }, async (root) => {
        const packageRoot = path.join(root, "package");
        const remoteHome = path.join(root, "remote-home");
        await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
        await fs.writeFile(
          path.join(packageRoot, "package.json"),
          `${JSON.stringify({ name: "openclaw", version: VERSION, files: ["dist/"] })}\n`,
        );
        await fs.writeFile(path.join(packageRoot, "openclaw.mjs"), "import './dist/entry.js';\n", {
          mode: 0o755,
        });
        await fs.writeFile(path.join(packageRoot, "dist/entry.js"), "export {};\n");
        const artifact = await createWorkerBundleProducer({
          packageRoot,
          cacheDir: path.join(root, "cache"),
          openclawVersion: VERSION,
          protocolFeatures: ["admission-v1"],
        }).prepare();
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
          const scriptArgs = isPreflight
            ? [artifact.bundleHash, receiptJson, "bundle"]
            : [
                "bundle",
                artifact.bundleHash,
                "",
                "",
                receiptJson,
                remoteTarball,
                artifact.tarballSha256,
              ];
          return await runCommandWithTimeout(["sh", "-s", "--", ...scriptArgs], {
            ...options,
            baseEnv: { ...options.baseEnv, HOME: remoteHome },
          });
        };

        await expect(
          bootstrapWorker({ ssh: SSH, artifact }, { resolveIdentity, runCommand }),
        ).resolves.toEqual(JSON.parse(receiptJson));
        await expect(
          bootstrapWorker({ ssh: SSH, artifact }, { resolveIdentity, runCommand }),
        ).resolves.toEqual(JSON.parse(receiptJson));

        expect(transfers).toBe(1);
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
      await withTempDir({ prefix: "openclaw-worker-bootstrap-path-" }, async (root) => {
        const remoteHome = path.join(root, "remote-home");
        const unrelated = path.join(root, "unrelated");
        const bootstrapRoot = path.join(remoteHome, ".openclaw-worker");
        await fs.mkdir(bootstrapRoot, { recursive: true });
        await fs.mkdir(unrelated);
        await fs.writeFile(path.join(unrelated, "sentinel"), "keep");
        await fs.symlink(unrelated, path.join(bootstrapRoot, ".incoming"));
        const runCommand: WorkerBootstrapCommandRunner = async (_argv, options) =>
          await runCommandWithTimeout(["sh", "-s", "--", BUNDLE_HASH, RECEIPT_JSON, "bundle"], {
            ...options,
            baseEnv: { ...options.baseEnv, HOME: remoteHome },
          });

        await expect(
          bootstrapWorker({ ssh: SSH, artifact: BUNDLE }, { resolveIdentity, runCommand }),
        ).rejects.toThrow("unsafe worker bootstrap directory");
        await expect(fs.readFile(path.join(unrelated, "sentinel"), "utf8")).resolves.toBe("keep");
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "verifies npm installs from the packaged dist inventory",
    async () => {
      await withTempDir({ prefix: "openclaw-worker-bootstrap-npm-inventory-" }, async (root) => {
        const packageRoot = path.join(root, "package");
        const remoteHome = path.join(root, "remote-home");
        await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
        await fs.writeFile(
          path.join(packageRoot, "package.json"),
          `${JSON.stringify({ name: "openclaw", version: VERSION, files: ["dist/"] })}\n`,
        );
        await fs.writeFile(path.join(packageRoot, "openclaw.mjs"), "import './dist/entry.js';\n", {
          mode: 0o755,
        });
        await fs.writeFile(path.join(packageRoot, "dist/entry.js"), "export {};\n");
        await fs.writeFile(path.join(packageRoot, "dist/entry.js.map"), "excluded map\n");
        await fs.writeFile(
          path.join(packageRoot, "dist/postinstall-inventory.json"),
          `${JSON.stringify(["dist/entry.js"])}\n`,
        );
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
        await fs.mkdir(path.dirname(installRoot), { recursive: true });
        await fs.cp(packageRoot, installRoot, { recursive: true });
        await fs.writeFile(path.join(installRoot, "bootstrap-receipt.json"), `${receiptJson}\n`);
        const runCommand: WorkerBootstrapCommandRunner = async (_argv, options) =>
          await runCommandWithTimeout(["sh", "-s", "--", bundle.bundleHash, receiptJson, "npm"], {
            ...options,
            baseEnv: { ...options.baseEnv, HOME: remoteHome },
          });

        await expect(
          bootstrapWorker({ ssh: SSH, artifact }, { resolveIdentity, runCommand }),
        ).resolves.toEqual(JSON.parse(receiptJson));
      });
    },
  );
});
