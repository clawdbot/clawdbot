import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  QA_EVIDENCE_FILENAME,
  validateQaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import {
  parseDoctorGatewayStartupRecoveryOptions,
  resolveSystemdRecoveryPermission,
  testing,
} from "./doctor-gateway-startup-recovery.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("doctor gateway startup recovery producer", () => {
  it("requires an explicit native-systemd opt-in", () => {
    expect(resolveSystemdRecoveryPermission({})).toEqual({
      available: false,
      reason:
        "blocked native systemd recovery proof; set OPENCLAW_QA_ALLOW_SYSTEMD_RECOVERY=1 on a prepared host",
    });
    expect(resolveSystemdRecoveryPermission({ OPENCLAW_QA_ALLOW_SYSTEMD_RECOVERY: "1" })).toEqual({
      available: true,
    });
  });

  it("requires an artifact base", () => {
    expect(
      parseDoctorGatewayStartupRecoveryOptions(["--artifact-base", ".artifacts/doctor"])
        .artifactBase,
    ).toContain(".artifacts/doctor");
    expect(() => parseDoctorGatewayStartupRecoveryOptions([])).toThrow(
      "usage: --artifact-base <output-directory>",
    );
  });

  it("writes honest blocked evidence before native execution is enabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-systemd-"));
    const artifactBase = path.join(root, "artifacts");
    tempRoots.push(root);

    const evidence = await testing.runProducer(
      {
        artifactBase,
        repoRoot: process.cwd(),
      },
      {},
    );

    expect(evidence.entries[0]?.result.status).toBe("blocked");
    const diskEvidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(path.join(artifactBase, QA_EVIDENCE_FILENAME), "utf8")),
    );
    expect(diskEvidence.entries[0]).toMatchObject({
      result: {
        failure: {
          reason: expect.stringContaining("OPENCLAW_QA_ALLOW_SYSTEMD_RECOVERY=1"),
        },
        status: "blocked",
      },
    });
    await expect(
      fs.readFile(path.join(artifactBase, "doctor-gateway-startup-recovery.log"), "utf8"),
    ).resolves.toContain("blocked native systemd recovery proof");
  });
});
