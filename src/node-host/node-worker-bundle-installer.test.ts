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
      requests(req.url, req.headers.authorization);
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
