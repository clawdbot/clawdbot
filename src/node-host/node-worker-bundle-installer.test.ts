import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  readWorkerBundleDirectoryManifest,
} from "../shared/worker-bundle-archive.js";
import { hashWorkerBundleManifest } from "../shared/worker-bundle-hash.js";
import type { NodeWorkerBundleInstallInput } from "../worker/node-bundle-install-protocol.js";
import { NodeWorkerBundleInstaller } from "./node-worker-bundle-installer.js";

describe("node worker bundle installer", () => {
  let root: string;
  let server: http.Server | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-node-bundle-"));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  async function bundleFixture(
    options: {
      packageShell?: boolean;
      prewarmMarker?: string;
      workerSource?: string;
      fixtureName?: string;
      bundlePrewarm?: 1;
    } = {},
  ): Promise<{
    archive: Buffer;
    input: NodeWorkerBundleInstallInput;
  }> {
    const fixtureName = options.fixtureName ?? "default";
    const source = path.join(root, `source-${fixtureName}`);
    const archivePath = path.join(root, `bundle-${fixtureName}.tgz`);
    await fs.mkdir(source, { recursive: true });
    const workerSource =
      options.workerSource ??
      (options.prewarmMarker
        ? `import fs from "node:fs";\nif (process.argv[2] !== "--internal-worker-prewarm" || !process.env.NODE_COMPILE_CACHE || process.env.NODE_DISABLE_COMPILE_CACHE) throw new Error("worker bundle was not prewarmed with compile cache");\nfs.writeFileSync(${JSON.stringify(options.prewarmMarker)}, "ready");\n`
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

  it("atomically installs, reuses, and cleans prior-hash crash staging", async () => {
    const prewarmMarker = path.join(root, "worker-prewarmed");
    const fixture = await bundleFixture({ prewarmMarker, bundlePrewarm: 1 });
    const staleBundleHash = "f".repeat(64);
    const staleStaging = path.join(
      root,
      fixture.input.gatewayNamespace,
      "bundles",
      `.staging-${staleBundleHash}-crashed`,
    );
    await fs.mkdir(staleStaging, { recursive: true });
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const installer = new NodeWorkerBundleInstaller({ root });

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
    ).rejects.toThrow("worker bundle download failed integrity validation");
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

  it("cancels prewarming and releases the namespace queue for the next install", async () => {
    const slowStarted = path.join(root, "slow-prewarm-started");
    const slow = await bundleFixture({
      fixtureName: "slow",
      bundlePrewarm: 1,
      workerSource: `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(slowStarted)}, "started");\nawait new Promise((resolve) => setTimeout(resolve, 2_000));\n`,
    });
    const fastMarker = path.join(root, "fast-prewarm-finished");
    const fast = await bundleFixture({
      fixtureName: "fast",
      bundlePrewarm: 1,
      prewarmMarker: fastMarker,
    });
    server = http.createServer((req, res) => {
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
    const first = installer.ensure({
      input: slow.input,
      gatewayUrl,
      signal: controller.signal,
    });
    await vi.waitFor(async () => await expect(fs.access(slowStarted)).resolves.toBeUndefined());
    const second = installer.ensure({ input: fast.input, gatewayUrl });

    controller.abort(new Error("launch fenced"));

    await expect(first).rejects.toThrow("launch fenced");
    await expect(
      Promise.race([
        second,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("namespace queue stayed occupied")), 750);
        }),
      ]),
    ).resolves.toEqual(fast.input.build);
    await expect(fs.readFile(fastMarker, "utf8")).resolves.toBe("ready");
  });
});
