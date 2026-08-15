import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
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

  async function bundleFixture(): Promise<{
    archive: Buffer;
    input: NodeWorkerBundleInstallInput;
  }> {
    const source = path.join(root, "source");
    const archivePath = path.join(root, "bundle.tgz");
    await fs.mkdir(path.join(source, "dist"), { recursive: true });
    await fs.writeFile(path.join(source, "openclaw.mjs"), "#!/usr/bin/env node\n");
    await fs.chmod(path.join(source, "openclaw.mjs"), 0o700);
    await fs.writeFile(path.join(source, "package.json"), '{"name":"openclaw"}\n');
    await fs.chmod(path.join(source, "package.json"), 0o600);
    await fs.writeFile(path.join(source, "dist", "worker.js"), "export {};\n");
    await fs.chmod(path.join(source, "dist", "worker.js"), 0o600);
    const manifest = await readWorkerBundleDirectoryManifest({
      root: source,
      limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
    });
    const bundleHash = hashWorkerBundleManifest(manifest);
    await tar.create({ cwd: source, file: archivePath, gzip: true, noDirRecurse: true }, [
      "dist/worker.js",
      "openclaw.mjs",
      "package.json",
    ]);
    const archive = await fs.readFile(archivePath);
    return {
      archive,
      input: {
        gatewayNamespace: "gateway-test",
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
    const fixture = await bundleFixture();
    const staleBundleHash = "f".repeat(64);
    const staleStaging = path.join(
      root,
      fixture.input.gatewayNamespace,
      "bundles",
      `.staging-${staleBundleHash}-crashed`,
    );
    await fs.mkdir(staleStaging, { recursive: true });
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const runCommand = vi.fn<typeof runCommandWithTimeout>(async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
    }));
    const installer = new NodeWorkerBundleInstaller({ root, runCommand });

    await expect(
      installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl }),
    ).resolves.toEqual(fixture.input.build);
    await expect(
      installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl }),
    ).resolves.toEqual(fixture.input.build);

    expect(served.requests).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledOnce();
    await expect(fs.access(staleStaging)).rejects.toThrow();
    expect(runCommand.mock.calls[0]?.[0]).toContain("--ignore-scripts");
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

  it("rejects archive digest mismatch without publishing a bundle", async () => {
    const fixture = await bundleFixture();
    fixture.input.archive.sha256 = "f".repeat(64);
    const served = await serve(fixture.archive, fixture.input.archive.token);
    const installer = new NodeWorkerBundleInstaller({
      root,
      runCommand: vi.fn(),
    });

    await expect(
      installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl }),
    ).rejects.toThrow("bundle installation did not complete");
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
    const installer = new NodeWorkerBundleInstaller({ root, runCommand: vi.fn() });

    await expect(
      installer.ensure({ input: fixture.input, gatewayUrl: served.gatewayUrl }),
    ).rejects.toThrow("bundle installation did not complete");
  });
});
