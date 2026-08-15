import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { NodeWorkerBundleInstaller } from "../../node-host/node-worker-bundle-installer.js";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  readWorkerBundleDirectoryManifest,
} from "../../shared/worker-bundle-archive.js";
import { hashWorkerBundleManifest } from "../../shared/worker-bundle-hash.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import {
  createNodeWorkerBundleTransferHttpCallback,
  handleNodeWorkerBundleTransferHttpRequest,
} from "./node-worker-bundle-transfer-http.js";
import { createNodeWorkerBundleTransferService } from "./node-worker-bundle-transfer-service.js";

describe("node worker bundle transfer", () => {
  let root: string;
  let server: http.Server | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-bundle-wire-"));
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

  it("streams one authorized Gateway artifact into an atomic node install", async () => {
    const source = path.join(root, "source");
    const tarballPath = path.join(root, "bundle.tgz");
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
    await tar.create({ cwd: source, file: tarballPath, gzip: true, noDirRecurse: true }, [
      "dist/worker.js",
      "openclaw.mjs",
      "package.json",
    ]);
    const tarball = await fs.readFile(tarballPath);
    const service = createNodeWorkerBundleTransferService({
      generateToken: () => "A".repeat(43),
    });
    const node: NodeWorkerSupervisorNodeProof = {
      nodeId: "node-1",
      connId: "conn-1",
      pairingIdentity: "pairing-1",
      pairingGeneration: "generation-1",
      clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
      clientMode: "node",
      protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
      commands: [],
    };
    const prepared = service.prepare({
      node,
      gatewayNamespace: "gateway-test",
      artifact: {
        install: "bundle",
        bundleHash,
        openclawVersion: "2026.8.1",
        protocolFeatures: [],
        tarballBytes: tarball.byteLength,
        tarballSha256: createHash("sha256").update(tarball).digest("hex"),
        tarballPath,
      },
      isAuthorized: () => true,
    });
    const callback = createNodeWorkerBundleTransferHttpCallback(service);
    server = http.createServer((req, res) => {
      void handleNodeWorkerBundleTransferHttpRequest({
        req,
        res,
        clientIp: "127.0.0.1",
        callback,
      }).catch((error: unknown) => res.destroy(error as Error));
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind a TCP port");
    }
    const installer = new NodeWorkerBundleInstaller({
      root: path.join(root, "node-host"),
      runCommand: vi.fn(async () => ({
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit" as const,
      })),
    });

    await expect(
      installer.ensure({
        input: prepared.input,
        gatewayUrl: `ws://127.0.0.1:${address.port}`,
      }),
    ).resolves.toEqual(prepared.input.build);
    expect(service.authorize({ token: prepared.token, bundleHash })).toBeUndefined();
  });
});
