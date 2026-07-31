import { describe, expect, it } from "vitest";
import { testboxLeaseStaleReasons } from "../../scripts/testbox-lease-freshness.mjs";

const fingerprint = {
  version: 1,
  baseSha: "a".repeat(40),
  headSha: "d".repeat(40),
  workingTreeClean: true,
  dependencyDigest: "b".repeat(64),
  environmentDigest: "c".repeat(64),
  workflow: ".github/workflows/ci-check-testbox.yml",
  job: "check",
  ref: "main",
};

describe("Testbox lease freshness", () => {
  it("reuses a lease when hydrated inputs still match", () => {
    expect(testboxLeaseStaleReasons(fingerprint, { ...fingerprint })).toEqual([]);
  });

  it("rotates a lease when base, dependency, or workflow inputs drift", () => {
    expect(
      testboxLeaseStaleReasons(fingerprint, {
        ...fingerprint,
        baseSha: "d".repeat(40),
        dependencyDigest: "e".repeat(64),
        workflow: "other.yml",
      }),
    ).toEqual(["baseSha", "dependencyDigest", "workflow"]);
  });

  it("rejects unknown provenance schemas", () => {
    expect(testboxLeaseStaleReasons({ ...fingerprint, version: 2 }, fingerprint)).toEqual([
      "state schema",
    ]);
  });
});
