import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  createWorkerBundleProducer,
  resolveWorkerNpmInstallationArtifact,
  type WorkerInstallationArtifact,
} from "./bundle.js";

type WorkerBundleArtifact = Extract<WorkerInstallationArtifact, { install: "bundle" }>;
const fixturePackageJson = `${JSON.stringify({
  name: "openclaw",
  version: "1.2.3",
  type: "module",
  files: ["dist/"],
})}\n`;

async function writeFixture(
  packageRoot: string,
  files: readonly (readonly [relativePath: string, contents: string])[],
): Promise<void> {
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), fixturePackageJson, "utf8");
  await fs.writeFile(path.join(packageRoot, "openclaw.mjs"), "import './dist/entry.js';\n", {
    encoding: "utf8",
    mode: 0o755,
  });
  for (const [relativePath, contents] of files) {
    const filePath = path.join(packageRoot, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents, "utf8");
  }
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
    tarballSha256: "b".repeat(64),
    tarballPath: "/tmp/openclaw-worker.tgz",
    ...overrides,
  };
}

describe("worker bundle producer", () => {
  it("hashes the same file manifest deterministically", async () => {
    await withTempDir({ prefix: "openclaw-worker-bundle-" }, async (root) => {
      const packageA = path.join(root, "package-a");
      const packageB = path.join(root, "package-b");
      const files = [
        ["dist/entry.js", "export const entry = true;\n"],
        ["dist/nested/worker.js", "export const worker = true;\n"],
      ] as const;
      await writeFixture(packageA, files);
      await writeFixture(packageB, files.toReversed());
      await fs.utimes(path.join(packageA, "dist/entry.js"), new Date(1_000), new Date(1_000));
      await fs.utimes(path.join(packageB, "dist/entry.js"), new Date(9_000), new Date(9_000));

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

      expect(first.bundleHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(second.bundleHash).toBe(first.bundleHash);
      await expect(listTarball(first.tarballPath)).resolves.toEqual([
        "dist/entry.js",
        "dist/nested/worker.js",
        "openclaw.mjs",
        "package.json",
      ]);
    });
  });

  it("prunes workspace deps and lifecycle fields from dev manifests", async () => {
    await withTempDir({ prefix: "openclaw-worker-bundle-prune-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      await writeFixture(packageRoot, [["dist/entry.js", "export const entry = true;\n"]]);
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        `${JSON.stringify({
          name: "openclaw",
          version: "1.2.3",
          type: "module",
          files: ["dist/"],
          dependencies: { json5: "2.2.3", "@openclaw/gateway-protocol": "workspace:*" },
          devDependencies: { vitest: "4.0.0" },
          scripts: { prepare: "node scripts/prepare.mjs" },
          pnpm: { patchedDependencies: {} },
        })}\n`,
        "utf8",
      );

      const bundle = await createWorkerBundleProducer({
        packageRoot,
        cacheDir: path.join(root, "cache"),
        openclawVersion: "1.2.3",
      }).prepare();
      const extractRoot = path.join(root, "extract");
      await fs.mkdir(extractRoot, { recursive: true });
      await tar.extract({ file: bundle.tarballPath, cwd: extractRoot });
      const staged = JSON.parse(
        await fs.readFile(path.join(extractRoot, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(staged.dependencies).toEqual({ json5: "2.2.3" });
      expect(staged).not.toHaveProperty("devDependencies");
      expect(staged).not.toHaveProperty("scripts");
      expect(staged).not.toHaveProperty("pnpm");
    });
  });

  it("vendors workspace packages that the shipped dist imports", async () => {
    await withTempDir({ prefix: "openclaw-worker-bundle-vendor-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      await writeFixture(packageRoot, [
        ["dist/entry.js", 'import { fake } from "@openclaw/fake-pkg";\nexport { fake };\n'],
      ]);
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        `${JSON.stringify({
          name: "openclaw",
          version: "1.2.3",
          type: "module",
          files: ["dist/"],
          dependencies: {
            json5: "2.2.3",
            "@openclaw/fake-pkg": "workspace:*",
            "@openclaw/gateway-protocol": "workspace:*",
          },
        })}\n`,
        "utf8",
      );
      const vendorSource = path.join(packageRoot, "node_modules/@openclaw/fake-pkg");
      await fs.mkdir(path.join(vendorSource, "dist"), { recursive: true });
      await fs.writeFile(
        path.join(vendorSource, "package.json"),
        `${JSON.stringify({
          name: "@openclaw/fake-pkg",
          version: "1.2.3",
          type: "module",
          main: "./dist/index.js",
          dependencies: { "partial-json": "0.1.7" },
          scripts: { build: "tsdown" },
          devDependencies: { vitest: "4.0.0" },
        })}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(vendorSource, "dist/index.js"),
        "export const fake = true;\n",
        "utf8",
      );

      const bundle = await createWorkerBundleProducer({
        packageRoot,
        cacheDir: path.join(root, "cache"),
        openclawVersion: "1.2.3",
      }).prepare();

      await expect(listTarball(bundle.tarballPath)).resolves.toEqual([
        "dist/entry.js",
        "openclaw.mjs",
        "package.json",
        "vendor/openclaw-fake-pkg/dist/index.js",
        "vendor/openclaw-fake-pkg/package.json",
      ]);
      const extractRoot = path.join(root, "extract");
      await fs.mkdir(extractRoot, { recursive: true });
      await tar.extract({ file: bundle.tarballPath, cwd: extractRoot });
      const staged = JSON.parse(
        await fs.readFile(path.join(extractRoot, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(staged.dependencies).toEqual({
        json5: "2.2.3",
        "@openclaw/fake-pkg": "file:./vendor/openclaw-fake-pkg",
      });
      const vendored = JSON.parse(
        await fs.readFile(path.join(extractRoot, "vendor/openclaw-fake-pkg/package.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(vendored.dependencies).toEqual({ "partial-json": "0.1.7" });
      expect(vendored).not.toHaveProperty("scripts");
      expect(vendored).not.toHaveProperty("devDependencies");
    });
  });

  it("fails closed when a dist-referenced workspace package is not installed", async () => {
    await withTempDir({ prefix: "openclaw-worker-bundle-vendor-missing-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      await writeFixture(packageRoot, [
        ["dist/entry.js", 'import "@openclaw/fake-pkg";\nexport {};\n'],
      ]);
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        `${JSON.stringify({
          name: "openclaw",
          version: "1.2.3",
          type: "module",
          files: ["dist/"],
          dependencies: { "@openclaw/fake-pkg": "workspace:*" },
        })}\n`,
        "utf8",
      );

      await expect(
        createWorkerBundleProducer({
          packageRoot,
          cacheDir: path.join(root, "cache"),
          openclawVersion: "1.2.3",
        }).prepare(),
      ).rejects.toThrow("cannot resolve workspace dependency @openclaw/fake-pkg");
    });
  });

  it("changes the hash when file contents change", async () => {
    await withTempDir({ prefix: "openclaw-worker-bundle-change-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      const cacheDir = path.join(root, "cache");
      await writeFixture(packageRoot, [["dist/entry.js", "export const value = 1;\n"]]);
      const first = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();

      await fs.writeFile(
        path.join(packageRoot, "dist/entry.js"),
        "export const value = 2;\n",
        "utf8",
      );
      const second = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();

      expect(second.bundleHash).not.toBe(first.bundleHash);
      await expect(fs.stat(first.tarballPath)).resolves.toBeDefined();
      await expect(fs.stat(second.tarballPath)).resolves.toBeDefined();
    });
  });

  it("archives the staged bytes when the source changes during packaging", async () => {
    await withTempDir({ prefix: "openclaw-worker-bundle-mutation-" }, async (root) => {
      const baselineRoot = path.join(root, "baseline");
      const packageRoot = path.join(root, "package");
      const originalContents = "export const value = 'before';\n";
      const changedContents = "export const value = 'after';\n";
      await writeFixture(baselineRoot, [["dist/entry.js", originalContents]]);
      await writeFixture(packageRoot, [["dist/entry.js", originalContents]]);
      const baseline = await createWorkerBundleProducer({
        packageRoot: baselineRoot,
        cacheDir: path.join(root, "baseline-cache"),
      }).prepare();
      const originalChmod = fs.chmod.bind(fs);
      let sourceMutated = false;
      const chmodSpy = vi.spyOn(fs, "chmod").mockImplementation(async (filePath, mode) => {
        await originalChmod(filePath, mode);
        if (!sourceMutated && String(filePath).endsWith(`${path.sep}dist${path.sep}entry.js`)) {
          sourceMutated = true;
          await fs.writeFile(path.join(packageRoot, "dist/entry.js"), changedContents, "utf8");
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
        await expect(fs.readFile(path.join(extractDir, "dist/entry.js"), "utf8")).resolves.toBe(
          originalContents,
        );
        await expect(fs.readFile(path.join(packageRoot, "dist/entry.js"), "utf8")).resolves.toBe(
          changedContents,
        );
      } finally {
        chmodSpy.mockRestore();
      }
    });
  });

  it("owns one immutable build snapshot for its lifecycle", async () => {
    await withTempDir({ prefix: "openclaw-worker-bundle-cache-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      await writeFixture(packageRoot, [["dist/entry.js", "export {};\n"]]);
      const producer = createWorkerBundleProducer({
        packageRoot,
        cacheDir: path.join(root, "cache"),
        protocolFeatures: ["resume", "admission", "resume"],
      });

      const firstPreparation = producer.prepare();
      const secondPreparation = producer.prepare();
      expect(secondPreparation).toBe(firstPreparation);
      const first = await firstPreparation;
      await fs.writeFile(path.join(packageRoot, "dist/entry.js"), "changed\n", "utf8");

      await expect(producer.prepare()).resolves.toBe(first);
      expect(first.protocolFeatures).toEqual(["admission", "resume"]);
    });
  });

  it("retries after a failed preparation without polling a successful snapshot", async () => {
    await withTempDir({ prefix: "openclaw-worker-bundle-retry-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      const producer = createWorkerBundleProducer({
        packageRoot,
        cacheDir: path.join(root, "cache"),
      });

      const failed = producer.prepare();
      await expect(failed).rejects.toBeDefined();
      await writeFixture(packageRoot, [["dist/entry.js", "export {};\n"]]);

      const retried = producer.prepare();
      expect(retried).not.toBe(failed);
      await expect(retried).resolves.toMatchObject({ install: "bundle" });
      expect(producer.prepare()).toBe(retried);
    });
  });

  it("replaces a corrupt content-addressed cache entry", async () => {
    await withTempDir({ prefix: "openclaw-worker-bundle-corrupt-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      const cacheDir = path.join(root, "cache");
      await writeFixture(packageRoot, [["dist/entry.js", "export {};\n"]]);
      const first = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();
      await fs.writeFile(first.tarballPath, "not a tarball", "utf8");

      const repaired = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();

      expect(repaired.bundleHash).toBe(first.bundleHash);
      expect(repaired.tarballPath).toBe(first.tarballPath);
      await expect(listTarball(repaired.tarballPath)).resolves.toEqual([
        "dist/entry.js",
        "openclaw.mjs",
        "package.json",
      ]);
    });
  });

  it.skipIf(process.platform === "win32")("rejects symlinked runtime files", async () => {
    await withTempDir({ prefix: "openclaw-worker-bundle-symlink-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      await writeFixture(packageRoot, [["dist/entry.js", "export {};\n"]]);
      await fs.rename(
        path.join(packageRoot, "openclaw.mjs"),
        path.join(packageRoot, "launcher-target.mjs"),
      );
      await fs.symlink("launcher-target.mjs", path.join(packageRoot, "openclaw.mjs"));

      await expect(
        createWorkerBundleProducer({ packageRoot, cacheDir: path.join(root, "cache") }).prepare(),
      ).rejects.toThrow("Unsafe worker bundle path: openclaw.mjs");
    });
  });
});

describe("worker npm installation artifact", () => {
  it("uses an exact registry-proven gateway package", async () => {
    await withTempDir({ prefix: "openclaw-worker-npm-release-" }, async (packageRoot) => {
      await writeFixture(packageRoot, [["dist/entry.js", "export {};\n"]]);
      await fs.writeFile(path.join(packageRoot, "npm-shrinkwrap.json"), "{}\n", "utf8");
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
    await withTempDir({ prefix: "openclaw-worker-npm-source-" }, async (packageRoot) => {
      await writeFixture(packageRoot, [["dist/entry.js", "export {};\n"]]);
      await fs.writeFile(path.join(packageRoot, "npm-shrinkwrap.json"), "{}\n", "utf8");
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
