import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertTrustedWorkflowHarness,
  FULL_RELEASE_WAIT_POLL_INTERVAL_MS,
  FULL_RELEASE_WAIT_TIMEOUT_MINUTES,
  parseArgs,
  releaseProfileForTarget,
  releaseEvidenceVerificationArgs,
  releaseEvidenceVerifierPath,
  resolveRemoteTargetRefSha,
  shouldDeleteTemporaryWorkflowRef,
} from "../../scripts/full-release-validation-at-sha.mts";

const SCRIPT_PATH = resolve("scripts/full-release-validation-at-sha.mjs");

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function createDispatchFixture(options: { workflowSource?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-release-dispatch-"));
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  const binDir = join(root, "bin");
  const gitCallsPath = join(root, "git-calls.jsonl");
  const ghCallsPath = join(root, "gh-calls.jsonl");
  const releaseRef = "release/2026.8.1";
  mkdirSync(checkout);
  mkdirSync(binDir);
  writeFileSync(gitCallsPath, "");
  writeFileSync(ghCallsPath, "");

  execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main"], { cwd: checkout, stdio: "ignore" });
  runGit(checkout, ["config", "user.email", "release-test@openclaw.invalid"]);
  runGit(checkout, ["config", "user.name", "OpenClaw Release Test"]);
  mkdirSync(join(checkout, ".github", "workflows"), { recursive: true });
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  writeFileSync(join(checkout, "package.json"), '{"version":"2026.8.1"}\n');
  writeFileSync(
    join(checkout, ".github", "workflows", "full-release-validation.yml"),
    options.workflowSource ??
      `name: Full Release Validation
on:
  workflow_dispatch:
    inputs:
      expected_sha:
        required: false
`,
  );
  writeFileSync(
    join(checkout, "scripts", "release-ci-summary.mjs"),
    `const expected = [
  "--validate-run", "123",
  "--trusted-workflow-ref", "main",
  "--json",
  "--verifier-source-sha", process.env.MOCK_WORKFLOW_SHA,
  "--verifier-source-file", process.argv[1],
];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) {
  console.error("unexpected verifier args: " + JSON.stringify(process.argv.slice(2)));
  process.exit(2);
}
console.log(JSON.stringify({ valid: true, current: { runId: "123" }, root: { runId: "123" }, evidenceReuse: false }));
`,
  );
  runGit(checkout, ["add", "."]);
  runGit(checkout, ["commit", "-m", "test: trusted workflow"]);
  const workflowSha = runGit(checkout, ["rev-parse", "HEAD"]);
  runGit(checkout, ["remote", "add", "origin", origin]);
  runGit(checkout, ["push", "-u", "origin", "main"]);
  runGit(checkout, ["checkout", "-b", releaseRef]);
  writeFileSync(join(checkout, "target.txt"), "release target\n");
  runGit(checkout, ["add", "target.txt"]);
  runGit(checkout, ["commit", "-m", "test: release target"]);
  const targetSha = runGit(checkout, ["rev-parse", "HEAD"]);
  runGit(checkout, ["push", "-u", "origin", releaseRef]);
  runGit(checkout, ["checkout", "main"]);

  const gitPath = join(binDir, "git");
  writeFileSync(
    gitPath,
    `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_GIT_CALLS, JSON.stringify(args) + "\\n");
const result = spawnSync("git", args, {
  env: { ...process.env, PATH: process.env.MOCK_REAL_PATH },
  stdio: "inherit",
});
process.exit(result.status ?? 1);
`,
  );
  chmodSync(gitPath, 0o755);

  const ghPath = join(binDir, "gh");
  writeFileSync(
    ghPath,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_GH_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "workflow" && args[1] === "run") {
  console.log("https://github.com/openclaw/openclaw/actions/runs/123");
} else if (args[0] === "api" && args.at(-1).endsWith("/actions/runs/123")) {
  console.log(JSON.stringify({ status: "completed", conclusion: "success", head_sha: process.env.MOCK_WORKFLOW_SHA }));
} else {
  console.error("unexpected gh call: " + args.join(" "));
  process.exit(2);
}
`,
  );
  chmodSync(ghPath, 0o755);

  const run = (extraArgs: string[] = []) =>
    spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--sha", targetSha, "--target-ref", releaseRef, ...extraArgs],
      {
        cwd: checkout,
        encoding: "utf8",
        env: {
          ...process.env,
          MOCK_GH_CALLS: ghCallsPath,
          MOCK_GIT_CALLS: gitCallsPath,
          MOCK_REAL_PATH: process.env.PATH,
          MOCK_WORKFLOW_SHA: workflowSha,
          PATH: `${binDir}:${process.env.PATH}`,
        },
      },
    );
  const readCalls = (path: string): string[][] =>
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);

  return {
    checkout,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    ghCallsPath,
    gitCallsPath,
    origin,
    readCalls,
    releaseRef,
    run,
    targetSha,
    workflowSha,
  };
}

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
        fail_fast: "false",
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
    expect(parseArgs(["-f", "fail_fast=true"]).inputs.fail_fast).toBe("true");
    expect(() => parseArgs(["-f", "fail_fast=maybe"])).toThrow("fail_fast must be true or false");
    expect(() => parseArgs(["-f", "release_profile=minimum"])).toThrow(
      "release_profile must be beta, stable, or full",
    );
    expect(() => parseArgs(["-f", "allow_unreleased_changelog=maybe"])).toThrow(
      "allow_unreleased_changelog must be true or false",
    );
  });

  it("reserves immutable candidate identity inputs for the resolved --sha", () => {
    expect(() => parseArgs(["-f", "ref=other"])).toThrow("reserves the ref input");
    expect(() => parseArgs(["--", "ref=other"])).toThrow("reserves the ref input");
    expect(() => parseArgs(["-f", `expected_sha=${"a".repeat(40)}`])).toThrow(
      "reserves expected_sha",
    );
    expect(() => parseArgs(["--", `expected_sha=${"a".repeat(40)}`])).toThrow(
      "reserves expected_sha",
    );
  });

  it("validates direct and reused runs through the strict evidence verifier", () => {
    const workflowSha = "a".repeat(40);
    const verifier = "/tmp/trusted/scripts/release-ci-summary.mjs";
    expect(releaseEvidenceVerificationArgs("123", workflowSha, verifier)).toEqual([
      "--validate-run",
      "123",
      "--trusted-workflow-ref",
      "main",
      "--json",
      "--verifier-source-sha",
      workflowSha,
      "--verifier-source-file",
      verifier,
    ]);
    expect(() => releaseEvidenceVerificationArgs("", workflowSha, verifier)).toThrow(
      "positive decimal",
    );
  });

  it("bounds polling for the exact workflow run", () => {
    const source = readFileSync("scripts/full-release-validation-at-sha.mts", "utf8");
    expect(FULL_RELEASE_WAIT_TIMEOUT_MINUTES).toBe(720);
    expect(FULL_RELEASE_WAIT_POLL_INTERVAL_MS).toBe(45_000);
    expect(source).toContain("workflowRun.head_sha !== workflowSha");
    expect(source).toContain("return suite;");
    expect(source).toContain("Date.now() + FULL_RELEASE_WAIT_TIMEOUT_MINUTES * 60_000");
    expect(source).toContain("const remainingMs = deadline - Date.now();");
    expect(source).toContain("Math.min(FULL_RELEASE_WAIT_POLL_INTERVAL_MS, remainingMs)");
    expect(source).toContain(
      "Timed out after ${FULL_RELEASE_WAIT_TIMEOUT_MINUTES} minutes waiting for Full Release Validation",
    );
    expect(source).not.toContain("attempt < 480");
  });

  it("bounds GitHub reads without applying a timeout to workflow dispatch", () => {
    const source = readFileSync("scripts/full-release-validation-at-sha.mts", "utf8");
    expect(source).toContain("timeout: GH_READ_TIMEOUT_MS");
    expect(source.match(/GH_READ_OPTIONS/gu)).toHaveLength(3);
    expect(source).toContain('const dispatchOutput = run("gh", dispatchArgs');
  });

  it("rejects incomplete trusted release harnesses before dispatch", () => {
    const workflowPath = ".github/workflows/full-release-validation.yml";
    const verifierPath = "scripts/release-ci-summary.mjs";
    const checked: string[] = [];
    expect(
      assertTrustedWorkflowHarness(
        "a".repeat(40),
        (relativePath) => {
          checked.push(relativePath);
          return relativePath === workflowPath || relativePath === verifierPath;
        },
        () => "on:\n  workflow_dispatch:\n    inputs:\n      expected_sha: {}\n",
      ),
    ).toBe(verifierPath);
    expect(checked).toEqual([workflowPath, verifierPath]);
    expect(() => assertTrustedWorkflowHarness("a".repeat(40), () => false)).toThrow(workflowPath);
    expect(() =>
      assertTrustedWorkflowHarness(
        "a".repeat(40),
        (relativePath) => relativePath === workflowPath,
        () => "on:\n  workflow_dispatch:\n    inputs:\n      expected_sha: {}\n",
      ),
    ).toThrow("supported release evidence verifier");
    expect(() =>
      assertTrustedWorkflowHarness(
        "b".repeat(40),
        () => true,
        () => "on:\n  workflow_dispatch:\n    inputs: {}\n",
      ),
    ).toThrow(`Tooling SHA ${"b".repeat(40)} is missing workflow_dispatch input expected_sha`);
  });

  it("retains a failed parent workflow ref for GitHub reruns", () => {
    expect(
      shouldDeleteTemporaryWorkflowRef({
        dryRun: false,
        evidenceVerified: false,
        keepBranch: false,
        parentConclusion: "failure",
      }),
    ).toBe(false);
    expect(
      shouldDeleteTemporaryWorkflowRef({
        dryRun: false,
        evidenceVerified: true,
        keepBranch: false,
        parentConclusion: "success",
      }),
    ).toBe(true);
    expect(
      shouldDeleteTemporaryWorkflowRef({
        dryRun: true,
        evidenceVerified: false,
        keepBranch: false,
        parentConclusion: "",
      }),
    ).toBe(true);
    expect(
      shouldDeleteTemporaryWorkflowRef({
        dryRun: false,
        evidenceVerified: false,
        keepBranch: false,
        parentConclusion: "success",
      }),
    ).toBe(false);
  });

  it("pushes an exact target ref, dispatches it, prints the run URL, and cleans both refs", () => {
    const fixture = createDispatchFixture();
    try {
      const result = fixture.run();
      expect(result.status, result.stderr).toBe(0);
      const gitCalls = fixture.readCalls(fixture.gitCallsPath);
      const ghCalls = fixture.readCalls(fixture.ghCallsPath);
      const targetPush = gitCalls.find(
        (args) => args[0] === "push" && args[2]?.includes(":refs/heads/validation/target-"),
      );
      expect(targetPush?.[2]).toMatch(
        new RegExp(
          `^${fixture.targetSha}:refs/heads/validation/target-${fixture.targetSha.slice(0, 12)}-[0-9]+$`,
          "u",
        ),
      );
      const targetBranch = targetPush?.[2]?.split(":refs/heads/")[1];
      const workflowPush = gitCalls.find(
        (args) => args[0] === "push" && args[2]?.includes(":refs/heads/release-ci/"),
      );
      const workflowBranch = workflowPush?.[2]?.split(":refs/heads/")[1];
      expect(workflowPush?.[2]).toMatch(
        new RegExp(
          `^${fixture.workflowSha}:refs/heads/release-ci/${fixture.workflowSha.slice(0, 12)}-[0-9]+$`,
          "u",
        ),
      );
      const dispatch = ghCalls.find((args) => args[0] === "workflow" && args[1] === "run");
      expect(dispatch?.slice(0, 5)).toEqual([
        "workflow",
        "run",
        "full-release-validation.yml",
        "--ref",
        workflowBranch,
      ]);
      const inputArgs = dispatch?.slice(5) ?? [];
      expect(inputArgs.length % 2).toBe(0);
      const dispatchInputs: Record<string, string> = {};
      for (let index = 0; index < inputArgs.length; index += 2) {
        expect(inputArgs[index]).toBe("-f");
        const assignment = inputArgs[index + 1];
        const separatorIndex = assignment?.indexOf("=") ?? -1;
        if (!assignment || separatorIndex <= 0) {
          throw new Error(`invalid workflow input assignment: ${String(assignment)}`);
        }
        dispatchInputs[assignment.slice(0, separatorIndex)] = assignment.slice(separatorIndex + 1);
      }
      expect(dispatchInputs).toMatchObject({
        ref: targetBranch,
        expected_sha: fixture.targetSha,
        target_context_ref: fixture.releaseRef,
        allow_unreleased_changelog: "false",
      });
      expect(ghCalls).toContainEqual(["api", "repos/openclaw/openclaw/actions/runs/123"]);
      expect(ghCalls.some((args) => args[0] === "graphql")).toBe(false);
      expect(ghCalls.some((args) => args[0] === "run" && args[1] === "watch")).toBe(false);
      expect(result.stdout).toContain(`Validation SHA: ${fixture.targetSha}`);
      expect(result.stdout).toContain(`Tooling SHA: ${fixture.workflowSha}`);
      expect(result.stdout).toContain(
        "Parent run: https://github.com/openclaw/openclaw/actions/runs/123",
      );
      expect(result.stdout.indexOf("Parent run:")).toBeLessThan(
        result.stdout.indexOf("Parent run status:"),
      );
      expect(gitCalls).toContainEqual([
        "push",
        "origin",
        `:refs/heads/${workflowBranch}`,
        `:refs/heads/${targetBranch}`,
      ]);
      expect(runGit(fixture.origin, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(
        "refs/heads/main\nrefs/heads/release/2026.8.1",
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects pinned old-schema tooling before either remote ref is pushed", () => {
    const fixture = createDispatchFixture({
      workflowSource: "name: Full Release Validation\non:\n  workflow_dispatch:\n",
    });
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Tooling SHA ${fixture.workflowSha}`);
      expect(result.stderr).toContain("missing workflow_dispatch input expected_sha");
      expect(fixture.readCalls(fixture.gitCallsPath).filter((args) => args[0] === "push")).toEqual(
        [],
      );
      expect(readFileSync(fixture.ghCallsPath, "utf8")).toBe("");
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps both temporary refs with --keep-branch", () => {
    const fixture = createDispatchFixture();
    try {
      const result = fixture.run(["--keep-branch"]);
      expect(result.status, result.stderr).toBe(0);
      const gitCalls = fixture.readCalls(fixture.gitCallsPath);
      expect(
        gitCalls.some(
          (args) => args[0] === "push" && args.slice(2).some((value) => value.startsWith(":")),
        ),
      ).toBe(false);
      const remoteRefs = runGit(fixture.origin, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/release-ci",
        "refs/heads/validation",
      ]).split("\n");
      expect(remoteRefs).toHaveLength(2);
      expect(remoteRefs).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^refs\/heads\/release-ci\//u),
          expect.stringMatching(/^refs\/heads\/validation\/target-/u),
        ]),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("fails clearly before dispatch when the target SHA is absent after the named fetch", () => {
    const fixture = createDispatchFixture();
    try {
      const missingSha = "f".repeat(40);
      const result = spawnSync(
        process.execPath,
        [SCRIPT_PATH, "--sha", missingSha, "--target-ref", fixture.releaseRef],
        {
          cwd: fixture.checkout,
          encoding: "utf8",
          env: {
            ...process.env,
            MOCK_GH_CALLS: fixture.ghCallsPath,
            MOCK_GIT_CALLS: fixture.gitCallsPath,
            MOCK_REAL_PATH: process.env.PATH,
            MOCK_WORKFLOW_SHA: fixture.workflowSha,
            PATH: `${join(fixture.checkout, "..", "bin")}:${process.env.PATH}`,
          },
        },
      );
      expect(result.status).toBe(1);
      const failedReasons = result.stderr
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("[full-release-validation] FAILED:"));
      expect(failedReasons).toEqual([
        `[full-release-validation] FAILED: Target SHA ${missingSha} is not available locally after fetching ${fixture.releaseRef}`,
      ]);
      expect(result.stderr.trim().split("\n").at(-1)).toBe(
        "[full-release-validation] FAILED (exit 1)",
      );
      expect(readFileSync(fixture.ghCallsPath, "utf8")).toBe("");
    } finally {
      fixture.cleanup();
    }
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
