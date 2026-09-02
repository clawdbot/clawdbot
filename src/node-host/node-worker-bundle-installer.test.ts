import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as openclawRoot from "../infra/openclaw-root.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  readWorkerBundleDirectoryManifest,
} from "../shared/worker-bundle-archive.js";
import { hashWorkerBundleManifest } from "../shared/worker-bundle-hash.js";
import type { NodeWorkerBundleInstallInput } from "../worker/node-bundle-install-protocol.js";
import { NodeWorkerBundleInstaller } from "./node-worker-bundle-installer.js";

type BundleFixtureOptions = {
  packageShell?: boolean;
  prewarmMarker?: string;
  workerSource?: string;
  fixtureName?: string;
  bundlePrewarm?: 1;
  compileCacheDisabled?: boolean;
};

type BundleFixture = {
  archive: Buffer;
  input: NodeWorkerBundleInstallInput;
};

describe("node worker bundle installer", () => {
  let root: string;
  let server: http.Server | undefined;
  let cleanupPrewarming: (() => Promise<void>) | undefined;
  let defaultFixture: BundleFixture;

  beforeAll(async () => {
    const fixtureRoot = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-node-bundle-fixture-"),
    );
    try {
      defaultFixture = await buildBundleFixture(fixtureRoot);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-node-bundle-"));
  });

  afterEach(async () => {
    const cleanup = cleanupPrewarming;
    cleanupPrewarming = undefined;
    await cleanup?.();
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  async function bundleFixture(options?: BundleFixtureOptions): Promise<BundleFixture> {
    if (options) {
      return await buildBundleFixture(root, options);
    }
    // Integrity cases deliberately corrupt their inputs; share preparation, not mutable data.
    return {
      archive: Buffer.from(defaultFixture.archive),
      input: structuredClone(defaultFixture.input),
    };
  }

  async function buildBundleFixture(
    fixtureRoot: string,
    options: BundleFixtureOptions = {},
  ): Promise<BundleFixture> {
    const fixtureName = options.fixtureName ?? "default";
    const source = path.join(fixtureRoot, `source-${fixtureName}`);
    const archivePath = path.join(fixtureRoot, `bundle-${fixtureName}.tgz`);
    await fs.mkdir(source, { recursive: true });
    const compileCacheDisabled =
      options.compileCacheDisabled ?? process.env.NODE_DISABLE_COMPILE_CACHE !== undefined;
    const workerSource =
      options.workerSource ??
      (options.prewarmMarker
        ? `import fs from "node:fs";\nconst cacheDisabled = process.env.NODE_DISABLE_COMPILE_CACHE === "1";\nif (process.argv[2] !== "--internal-worker-prewarm" || cacheDisabled !== ${compileCacheDisabled} || (cacheDisabled ? process.env.NODE_COMPILE_CACHE : !process.env.NODE_COMPILE_CACHE)) throw new Error("worker bundle was not prewarmed with the requested compile-cache mode");\nfs.writeFileSync(${JSON.stringify(options.prewarmMarker)}, "ready");\n`
        : "export {};\n");
    await fs.writeFile(path.join(source, "worker.mjs"), workerSource, { mode: 0o700 });
    const archiveEntries = ["worker.mjs"];
    if (options.packageShell) {
      await fs.mkdir(path.join(source, "dist"));
      await fs.writeFile(path.join(source, "openclaw.mjs"), "#!/usr/bin/env node\n", {
        mode: 0o700,
      });
      await fs.writeFile(path.join(source, "package.json"), '{"name":"openclaw"}\n');
      await fs.writeFile(path.join(source, "dist", "worker.js"), "export {};\n");
      archiveEntries.push("dist/worker.js", "openclaw.mjs", "package.json");
    }
    const manifest = await readWorkerBundleDirectoryManifest({
      root: source,
      limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
    });
    const bundleHash = hashWorkerBundleManifest(manifest);
    await tar.create(
      { cwd: source, file: archivePath, gzip: true, noDirRecurse: true },
      archiveEntries,
    );
    const archive = await fs.readFile(archivePath);
    return {
      archive,
      input: {
        gatewayNamespace: "gateway-test",
        ...(options.bundlePrewarm ? { bundlePrewarm: options.bundlePrewarm } : {}),
        build: { bundleHash, openclawVersion: "2026.8.1", protocolFeatures: [] },
        archive: {
          token: "A".repeat(43),
          sha256: createHash("sha256").update(archive).digest("hex"),
          bytes: archive.byteLength,
        },
      },
    };
  }

  async function serve(archive: Buffer, token: string, declaredBytes = archive.byteLength) {
    const requests = vi.fn();
    server = http.createServer((req, res) => {
      requests(req.url, req.headers);
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(declaredBytes),
      });
      res.end(archive);
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind a TCP port");
    }
    return { gatewayUrl: `ws://127.0.0.1:${address.port}`, requests };
  }

  async function prepareLocalArchive(fixture: BundleFixture) {
    const packageRoot = path.join(root, "runtime-package");
    const archivePath = path.join(
      packageRoot,
      "worker-artifacts",
      `${fixture.input.archive.sha256}.tgz`,
    );
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, fixture.archive);
    vi.spyOn(openclawRoot, "resolveOpenClawPackageRootSync").mockReturnValue(packageRoot);
    return archivePath;
  }

  it("installs the exact prepared archive without HTTP and creates a fresh admission receipt", async () => {
    const fixture = await bundleFixture();
    const archivePath = await prepareLocalArchive(fixture);
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const installer = new NodeWorkerBundleInstaller({ root });

    await expect(
      installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl }),
    ).resolves.toEqual(fixture.input.build);

    expect(served.requests).not.toHaveBeenCalled();
    const receipt = path.join(
      root,
      fixture.input.gatewayNamespace,
      "bundles",
      fixture.input.build.bundleHash,
      "bootstrap-receipt.json",
    );
    expect(JSON.parse(await fs.readFile(receipt, "utf8"))).toEqual(fixture.input.build);
    await expect(fs.readFile(archivePath)).resolves.toEqual(fixture.archive);
  });

  it("uses authenticated HTTP for a different archive without modifying prepared bytes", async () => {
    const prepared = await bundleFixture();
    const archivePath = await prepareLocalArchive(prepared);
    const requested = await bundleFixture({
      fixtureName: "new-build",
      workerSource: "export const changed = true;\n",
    });
    const served = await serve(requested.archive, requested.input.archive.token);
    const installer = new NodeWorkerBundleInstaller({ root });

    await expect(
      installer.ensure({ input: requested.input, gatewayUrl: served.gatewayUrl }),
    ).resolves.toEqual(requested.input.build);

    expect(served.requests).toHaveBeenCalledOnce();
    await expect(fs.readdir(path.dirname(archivePath))).resolves.toEqual([
      path.basename(archivePath),
    ]);
    await expect(fs.readFile(archivePath)).resolves.toEqual(prepared.archive);
  });

  it.each(["cancel", "missing-stage"] as const)(
    "rejects %s during local acquisition without HTTP or admission",
    async (failure) => {
      const fixture = await bundleFixture();
      await prepareLocalArchive(fixture);
      const served = await serve(fixture.archive, fixture.input.archive.token);
      const installer = new NodeWorkerBundleInstaller({ root });
      const controller = new AbortController();
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (path.basename(String(args[0])) === "bundle.tgz" && args[1] === "wx") {
          if (failure === "missing-stage") {
            throw Object.assign(new Error("staging disappeared"), { code: "ENOENT" });
          }
          controller.abort(new Error("local acquisition cancelled"));
        }
        return await open(...args);
      });

      await expect(
        installer.ensure({
          input: fixture.input,
          gatewayUrl: served.gatewayUrl,
          signal: controller.signal,
        }),
      ).rejects.toThrow(
        failure === "cancel" ? "local acquisition cancelled" : "staging disappeared",
      );

      expect(served.requests).not.toHaveBeenCalled();
      await expect(
        fs.readdir(path.join(root, fixture.input.gatewayNamespace, "bundles")),
      ).resolves.toEqual([]);
      await expect(
        installer.retain({ gatewayNamespace: fixture.input.gatewayNamespace, bundleHashes: [] }),
      ).resolves.toEqual({ deleted: 0, hasMore: false, generation: 0 });
    },
  );

  it.each(["corrupt", "wrong-length", "symlink", "hardlink", "directory"] as const)(
    "rejects a present %s prepared archive without HTTP or admission",
    async (kind) => {
      const fixture = await bundleFixture();
      const archivePath = await prepareLocalArchive(fixture);
      if (kind === "corrupt") {
        const corrupt = Buffer.from(fixture.archive);
        corrupt.writeUInt8(corrupt.readUInt8(0) ^ 1, 0);
        await fs.writeFile(archivePath, corrupt);
      } else if (kind === "wrong-length") {
        await fs.appendFile(archivePath, "extra");
      } else {
        await fs.rename(archivePath, `${archivePath}.original`);
        if (kind === "symlink") {
          await fs.symlink(`${archivePath}.original`, archivePath);
        } else if (kind === "hardlink") {
          await fs.link(`${archivePath}.original`, archivePath);
        } else {
          await fs.mkdir(archivePath);
        }
      }
      const served = await serve(fixture.archive, fixture.input.archive.token);
      const installer = new NodeWorkerBundleInstaller({ root });

      await expect(
        installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl }),
      ).rejects.toThrow("worker-bundle-install-failed");

      expect(served.requests).not.toHaveBeenCalled();
      await expect(
        installer.inspect({
          gatewayNamespace: fixture.input.gatewayNamespace,
          bundleHash: fixture.input.build.bundleHash,
        }),
      ).resolves.toEqual({ bundleHash: fixture.input.build.bundleHash, status: "missing" });
    },
  );

  it.each(["http", "local"] as const)(
    "does not publish a %s bundle when cancellation arrives during receipt staging",
    async (source) => {
      const fixture = await bundleFixture();
      if (source === "local") {
        await prepareLocalArchive(fixture);
      }
      const served = await serve(fixture.archive, fixture.input.archive.token);
      const installer = new NodeWorkerBundleInstaller({ root });
      const controller = new AbortController();
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (String(args[0]).endsWith("bootstrap-receipt.json") && args[1] === "wx") {
          controller.abort(new Error("installer cancelled"));
        }
        return handle;
      });

      await expect(
        installer.ensure({
          input: fixture.input,
          gatewayUrl: served.gatewayUrl,
          signal: controller.signal,
        }),
      ).rejects.toThrow("installer cancelled");
      expect(served.requests).toHaveBeenCalledTimes(source === "local" ? 0 : 1);
      await expect(
        fs.readdir(path.join(root, fixture.input.gatewayNamespace, "bundles")),
      ).resolves.toEqual([]);
    },
  );

  it.each(["http", "local"] as const)(
    "restores the prior destination when cancelled between %s publication renames",
    async (source) => {
      const fixture = await bundleFixture();
      if (source === "local") {
        await prepareLocalArchive(fixture);
      }
      const served = await serve(fixture.archive, fixture.input.archive.token);
      const installer = new NodeWorkerBundleInstaller({ root });
      const bundlesRoot = path.join(root, fixture.input.gatewayNamespace, "bundles");
      const destination = path.join(bundlesRoot, fixture.input.build.bundleHash);
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(path.join(destination, "prior-install"), "preserved");
      const controller = new AbortController();
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        await rename(...args);
        if (args[0] === destination && String(args[1]).includes(".previous-")) {
          controller.abort(new Error("publication cancelled"));
        }
      });

      await expect(
        installer.ensure({
          input: fixture.input,
          gatewayUrl: served.gatewayUrl,
          signal: controller.signal,
        }),
      ).rejects.toThrow("publication cancelled");

      await expect(fs.readdir(bundlesRoot)).resolves.toEqual([fixture.input.build.bundleHash]);
      await expect(fs.readdir(destination)).resolves.toEqual(["prior-install"]);
      await expect(fs.readFile(path.join(destination, "prior-install"), "utf8")).resolves.toBe(
        "preserved",
      );
    },
  );

  it("does not renew retention when cancelled while validating an installed bundle", async () => {
    const fixture = await bundleFixture();
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const installer = new NodeWorkerBundleInstaller({ root });
    await installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl });
    const controller = new AbortController();
    const stat = fs.stat.bind(fs);
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const result = await stat(...args);
      if (String(args[0]).endsWith("worker.mjs")) {
        controller.abort(new Error("cached install cancelled"));
      }
      return result;
    });

    await expect(
      installer.ensure({
        input: fixture.input,
        gatewayUrl: served.gatewayUrl,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cached install cancelled");

    expect(served.requests).toHaveBeenCalledOnce();
    await expect(
      installer.retain({
        gatewayNamespace: fixture.input.gatewayNamespace,
        bundleHashes: [fixture.input.build.bundleHash],
      }),
    ).resolves.toEqual({ deleted: 0, hasMore: false, generation: 1 });
  });

  it("rejects cancellation during final cleanup without renewing retention or removing published bytes", async () => {
    const fixture = await bundleFixture();
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const installer = new NodeWorkerBundleInstaller({ root });
    const controller = new AbortController();
    const rm = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      await rm(...args);
      if (path.basename(String(args[0])).startsWith(".staging-")) {
        controller.abort(new Error("install cleanup cancelled"));
      }
    });

    await expect(
      installer.ensure({
        input: fixture.input,
        gatewayUrl: served.gatewayUrl,
        signal: controller.signal,
      }),
    ).rejects.toThrow("install cleanup cancelled");

    await expect(
      installer.inspect({
        gatewayNamespace: fixture.input.gatewayNamespace,
        bundleHash: fixture.input.build.bundleHash,
      }),
    ).resolves.toEqual({ bundleHash: fixture.input.build.bundleHash, status: "installed" });
    await expect(
      installer.retain({
        gatewayNamespace: fixture.input.gatewayNamespace,
        bundleHashes: [fixture.input.build.bundleHash],
      }),
    ).resolves.toEqual({ deleted: 0, hasMore: false, generation: 0 });
  });

  it("atomically installs, reuses, and cleans prior-hash crash staging", async () => {
    const prewarmMarker = path.join(root, "worker-prewarmed");
    const fixture = await bundleFixture({
      prewarmMarker,
      bundlePrewarm: 1,
      compileCacheDisabled: false,
    });
    const staleBundleHash = "f".repeat(64);
    const staleStaging = path.join(
      root,
      fixture.input.gatewayNamespace,
      "bundles",
      `.staging-${staleBundleHash}-crashed`,
    );
    await fs.mkdir(staleStaging, { recursive: true });
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const installer = new NodeWorkerBundleInstaller({
      root,
      env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: undefined },
    });

    await expect(
      installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl }),
    ).resolves.toEqual(fixture.input.build);
    await expect(
      installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl }),
    ).resolves.toEqual(fixture.input.build);

    expect(served.requests).toHaveBeenCalledOnce();
    await expect(fs.readFile(prewarmMarker, "utf8")).resolves.toBe("ready");
    await expect(fs.access(staleStaging)).rejects.toThrow();
    await expect(
      fs.readFile(
        path.join(
          root,
          fixture.input.gatewayNamespace,
          "bundles",
          fixture.input.build.bundleHash,
          "bootstrap-receipt.json",
        ),
        "utf8",
      ),
    ).resolves.toContain(fixture.input.build.bundleHash);
  });

  it("prewarms bundles while honoring an explicitly disabled compile cache", async () => {
    const prewarmMarker = path.join(root, "worker-prewarmed-without-cache");
    const fixture = await bundleFixture({
      prewarmMarker,
      bundlePrewarm: 1,
      compileCacheDisabled: true,
    });
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const installer = new NodeWorkerBundleInstaller({
      root,
      env: { ...process.env, NODE_COMPILE_CACHE: undefined, NODE_DISABLE_COMPILE_CACHE: "1" },
    });

    await expect(
      installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl }),
    ).resolves.toEqual(fixture.input.build);
    await expect(fs.readFile(prewarmMarker, "utf8")).resolves.toBe("ready");
  });

  it("prewarms bundles with managed cache behind a host compile-cache fence", async () => {
    const prewarmMarker = path.join(root, "worker-prewarmed-with-managed-cache");
    const fixture = await bundleFixture({
      prewarmMarker,
      bundlePrewarm: 1,
      compileCacheDisabled: false,
    });
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const installer = new NodeWorkerBundleInstaller({
      root,
      env: {
        ...process.env,
        NODE_COMPILE_CACHE: "/tmp/ambient-host-compile-cache",
        NODE_DISABLE_COMPILE_CACHE: "1",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.node",
        OPENCLAW_SERVICE_KIND: "node",
      },
    });

    await expect(
      installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl }),
    ).resolves.toEqual(fixture.input.build);
    await expect(fs.readFile(prewarmMarker, "utf8")).resolves.toBe("ready");
  });

  it("reuses a v1 install when Windows cannot retain Unix artifact modes", async () => {
    const fixture = await bundleFixture();
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const installer = new NodeWorkerBundleInstaller({ root });
    const readStats = fs.lstat.bind(fs);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stats = await readStats(...args);
      if (stats.isFile()) {
        stats.mode = (Number(stats.mode) & ~0o777) | 0o666;
      }
      return stats;
    });

    try {
      await expect(
        installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl }),
      ).resolves.toEqual(fixture.input.build);
      await expect(
        installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl }),
      ).resolves.toEqual(fixture.input.build);
      expect(served.requests).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("rejects the Cloudflare Access pair before a plaintext bundle transfer", async () => {
    const fixture = await bundleFixture();
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const installer = new NodeWorkerBundleInstaller({ root });

    await expect(
      installer.ensure({
        input: fixture.input,
        gatewayUrl: served.gatewayUrl,
        gatewayCloudflareAccess: {
          clientId: "cf-bundle-id",
          clientSecret: "cf-bundle-secret",
        },
      }),
    ).rejects.toThrow("worker-bundle-install-failed: Cloudflare Access credentials require HTTPS");

    expect(served.requests).not.toHaveBeenCalled();
  });

  it("reports installed only after full bundle validation", async () => {
    const fixture = await bundleFixture();
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const installer = new NodeWorkerBundleInstaller({ root });

    await expect(
      installer.inspect({
        gatewayNamespace: fixture.input.gatewayNamespace,
        bundleHash: fixture.input.build.bundleHash,
      }),
    ).resolves.toEqual({ bundleHash: fixture.input.build.bundleHash, status: "missing" });
    await installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl });
    await expect(
      installer.inspect({
        gatewayNamespace: fixture.input.gatewayNamespace,
        bundleHash: fixture.input.build.bundleHash,
      }),
    ).resolves.toEqual({ bundleHash: fixture.input.build.bundleHash, status: "installed" });

    const bundleDir = path.join(
      root,
      fixture.input.gatewayNamespace,
      "bundles",
      fixture.input.build.bundleHash,
    );
    await fs.writeFile(path.join(bundleDir, "worker.mjs"), "tampered\n");
    await expect(
      installer.inspect({
        gatewayNamespace: fixture.input.gatewayNamespace,
        bundleHash: fixture.input.build.bundleHash,
      }),
    ).resolves.toEqual({ bundleHash: fixture.input.build.bundleHash, status: "missing" });
  });

  it("prunes superseded bundle artifacts in bounded passes while retaining the latest install", async () => {
    const fixture = await bundleFixture();
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const installer = new NodeWorkerBundleInstaller({ root });
    await installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl });
    const bundlesRoot = path.join(root, fixture.input.gatewayNamespace, "bundles");
    const staleHashes = Array.from({ length: 18 }, (_, index) =>
      (index + 1).toString(16).padStart(64, "0"),
    ).filter((hash) => hash !== fixture.input.build.bundleHash);
    for (const hash of staleHashes) {
      await fs.mkdir(path.join(bundlesRoot, hash));
    }
    await fs.mkdir(path.join(bundlesRoot, `${"e".repeat(64)}.previous-crash`));
    await fs.mkdir(path.join(bundlesRoot, `.staging-${"d".repeat(64)}-crash`));
    await fs.mkdir(path.join(bundlesRoot, "operator-owned"));

    const first = await installer.retain({
      gatewayNamespace: fixture.input.gatewayNamespace,
      bundleHashes: [],
    });
    expect(first).toEqual({ deleted: 16, hasMore: true, generation: 1 });
    let result = first;
    while (result.hasMore) {
      result = await installer.retain({
        gatewayNamespace: fixture.input.gatewayNamespace,
        bundleHashes: [],
      });
    }

    await expect(
      fs.access(path.join(bundlesRoot, fixture.input.build.bundleHash)),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(bundlesRoot, "operator-owned"))).resolves.toBeUndefined();
    for (const hash of staleHashes) {
      await expect(fs.access(path.join(bundlesRoot, hash))).rejects.toThrow();
    }
  });

  it("protects every install until a later snapshot acknowledges it", async () => {
    const first = await bundleFixture({
      fixtureName: "pending-a",
      workerSource: "export const a = 1;\n",
    });
    const second = await bundleFixture({
      fixtureName: "pending-b",
      workerSource: "export const b = 1;\n",
    });
    server = http.createServer((req, res) => {
      const archive = req.url?.endsWith(first.input.build.bundleHash)
        ? first.archive
        : second.archive;
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(archive.byteLength),
      });
      res.end(archive);
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind a TCP port");
    }
    const gatewayUrl = `ws://127.0.0.1:${address.port}`;
    const installer = new NodeWorkerBundleInstaller({ root });
    await installer.ensure({ input: first.input, gatewayUrl });
    await installer.ensure({ input: second.input, gatewayUrl });

    const initial = await installer.retain({
      gatewayNamespace: first.input.gatewayNamespace,
      bundleHashes: [],
    });
    expect(initial).toEqual({ deleted: 0, hasMore: false, generation: 2 });

    const bundlesRoot = path.join(root, first.input.gatewayNamespace, "bundles");
    await expect(
      fs.access(path.join(bundlesRoot, first.input.build.bundleHash)),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(bundlesRoot, second.input.build.bundleHash)),
    ).resolves.toBeUndefined();

    await installer.retain({
      gatewayNamespace: first.input.gatewayNamespace,
      bundleHashes: [],
      acknowledgedGeneration: initial.generation,
    });
    await expect(fs.access(path.join(bundlesRoot, first.input.build.bundleHash))).rejects.toThrow();
    await expect(
      fs.access(path.join(bundlesRoot, second.input.build.bundleHash)),
    ).rejects.toThrow();
  });

  it("reinstalls when executable dependency material appears outside the bundle hash", async () => {
    const fixture = await bundleFixture({ packageShell: true });
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const installer = new NodeWorkerBundleInstaller({ root });
    const bundleDir = path.join(
      root,
      fixture.input.gatewayNamespace,
      "bundles",
      fixture.input.build.bundleHash,
    );
    const tamperedDependency = path.join(bundleDir, "node_modules", "tampered", "index.js");

    await installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl });
    await fs.mkdir(path.dirname(tamperedDependency), { recursive: true });
    await fs.writeFile(tamperedDependency, "export const trusted = false;\n");
    await installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl });

    expect(served.requests).toHaveBeenCalledTimes(2);
    await expect(fs.access(tamperedDependency)).rejects.toThrow();
  });

  it("rejects archive digest mismatch without publishing a bundle", async () => {
    const fixture = await bundleFixture();
    fixture.input.archive.sha256 = "f".repeat(64);
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const installer = new NodeWorkerBundleInstaller({ root });

    await expect(
      installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl }),
    ).rejects.toThrow("worker bundle archive failed integrity validation");
    await expect(
      fs.access(
        path.join(root, fixture.input.gatewayNamespace, "bundles", fixture.input.build.bundleHash),
      ),
    ).rejects.toThrow();
  });

  it("rejects an unexpected content length before publication", async () => {
    const fixture = await bundleFixture();
    const served = await serve(
      fixture.archive,
      fixture.input.archive.token,
      fixture.archive.byteLength + 1,
    );
    const installer = new NodeWorkerBundleInstaller({ root });

    await expect(
      installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl }),
    ).rejects.toThrow("gateway returned an unexpected worker bundle length");
  });

  it("cancels prewarming and releases the namespace queue for the next install", async ({
    signal,
  }) => {
    const slow = await bundleFixture({
      fixtureName: "slow",
      bundlePrewarm: 1,
      workerSource: 'process.stdout.write("started");\nprocess.stdin.resume();\n',
    });
    const fastMarker = path.join(root, "fast-prewarm-finished");
    const fast = await bundleFixture({
      fixtureName: "fast",
      bundlePrewarm: 1,
      prewarmMarker: fastMarker,
    });
    const fastRequested = createDeferredCore();
    server = http.createServer((req, res) => {
      if (req.url?.endsWith(fast.input.build.bundleHash)) {
        fastRequested.resolve();
      }
      const archive = req.url?.endsWith(slow.input.build.bundleHash) ? slow.archive : fast.archive;
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(archive.byteLength),
      });
      res.end(archive);
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind a TCP port");
    }
    const gatewayUrl = `ws://127.0.0.1:${address.port}`;
    const installer = new NodeWorkerBundleInstaller({ root });
    const controller = new AbortController();
    const cleanupController = new AbortController();
    const testSignal = AbortSignal.any([signal, cleanupController.signal]);
    const started = createDeferredCore<ChildProcess>();
    const children = new Map<ChildProcess, Promise<void>>();
    const entries = [slow, fast].map((fixture) =>
      path.join(
        root,
        fixture.input.gatewayNamespace,
        "bundles",
        fixture.input.build.bundleHash,
        "worker.mjs",
      ),
    );
    const childProcesses = channel("child_process");
    const trackPrewarm = (message: unknown) => {
      const child = (message as { process: ChildProcess }).process;
      child.once("spawn", () => {
        if (!entries.includes(child.spawnargs[1] ?? "")) {
          return;
        }
        const closed = createDeferredCore();
        child.once("close", () => closed.resolve());
        children.set(child, closed.promise);
        if (child.spawnargs[1] === entries[0]) {
          child.stdout!.once("data", () => started.resolve(child));
        }
      });
    };
    childProcesses.subscribe(trackPrewarm);
    const first = installer.ensure({
      input: slow.input,
      gatewayUrl,
      signal: AbortSignal.any([controller.signal, testSignal]),
    });
    const installs = [first];
    cleanupPrewarming = async () => {
      cleanupController.abort();
      for (const child of children.keys()) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }
      await Promise.allSettled([...installs, ...children.values()]);
      childProcesses.unsubscribe(trackPrewarm);
    };
    // Startup time is not the cancellation contract: hold the real child until
    // abort, and join its close event even when readiness or assertions fail.
    const slowChild = await Promise.race([
      started.promise,
      first.then(() => {
        throw new Error("prewarm finished before cancellation");
      }),
    ]);
    testSignal.throwIfAborted();
    const second = installer.ensure({ input: fast.input, gatewayUrl, signal: testSignal });
    installs.push(second);

    controller.abort(new Error("launch fenced"));

    // Bound handoff from cancellation; acquisition precedes cold extraction and prewarm.
    await Promise.all([
      vi.waitFor(() => expect(fastRequested.promise).resolves.toBeUndefined(), { timeout: 750 }),
      expect(first).rejects.toThrow("launch fenced"),
    ]);
    await expect(second).resolves.toEqual(fast.input.build);
    await children.get(slowChild);
    expect(slowChild.killed).toBe(true);
    await expect(fs.readFile(fastMarker, "utf8")).resolves.toBe("ready");
  });
});
