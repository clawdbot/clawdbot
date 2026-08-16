import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { resolveNodeWorkerInstallation } from "../../node-host/node-worker-build.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import {
  createWorkerBundleProducer,
  resolveWorkerNpmInstallationArtifact,
  type WorkerInstallationArtifact,
} from "./bundle.js";
import { workerWorkspaceRsyncReceiverEntryPath } from "./workspace-sync-helpers.js";

type WorkerBundleArtifact = Extract<WorkerInstallationArtifact, { install: "bundle" }>;

async function writeFixture(
  packageRoot: string,
  workerSource = "export const worker = true;\n",
): Promise<void> {
  await fs.mkdir(path.join(packageRoot, "dist", "worker"), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "openclaw",
      version: "1.2.3",
      type: "module",
      dependencies: { json5: "2.2.3" },
      scripts: { postinstall: "node scripts/postinstall.mjs" },
    })}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(packageRoot, "dist", "worker", "worker.mjs"), workerSource, {
    encoding: "utf8",
    mode: 0o755,
  });
  await fs.writeFile(
    path.join(packageRoot, "dist", "worker", "workspace-rsync-receiver.mjs"),
    "export const receiver = true;\n",
    { encoding: "utf8", mode: 0o755 },
  );
}

async function listTarball(tarballPath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.list({
    file: tarballPath,
    onReadEntry(entry) {
      entries.push(entry.path);
    },
  });
  return entries;
}

function bundleArtifact(overrides: Partial<WorkerBundleArtifact> = {}): WorkerBundleArtifact {
  return {
    install: "bundle",
    bundleHash: "a".repeat(64),
    openclawVersion: "1.2.3",
    protocolFeatures: [],
    tarballBytes: 1,
    tarballSha256: "b".repeat(64),
    tarballPath: "/tmp/openclaw-worker.tgz",
    ...overrides,
  };
}

