import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotGatewayStartupEnv } from "../../../../src/gateway/test-helpers.env.js";
import { runGatewayTlsPinningProducer } from "./gateway-tls-pinning.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("Gateway TLS pinning evidence", () => {
  it("proves the live listener fingerprint and public client pin policy", async () => {
    const artifactBase = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-tls-pinning-evidence-"));
    tempDirs.push(artifactBase);
    const gatewayStartupEnv = snapshotGatewayStartupEnv();

    const evidence = await runGatewayTlsPinningProducer({
      artifactBase,
      repoRoot: process.cwd(),
    });

    expect(snapshotGatewayStartupEnv()).toEqual(gatewayStartupEnv);
    expect(evidence.entries[0]?.result.status).toBe("pass");
    const proof = JSON.parse(
      await fs.readFile(path.join(artifactBase, "gateway-tls-pinning-summary.json"), "utf8"),
    ) as {
      advertisedFingerprint: string;
      cleartextMismatch: string;
      healthResponded: boolean;
      peerFingerprint: string;
      wrongPinFailure: string;
      wrongPinHelloObserved: boolean;
    };
    expect(proof.advertisedFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(proof.peerFingerprint).toBe(proof.advertisedFingerprint);
    expect(proof.healthResponded).toBe(true);
    expect(proof.wrongPinFailure).toMatch(/fingerprint mismatch/iu);
    expect(proof.wrongPinHelloObserved).toBe(false);
    expect(proof.cleartextMismatch).toMatch(/fingerprint requires wss:\/\//iu);
  });
});
