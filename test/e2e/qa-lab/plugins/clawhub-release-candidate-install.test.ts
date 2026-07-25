// ClawHub release candidate producer tests cover blocked script evidence output.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateQaEvidenceSummaryJson } from "../../../../extensions/qa-lab/api.js";
import { runClawHubReleaseCandidateInstallProducer } from "./clawhub-release-candidate-install.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});

describe("ClawHub release candidate install producer", () => {
  it("writes blocked evidence when no candidate tarball is available", async () => {
    const artifactBase = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-clawhub-release-evidence-"),
    );
    tempRoots.push(artifactBase);
    const missingTarballEnv = "OPENCLAW_TEST_MISSING_RELEASE_CANDIDATE_TARBALL";
    vi.stubEnv(missingTarballEnv, "");

    const result = await runClawHubReleaseCandidateInstallProducer({
      artifactBase,
      buildFromCheckout: false,
      repoRoot: process.cwd(),
      tarballEnv: missingTarballEnv,
    });
    const evidencePath = path.join(artifactBase, "qa-evidence.json");
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(evidencePath, "utf8")),
    );
    expect(result).toEqual(evidence);
    expect(evidence.entries[0]).toMatchObject({
      execution: {
        artifacts: [{ kind: "log", path: "parallels-npm-update.log", source: "script" }],
      },
      result: {
        status: "blocked",
        failure: {
          reason: expect.stringContaining(`${missingTarballEnv} is not set`),
        },
      },
    });
  });
});