describe("worker bundle producer", () => {
  it("stages the workspace rsync receiver at the path used by transfers", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-receiver-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      await writeFixture(packageRoot);
      const artifact = await createWorkerBundleProducer({
        packageRoot,
        cacheDir: path.join(root, "cache"),
      }).prepare();
      const installPrefix = `.openclaw-worker/${artifact.bundleHash}/`;
      const receiverPath = workerWorkspaceRsyncReceiverEntryPath(artifact.bundleHash);

      expect(receiverPath.startsWith(installPrefix)).toBe(true);
      await expect(listTarball(artifact.tarballPath)).resolves.toContain(
        receiverPath.slice(installPrefix.length),
      );
    });
  });

  it("hashes and archives only the dedicated deploy artifacts", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-" }, async (root) => {
      const packageA = path.join(root, "package-a");
      const packageB = path.join(root, "package-b");
      await writeFixture(packageA);
      await writeFixture(packageB);
      await fs.mkdir(path.join(packageA, "dist", "control-ui"), { recursive: true });
      await fs.writeFile(path.join(packageA, "dist", "entry.js"), 'import "json5";\n');
      await fs.writeFile(
        path.join(packageA, "dist", "control-ui", "index.html"),
        "<main>UI</main>",
      );
      await fs.utimes(
        path.join(packageA, "dist", "worker", "worker.mjs"),
        new Date(1_000),
        new Date(1_000),
      );
      await fs.utimes(
        path.join(packageB, "dist", "worker", "worker.mjs"),
        new Date(9_000),
        new Date(9_000),
      );

      const first = await createWorkerBundleProducer({
        packageRoot: packageA,
        cacheDir: path.join(root, "cache-a"),
        openclawVersion: "1.2.3",
      }).prepare();
      const second = await createWorkerBundleProducer({
        packageRoot: packageB,
        cacheDir: path.join(root, "cache-b"),
        openclawVersion: "1.2.3",
      }).prepare();
      const nodeBuild = (
        await resolveNodeWorkerInstallation({
          packageRoot: packageA,
          openclawVersion: "1.2.3",
          protocolFeatures: [],
        })
      ).build;

      expect(first.bundleHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(second.bundleHash).toBe(first.bundleHash);
      expect(nodeBuild).toEqual({
        bundleHash: first.bundleHash,
        openclawVersion: first.openclawVersion,
        protocolFeatures: first.protocolFeatures,
      });
      await expect(listTarball(first.tarballPath)).resolves.toEqual([
        "worker.mjs",
        "workspace-rsync-receiver.mjs",
      ]);
      const extractRoot = path.join(root, "extract");
      await fs.mkdir(extractRoot);
      await tar.extract({ file: first.tarballPath, cwd: extractRoot });
      await expect(fs.readFile(path.join(extractRoot, "worker.mjs"), "utf8")).resolves.toContain(
        "worker = true",
      );
      await expect(
        fs.readFile(path.join(extractRoot, "workspace-rsync-receiver.mjs"), "utf8"),
      ).resolves.toContain("receiver = true");
      await expect(fs.access(path.join(extractRoot, "package.json"))).rejects.toThrow();
      await expect(fs.access(path.join(extractRoot, "node_modules"))).rejects.toThrow();
    });
  });

  it("changes identity only when the deploy artifact changes", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-change-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      const cacheDir = path.join(root, "cache");
      await writeFixture(packageRoot, "export const value = 1;\n");
      const first = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();

      await fs.writeFile(
        path.join(packageRoot, "dist", "entry.js"),
        "export const unrelated = 2;\n",
      );
      const unrelated = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();
      expect(unrelated.bundleHash).toBe(first.bundleHash);

      await fs.writeFile(
        path.join(packageRoot, "dist", "worker", "worker.mjs"),
        "export const value = 2;\n",
      );
      const changed = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();
      expect(changed.bundleHash).not.toBe(first.bundleHash);

      await fs.writeFile(
        path.join(packageRoot, "dist", "worker", "workspace-rsync-receiver.mjs"),
        "export const receiver = false;\n",
      );
      const receiverChanged = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();
      expect(receiverChanged.bundleHash).not.toBe(changed.bundleHash);
    });
  });

  it("prunes only unretained bundles for an exclusive cache owner", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-prune-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      const cacheDir = path.join(root, "cache");
      await writeFixture(packageRoot, "export const value = 1;\n");
      const retained = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();
      await fs.writeFile(
        path.join(packageRoot, "dist", "worker", "worker.mjs"),
        "export const value = 2;\n",
      );
      const owner = createWorkerBundleProducer({
        packageRoot,
        cacheDir,
        cacheOwnership: "exclusive",
      });
      const current = await owner.prepare();
      const removedPath = path.join(cacheDir, `${"c".repeat(64)}.tgz`);
      await fs.writeFile(removedPath, "historical");

      await owner.prune([retained.bundleHash]);

      await expect(fs.stat(retained.tarballPath)).resolves.toBeDefined();
      await expect(fs.stat(current.tarballPath)).resolves.toBeDefined();
      await expect(fs.stat(removedPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("reclaims recognized crash artifacts but preserves unknown cache entries", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-crash-cleanup-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      const cacheDir = path.join(root, "cache");
      await writeFixture(packageRoot);
      const owner = createWorkerBundleProducer({
        packageRoot,
        cacheDir,
        cacheOwnership: "exclusive",
      });
      const current = await owner.prepare();
      const staging = path.join(cacheDir, ".staging-stale");
      const temporary = path.join(
        cacheDir,
        `${"b".repeat(64)}.tgz.123.123e4567-e89b-12d3-a456-426614174000.tmp`,
      );
      const unknown = path.join(cacheDir, "keep-me.txt");
      await fs.mkdir(staging);
      await fs.writeFile(temporary, "partial");
      await fs.writeFile(unknown, "operator-owned");

      await owner.prune([]);

      await expect(fs.stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(unknown, "utf8")).resolves.toBe("operator-owned");
      await expect(fs.stat(current.tarballPath)).resolves.toBeDefined();
    });
  });

  it("keeps custom caches non-destructive after failed preparation", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-shared-cache-" }, async (root) => {
      const cacheDir = path.join(root, "cache");
      await fs.mkdir(cacheDir);
      const historical = path.join(cacheDir, `${"c".repeat(64)}.tgz`);
      await fs.writeFile(historical, "historical");
      const shared = createWorkerBundleProducer({
        packageRoot: path.join(root, "missing-package"),
        cacheDir,
      });

      await expect(shared.prepare()).rejects.toThrow("worker deploy artifact is missing");
      await shared.prune([]);
      await expect(fs.readFile(historical, "utf8")).resolves.toBe("historical");
    });
  });

  it("archives staged bytes when the source changes during packaging", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-mutation-" }, async (root) => {
      const baselineRoot = path.join(root, "baseline");
      const packageRoot = path.join(root, "package");
      const originalContents = "export const value = 'before';\n";
      const changedContents = "export const value = 'after';\n";
      await writeFixture(baselineRoot, originalContents);
      await writeFixture(packageRoot, originalContents);
      const baseline = await createWorkerBundleProducer({
        packageRoot: baselineRoot,
        cacheDir: path.join(root, "baseline-cache"),
      }).prepare();
      const originalChmod = fs.chmod.bind(fs);
      let sourceMutated = false;
      const chmodSpy = vi.spyOn(fs, "chmod").mockImplementation(async (filePath, mode) => {
        await originalChmod(filePath, mode);
        if (!sourceMutated && String(filePath).endsWith(`${path.sep}worker.mjs`)) {
          sourceMutated = true;
          await fs.writeFile(
            path.join(packageRoot, "dist", "worker", "worker.mjs"),
            changedContents,
          );
        }
      });

      try {
        const artifact = await createWorkerBundleProducer({
          packageRoot,
          cacheDir: path.join(root, "cache"),
        }).prepare();
        const extractDir = path.join(root, "extract");
        await fs.mkdir(extractDir);
        await tar.extract({ file: artifact.tarballPath, cwd: extractDir });

        expect(sourceMutated).toBe(true);
        expect(artifact.bundleHash).toBe(baseline.bundleHash);
        await expect(fs.readFile(path.join(extractDir, "worker.mjs"), "utf8")).resolves.toBe(
          originalContents,
        );
      } finally {
        chmodSpy.mockRestore();
      }
    });
  });

  it("owns one immutable build snapshot and retries failed preparation", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-cache-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      const producer = createWorkerBundleProducer({
        packageRoot,
        cacheDir: path.join(root, "cache"),
        protocolFeatures: ["resume", "admission", "resume"],
      });
      const failed = producer.prepare();
      await expect(failed).rejects.toThrow("worker deploy artifact is missing");
      await writeFixture(packageRoot);

      const retried = producer.prepare();
      expect(retried).not.toBe(failed);
      const first = await retried;
      await fs.writeFile(path.join(packageRoot, "dist", "worker", "worker.mjs"), "changed\n");
      await expect(producer.prepare()).resolves.toBe(first);
      expect(first.protocolFeatures).toEqual(["admission", "resume"]);
    });
  });

  it("replaces a corrupt content-addressed cache entry", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-corrupt-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      const cacheDir = path.join(root, "cache");
      await writeFixture(packageRoot);
      const first = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();
      await fs.writeFile(first.tarballPath, "not a tarball");

      const repaired = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();

      expect(repaired.bundleHash).toBe(first.bundleHash);
      await expect(listTarball(repaired.tarballPath)).resolves.toEqual([
        "worker.mjs",
        "workspace-rsync-receiver.mjs",
      ]);
    });
  });

  it.skipIf(process.platform === "win32")("rejects symlinked deploy artifacts", async () => {
    for (const artifactName of ["worker.mjs", "workspace-rsync-receiver.mjs"]) {
      await withTestDir({ prefix: "openclaw-worker-bundle-symlink-" }, async (root) => {
        const packageRoot = path.join(root, "package");
        await writeFixture(packageRoot);
        const artifactPath = path.join(packageRoot, "dist", "worker", artifactName);
        await fs.rename(artifactPath, `${artifactPath}.target`);
        await fs.symlink(`${artifactName}.target`, artifactPath);

        await expect(
          createWorkerBundleProducer({
            packageRoot,
            cacheDir: path.join(root, "cache"),
          }).prepare(),
        ).rejects.toThrow("Unsafe worker deploy artifact");
      });
    }
  });
});

