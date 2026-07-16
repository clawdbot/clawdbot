import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseArgs,
  releaseProfileForTarget,
  releaseEvidenceVerificationArgs,
  releaseEvidenceVerifierPath,
  resolveRemoteTargetRefSha,
  selectWorkflowRunCheckSuite,
} from "../../scripts/full-release-validation-at-sha.mjs";

describe("full-release-validation-at-sha", () => {
  it("parses release validation dispatch args", () => {
    expect(
      parseArgs([
        "--sha",
        "abc123",
        "--workflow-sha",
        "origin/main",
        "--target-ref",
        "release/2026.7.1",
        "--keep-branch",
        "--dry-run",
        "-f",
        "provider=anthropic",
        "--",
        "mode=linux",
      ]),
    ).toMatchObject({
      dryRun: true,
      keepBranch: true,
      inputs: {
        mode: "linux",
        provider: "anthropic",
        reuse_evidence: "true",
      },
      sha: "abc123",
      targetRef: "release/2026.7.1",
      workflowSha: "origin/main",
    });
  });

  it("accepts documented -f assignments after the option separator", () => {
    expect(
      parseArgs(["--", "-f", "release_profile=full", "-fmode=linux", "provider=anthropic"]).inputs,
    ).toMatchObject({
      mode: "linux",
      provider: "anthropic",
      release_profile: "full",
    });
    expect(() => parseArgs(["--", "-f"])).toThrow("-f requires a value");
  });

  it("infers the release profile from the target package version", () => {
    const readVersion = (version: string) => () => JSON.stringify({ version });

    expect(releaseProfileForTarget("a".repeat(40), readVersion("2026.7.1-beta.4"))).toBe("beta");
    expect(releaseProfileForTarget("a".repeat(40), readVersion("2026.7.1-alpha.4"))).toBe("beta");
    expect(releaseProfileForTarget("a".repeat(40), readVersion("2026.7.1"))).toBe("stable");
    expect(releaseProfileForTarget("a".repeat(40), readVersion("2026.7.1-1"))).toBe("stable");
  });

  it("keeps release context separate from the exact target SHA", () => {
    const source = readFileSync("scripts/full-release-validation-at-sha.mjs", "utf8");
    expect(source).toContain("ref: targetSha");
    expect(source).toContain("target_context_ref: targetContextRef");
    expect(source).toContain(
      'args.inputs.allow_unreleased_changelog ??= args.targetRef ? "false" : "true"',
    );
  });

  it("rejects missing option values", () => {
    expect(() => parseArgs(["--sha", "--dry-run"])).toThrow("--sha requires a value");
    expect(() => parseArgs(["--sha", "-h"])).toThrow("--sha requires a value");
    expect(() => parseArgs(["--workflow-sha", "--dry-run"])).toThrow(
      "--workflow-sha requires a value",
    );
    expect(() => parseArgs(["--workflow-sha", "-h"])).toThrow("--workflow-sha requires a value");
    expect(() => parseArgs(["--target-ref", "--dry-run"])).toThrow("--target-ref requires a value");
    expect(() => parseArgs(["-f", "--dry-run"])).toThrow("-f requires a value");
    expect(() => parseArgs(["-f", "-h"])).toThrow("-f requires a value");
  });

  it("accepts only canonical release branch or tag context", () => {
    expect(parseArgs(["--target-ref", "extended-stable/2026.6.33"]).targetRef).toBe(
      "extended-stable/2026.6.33",
    );
    expect(parseArgs(["--target-ref", "v2026.7.1-beta.5"]).targetRef).toBe("v2026.7.1-beta.5");
    expect(parseArgs(["--target-ref", "v2026.7.1"]).targetRef).toBe("v2026.7.1");
    expect(() => parseArgs(["--target-ref", "feature/not-release"])).toThrow(
      "canonical OpenClaw release branch or tag",
    );
  });

  it("resolves annotated release tags through their peeled commit", () => {
    const calls: string[][] = [];
    const sha = resolveRemoteTargetRefSha("v2026.7.1-beta.5", (args) => {
      calls.push(args);
      return `b6387afd6d2e0f43c2ae98d2d124dbc277f03cca\t${args.at(-1)}`;
    });
    expect(sha).toBe("b6387afd6d2e0f43c2ae98d2d124dbc277f03cca");
    expect(calls).toEqual([["ls-remote", "--tags", "origin", "refs/tags/v2026.7.1-beta.5^{}"]]);
  });

  it("falls back to the direct ref for lightweight release tags", () => {
    const calls: string[][] = [];
    const sha = resolveRemoteTargetRefSha("v2026.7.1", (args) => {
      calls.push(args);
      return args.at(-1)?.endsWith("^{}")
        ? ""
        : "0123456789abcdef0123456789abcdef01234567\trefs/tags/v2026.7.1";
    });
    expect(sha).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(calls).toEqual([
      ["ls-remote", "--tags", "origin", "refs/tags/v2026.7.1^{}"],
      ["ls-remote", "--tags", "origin", "refs/tags/v2026.7.1"],
    ]);
  });

  it("allows exact-target reuse to be disabled for a forced fresh run", () => {
    expect(parseArgs(["-f", "reuse_evidence=false"]).inputs.reuse_evidence).toBe("false");
    expect(() => parseArgs(["-f", "reuse_evidence=maybe"])).toThrow(
      "reuse_evidence must be true or false",
    );
    expect(() => parseArgs(["-f", "release_profile=minimum"])).toThrow(
      "release_profile must be beta, stable, or full",
    );
    expect(() => parseArgs(["-f", "allow_unreleased_changelog=maybe"])).toThrow(
      "allow_unreleased_changelog must be true or false",
    );
  });

  it("reserves the candidate ref for the resolved --sha", () => {
    expect(() => parseArgs(["-f", "ref=other"])).toThrow("reserves the ref input");
    expect(() => parseArgs(["--", "ref=other"])).toThrow("reserves the ref input");
  });

  it("validates direct and reused runs through the strict evidence verifier", () => {
    expect(releaseEvidenceVerificationArgs("123")).toEqual([
      "--validate-run",
      "123",
      "--trusted-workflow-ref",
      "main",
      "--json",
    ]);
    expect(() => releaseEvidenceVerificationArgs("")).toThrow("positive decimal");
  });

  it("selects the exact workflow run through GraphQL check-suite metadata", () => {
    const nodes = [
      {
        status: "COMPLETED",
        conclusion: "SUCCESS",
        workflowRun: { url: "https://github.com/openclaw/openclaw/actions/runs/122" },
      },
      {
        status: "IN_PROGRESS",
        conclusion: null,
        workflowRun: { url: "https://github.com/openclaw/openclaw/actions/runs/123" },
      },
    ];

    expect(selectWorkflowRunCheckSuite(nodes, "123")).toEqual(nodes[1]);
    expect(selectWorkflowRunCheckSuite(nodes, "999")).toBeUndefined();
    expect(() => selectWorkflowRunCheckSuite(nodes, "")).toThrow("positive decimal");

    const source = readFileSync("scripts/full-release-validation-at-sha.mjs", "utf8");
    expect(source).toContain("checkSuites(first: 100, after: $after)");
    expect(source).not.toContain('["run", "watch"');
  });

  it("supports current and legacy verifier locations in trusted workflow checkouts", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-verifier-path-"));
    try {
      const legacy = join(
        root,
        ".agents",
        "skills",
        "release-openclaw-ci",
        "scripts",
        "release-ci-summary.mjs",
      );
      mkdirSync(join(legacy, ".."), { recursive: true });
      writeFileSync(legacy, "");
      expect(releaseEvidenceVerifierPath(root)).toBe(legacy);

      const current = join(root, "scripts", "release-ci-summary.mjs");
      mkdirSync(join(current, ".."), { recursive: true });
      writeFileSync(current, "");
      expect(releaseEvidenceVerifierPath(root)).toBe(current);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
