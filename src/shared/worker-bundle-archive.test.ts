import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  extractWorkerBundleArchive,
  readWorkerBundleArchiveManifest,
  readWorkerBundleDirectoryManifest,
} from "./worker-bundle-archive.js";
import { hashWorkerBundleManifest } from "./worker-bundle-hash.js";

describe("worker bundle archive", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-bundle-archive-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("extracts only a manifest-identical regular-file bundle", async () => {
    const source = path.join(root, "source");
    const archive = path.join(root, "bundle.tgz");
    const destination = path.join(root, "destination");
    await fs.mkdir(path.join(source, "dist"), { recursive: true });
    await fs.writeFile(path.join(source, "openclaw.mjs"), "#!/usr/bin/env node\n");
    await fs.chmod(path.join(source, "openclaw.mjs"), 0o700);
    await fs.writeFile(path.join(source, "dist", "worker.js"), "export const worker = true;\n");
    await fs.chmod(path.join(source, "dist", "worker.js"), 0o600);
    const sourceManifest = await readWorkerBundleDirectoryManifest({
      root: source,
      limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
    });
    const bundleHash = hashWorkerBundleManifest(sourceManifest);
    await tar.create({ cwd: source, file: archive, gzip: true, noDirRecurse: true }, [
      "openclaw.mjs",
      "dist/worker.js",
    ]);

    await extractWorkerBundleArchive({
      tarballPath: archive,
      destination,
      expectedBundleHash: bundleHash,
      limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
    });

    expect(
      hashWorkerBundleManifest(
        await readWorkerBundleDirectoryManifest({
          root: destination,
          limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
        }),
      ),
    ).toBe(bundleHash);
  });

  it("rejects archive links before extraction", async () => {
    const source = path.join(root, "source");
    const archive = path.join(root, "bundle.tgz");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "target"), "target");
    await fs.symlink("target", path.join(source, "openclaw.mjs"));
    await tar.create({ cwd: source, file: archive, gzip: true, noDirRecurse: true }, [
      "openclaw.mjs",
    ]);

    await expect(
      readWorkerBundleArchiveManifest(archive, DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS),
    ).rejects.toThrow("Invalid worker bundle tar entry");
  });

  it("rejects a valid archive under the wrong logical hash", async () => {
    const source = path.join(root, "source");
    const archive = path.join(root, "bundle.tgz");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "openclaw.mjs"), "worker");
    await tar.create({ cwd: source, file: archive, gzip: true, noDirRecurse: true }, [
      "openclaw.mjs",
    ]);

    await expect(
      extractWorkerBundleArchive({
        tarballPath: archive,
        destination: path.join(root, "destination"),
        expectedBundleHash: "f".repeat(64),
        limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
      }),
    ).rejects.toThrow("archive manifest does not match");
  });
});