describe("worker npm installation artifact", () => {
  it("uses an exact registry-proven gateway package", async () => {
    await withTestDir({ prefix: "openclaw-worker-npm-release-" }, async (packageRoot) => {
      await writeFixture(packageRoot);
      const packageIntegrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
      const verifyRelease = vi.fn(async () => packageIntegrity);

      const artifact = await resolveWorkerNpmInstallationArtifact({
        bundle: bundleArtifact({ protocolFeatures: ["admission"] }),
        packageRoot,
        verifyRelease,
      });

      expect(verifyRelease).toHaveBeenCalledWith({
        bundleHash: "a".repeat(64),
        version: "1.2.3",
      });
      expect(artifact).toEqual({
        install: "npm",
        bundleHash: "a".repeat(64),
        openclawVersion: "1.2.3",
        packageIntegrity,
        protocolFeatures: ["admission"],
        packageSpec: "openclaw@1.2.3",
      });
    });
  });

  it("rejects dev and packages that fail release verification", async () => {
    const verifyRelease = vi.fn(async (): Promise<string> => {
      throw new Error("OpenClaw 1.2.3 is not published; use the worker bundle install");
    });
    await expect(
      resolveWorkerNpmInstallationArtifact({
        bundle: bundleArtifact({ openclawVersion: "dev" }),
        isPackageInstall: async () => true,
        verifyRelease,
      }),
    ).rejects.toThrow("exact published gateway version");
    expect(verifyRelease).not.toHaveBeenCalled();
    await expect(
      resolveWorkerNpmInstallationArtifact({
        bundle: bundleArtifact(),
        isPackageInstall: async () => true,
        verifyRelease,
      }),
    ).rejects.toThrow("use the worker bundle install");
  });

  it("rejects a source checkout even when its version is published", async () => {
    await withTestDir({ prefix: "openclaw-worker-npm-source-" }, async (packageRoot) => {
      await writeFixture(packageRoot);
      await fs.mkdir(path.join(packageRoot, ".git"));
      const verifyRelease = vi.fn(async () => `sha512-${Buffer.alloc(64).toString("base64")}`);

      await expect(
        resolveWorkerNpmInstallationArtifact({
          bundle: bundleArtifact(),
          packageRoot,
          verifyRelease,
        }),
      ).rejects.toThrow("packaged release install");
      expect(verifyRelease).not.toHaveBeenCalled();
    });
  });
});
