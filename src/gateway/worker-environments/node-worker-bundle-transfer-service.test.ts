import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { createNodeWorkerBundleTransferService } from "./node-worker-bundle-transfer-service.js";

describe("node worker bundle transfer service", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-bundle-transfer-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const node: NodeWorkerSupervisorNodeProof = {
    nodeId: "node-1",
    connId: "conn-1",
    pairingIdentity: "pairing-1",
    pairingGeneration: "generation-1",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: "node",
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
    commands: [],
  };

  it("binds one exact archive download to live node authority", async () => {
    const tarballPath = path.join(root, "bundle.tgz");
    await fs.writeFile(tarballPath, "bundle");
    let authorized = true;
    const service = createNodeWorkerBundleTransferService({
      now: () => 1_000,
      generateToken: () => "A".repeat(43),
    });
    const prepared = service.prepare({
      node,
      gatewayNamespace: "gateway-test",
      artifact: {
        install: "bundle",
        bundleHash: "a".repeat(64),
        openclawVersion: "2026.8.1",
        protocolFeatures: [],
        tarballBytes: 6,
        tarballSha256: "b".repeat(64),
        tarballPath,
      },
      isAuthorized: () => authorized,
    });

    const admission = service.authorize({
      token: prepared.token,
      bundleHash: prepared.input.build.bundleHash,
    });
    expect(admission).toBeDefined();
    expect(
      service.authorize({ token: prepared.token, bundleHash: prepared.input.build.bundleHash }),
    ).toBeUndefined();
    const file = await service.openFile(admission!);
    try {
      expect(file).toMatchObject({ bytes: 6, sha256: "b".repeat(64) });
      await expect(file!.handle.readFile("utf8")).resolves.toBe("bundle");
    } finally {
      await file?.handle.close();
    }

    authorized = false;
    expect(service.isAuthorizationCurrent(admission!)).toBe(false);
    service.revoke(admission!);
    expect(service.authorizationSignal(admission!).aborted).toBe(true);
  });

  it("rejects mismatched routes and revoked owner signals", async () => {
    const tarballPath = path.join(root, "bundle.tgz");
    await fs.writeFile(tarballPath, "bundle");
    const owner = new AbortController();
    const service = createNodeWorkerBundleTransferService({
      now: () => 1_000,
      generateToken: () => "B".repeat(43),
    });
    const prepared = service.prepare({
      node,
      gatewayNamespace: "gateway-test",
      artifact: {
        install: "bundle",
        bundleHash: "a".repeat(64),
        openclawVersion: "2026.8.1",
        protocolFeatures: [],
        tarballBytes: 6,
        tarballSha256: "b".repeat(64),
        tarballPath,
      },
      isAuthorized: () => true,
      signal: owner.signal,
    });

    expect(
      service.authorize({ token: prepared.token, bundleHash: "c".repeat(64) }),
    ).toBeUndefined();
    owner.abort();
    expect(
      service.authorize({ token: prepared.token, bundleHash: prepared.input.build.bundleHash }),
    ).toBeUndefined();
  });
});
