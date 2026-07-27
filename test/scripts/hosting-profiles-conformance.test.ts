import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/e2e/hosting-profiles-conformance.mjs");
const EXPECTATIONS = [
  ["unprofiled", undefined, false, true],
  ["local", "local", true, true],
  ["local-restarted", "local", true, true],
  ["container-ready", "container", true, true],
  ["container-loopback", "container", true, false],
  ["reverse-proxy-ready", "reverse-proxy", true, true],
  ["reverse-proxy-auth-missing", "reverse-proxy", true, false],
  ["node-not-ready", "node-mode", true, false],
  ["node-unapproved", "node-mode", true, false],
  ["node-ready", "node-mode", true, true],
  ["workspace-ready", "local", true, true],
  ["workspace-full", "local", true, false],
  ["workspace-recovered", "local", true, true],
] as const;

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const PACKAGE_SHA256 = "b".repeat(64);

function run(args: string[], input?: unknown) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input),
  });
}

function createArtifact() {
  const directory = mkdtempSync(path.join(tmpdir(), "openclaw-profile-conformance-"));
  const artifactPath = path.join(directory, "hosting-profile-conformance.json");
  const result = run([
    "init",
    artifactPath,
    "2026.7.1",
    "openclaw-hosting-profiles-e2e",
    IMAGE_ID,
    PACKAGE_SHA256,
  ]);
  expect(result.status, result.stderr).toBe(0);
  return artifactPath;
}

function validation(profile: string | undefined, conformant: boolean, ready: boolean) {
  return {
    contractVersion: 1,
    conformant,
    ready,
    ...(profile ? { expectedProfile: profile, activeProfile: profile } : {}),
    findings: conformant ? [] : [{ reason: "HostingProfileNotSelected", message: "none" }],
    readiness: {
      contractVersion: 1,
      evaluatedAtMs: 1,
      identity: {
        producerRef: "openclaw/gateway/current",
        subjects: [],
      },
      ready,
      conditions: [],
      failures: [],
      advisories: [],
    },
  };
}

function record(
  artifactPath: string,
  scenario: string,
  profile: string | undefined,
  conformant: boolean,
  ready: boolean,
) {
  const exitCode = conformant && ready ? "0" : "1";
  return run(
    ["record", artifactPath, scenario, profile ?? "-", String(conformant), String(ready), exitCode],
    validation(profile, conformant, ready),
  );
}

describe("hosting profile conformance artifact", () => {
  it("records the complete package-backed matrix as a passing versioned artifact", () => {
    const artifactPath = createArtifact();
    for (const [scenario, profile, conformant, ready] of EXPECTATIONS) {
      const result = record(artifactPath, scenario, profile, conformant, ready);
      expect(result.status, result.stderr).toBe(0);
    }

    const finalize = run(["finalize", artifactPath]);
    expect(finalize.status, finalize.stderr).toBe(0);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    expect(artifact).toMatchObject({
      contractVersion: 1,
      suite: "openclaw-standard-hosting-profiles",
      profileContractVersion: 1,
      package: { name: "openclaw", version: "2026.7.1", sha256: PACKAGE_SHA256 },
      image: { reference: "openclaw-hosting-profiles-e2e", id: IMAGE_ID },
      summary: { total: 13, passed: 13, failed: 0 },
      passed: true,
    });
    expect(artifact.scenarios.map((scenario: { id: string }) => scenario.id)).toEqual(
      EXPECTATIONS.map(([scenario]) => scenario),
    );
  });

  it("retains expected non-ready results as passing conformance scenarios", () => {
    const artifactPath = createArtifact();
    const result = record(artifactPath, "container-loopback", "container", true, false);
    expect(result.status, result.stderr).toBe(0);

    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    expect(artifact.scenarios[0]).toMatchObject({
      expected: { profile: "container", conformant: true, ready: false, exitCode: 1 },
      observed: {
        exitCode: 1,
        validation: { activeProfile: "container", conformant: true, ready: false },
      },
      passed: true,
    });
  });

  it("writes mismatched evidence before failing closed", () => {
    const artifactPath = createArtifact();
    const result = run(
      ["record", artifactPath, "local", "local", "true", "true", "0"],
      validation("local", true, false),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("local conformance mismatch");

    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    expect(artifact).toMatchObject({
      passed: false,
      summary: { total: 1, passed: 0, failed: 1 },
      scenarios: [{ id: "local", passed: false }],
    });
    expect(artifact.scenarios[0].mismatches).toContain("ready=false; expected true");
  });

  it("rejects malformed or contradictory canonical readiness evidence", () => {
    const artifactPath = createArtifact();
    const malformed = validation("local", true, true);
    malformed.readiness.conditions = [{ type: "ProfileSelected" }];
    const malformedResult = run(
      ["record", artifactPath, "local", "local", "true", "true", "0"],
      malformed,
    );
    expect(malformedResult.status).toBe(1);
    expect(malformedResult.stderr).toContain("invalid hosting profile validation result");

    const contradictory = validation("local", true, true);
    contradictory.readiness.ready = false;
    const contradictoryResult = run(
      ["record", artifactPath, "local", "local", "true", "true", "0"],
      contradictory,
    );
    expect(contradictoryResult.status).toBe(1);
    expect(contradictoryResult.stderr).toContain("invalid hosting profile validation result");

    const contradictoryFindings = validation("local", true, true);
    contradictoryFindings.findings.push({ reason: "UnknownReason", message: "bad" });
    const findingResult = run(
      ["record", artifactPath, "local", "local", "true", "true", "0"],
      contradictoryFindings,
    );
    expect(findingResult.status).toBe(1);
    expect(findingResult.stderr).toContain("invalid hosting profile validation result");
  });

  it("rejects duplicate and incomplete scenario sets", () => {
    const artifactPath = createArtifact();
    expect(record(artifactPath, "local", "local", true, true).status).toBe(0);

    const duplicate = record(artifactPath, "local", "local", true, true);
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain("duplicate hosting profile conformance scenario");

    const finalize = run(["finalize", artifactPath]);
    expect(finalize.status).toBe(1);
    expect(finalize.stderr).toContain("hosting profile conformance incomplete");
  });
});
