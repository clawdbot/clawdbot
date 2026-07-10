// Covers the release validation evidence-reuse resolver used by
// full-release-validation.yml to skip lanes on release-metadata-only deltas.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = join(process.cwd(), "scripts/github/find-reusable-release-validation.sh");
const tempDirs = createTempDirTracker();

afterEach(() => {
  tempDirs.cleanup();
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitFile(repo: string, filePath: string, content: string, message: string): string {
  writeFileSync(join(repo, filePath), content);
  git(repo, ["add", filePath]);
  git(repo, ["-c", "commit.gpgSign=false", "commit", "-qm", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function plistFor(shortVersion: string, buildVersion: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    "<dict>",
    "    <key>CFBundleShortVersionString</key>",
    `    <string>${shortVersion}</string>`,
    "    <key>CFBundleVersion</key>",
    `    <string>${buildVersion}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function createRepoPair(options: { plistBuildVersion?: string } = {}) {
  const origin = tempDirs.make("evidence-reuse-origin-");
  git(origin, ["init", "-q", "-b", "main"]);
  git(origin, ["config", "user.email", "test-user"]);
  git(origin, ["config", "user.name", "Test User"]);
  // Allows depth-1 fetches of the prior evidence SHA, matching GitHub remotes.
  git(origin, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);
  writeFileSync(
    join(origin, "package.json"),
    `${JSON.stringify({ name: "x", version: "2026.7.1" }, null, 2)}\n`,
  );
  mkdirSync(join(origin, "apps/macos/Sources/OpenClaw/Resources"), { recursive: true });
  writeFileSync(
    join(origin, "apps/macos/Sources/OpenClaw/Resources/Info.plist"),
    plistFor("2026.7.1", options.plistBuildVersion ?? "2026070100"),
  );
  writeFileSync(join(origin, "CHANGELOG.md"), "# Changelog\n");
  writeFileSync(join(origin, "index.ts"), "export const value = 1;\n");
  git(origin, ["add", "-A"]);
  git(origin, ["-c", "commit.gpgSign=false", "commit", "-qm", "seed"]);
  const priorSha = git(origin, ["rev-parse", "HEAD"]);
  return { origin, priorSha };
}

function cloneHead(origin: string): string {
  const clone = tempDirs.make("evidence-reuse-clone-");
  execFileSync("git", ["clone", "-q", "--depth=1", origin, clone], { encoding: "utf8" });
  return clone;
}

const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
[[ "\${1:-}" == "api" ]] || { echo "unexpected gh command: $*" >&2; exit 1; }
shift
jq_expr=""
endpoint=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -X|-F) shift 2 ;;
    --jq) jq_expr="$2"; shift 2 ;;
    *) [[ -n "$endpoint" ]] || endpoint="$1"; shift ;;
  esac
done
fixture="\${FAKE_GH_FIXTURES}/$(printf '%s' "$endpoint" | tr '/?' '__')"
if [[ "$endpoint" == */zip ]]; then
  [[ -f "\${fixture}.bin" ]] || { echo "no fixture for $endpoint" >&2; exit 1; }
  exec cat "\${fixture}.bin"
fi
[[ -f "\${fixture}.json" ]] || { echo "no fixture for $endpoint" >&2; exit 1; }
if [[ -n "$jq_expr" ]]; then
  exec jq -r "$jq_expr" "\${fixture}.json"
fi
exec cat "\${fixture}.json"
`;

interface FixtureOptions {
  runId?: string;
  headSha: string;
  manifest?: Record<string, unknown>;
  compare?: { base: string; head: string; status: string; files: string[] } | undefined;
  childRunStates?: Record<string, string>;
}

function setUpFixtures(options: FixtureOptions): { fixtures: string; binDir: string } {
  const runId = options.runId ?? "111";
  const root = tempDirs.make("evidence-reuse-fixtures-");
  const fixtures = join(root, "fixtures");
  const binDir = join(root, "bin");
  mkdirSync(fixtures, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "gh"), FAKE_GH);
  chmodSync(join(binDir, "gh"), 0o755);

  writeFileSync(
    join(
      fixtures,
      "repos_openclaw_openclaw_actions_workflows_full-release-validation.yml_runs.json",
    ),
    JSON.stringify({
      workflow_runs: [
        {
          id: Number(runId),
          html_url: `https://example.test/runs/${runId}`,
          head_sha: options.headSha,
        },
      ],
    }),
  );
  if (options.manifest) {
    writeFileSync(
      join(fixtures, `repos_openclaw_openclaw_actions_runs_${runId}_artifacts_per_page=100.json`),
      JSON.stringify({
        artifacts: [{ id: 999, name: `full-release-validation-${runId}`, expired: false }],
      }),
    );
    const manifestDir = join(root, "manifest");
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      join(manifestDir, "full-release-validation-manifest.json"),
      JSON.stringify(options.manifest),
    );
    execFileSync(
      "zip",
      [
        "-q",
        "-j",
        join(root, "manifest.zip"),
        join(manifestDir, "full-release-validation-manifest.json"),
      ],
      {
        encoding: "utf8",
      },
    );
    execFileSync("cp", [
      join(root, "manifest.zip"),
      join(fixtures, "repos_openclaw_openclaw_actions_artifacts_999_zip.bin"),
    ]);
  }
  if (options.compare) {
    writeFileSync(
      join(
        fixtures,
        `repos_openclaw_openclaw_compare_${options.compare.base}...${options.compare.head}.json`,
      ),
      JSON.stringify({
        status: options.compare.status,
        files: options.compare.files.map((filename) => ({ filename })),
      }),
    );
  }
  for (const [childRunId, state] of Object.entries(options.childRunStates ?? {})) {
    const [status, conclusion] = state.split("/");
    writeFileSync(
      join(fixtures, `repos_openclaw_openclaw_actions_runs_${childRunId}.json`),
      JSON.stringify({ status, conclusion }),
    );
  }
  return { fixtures, binDir };
}

const DEFAULT_INPUTS = {
  provider: "openai",
  mode: "both",
  liveSuiteFilter: "",
  crossOsSuiteFilter: "",
  releasePackageSpec: "",
  packageAcceptancePackageSpec: "",
  codexPluginSpec: "",
};

function runResolver(args: {
  repoDir: string;
  targetSha: string;
  workflowSha: string;
  releaseProfile: string;
  runReleaseSoak?: string;
  inputs?: Record<string, string>;
  fixtures: string;
  binDir: string;
}) {
  return spawnSync(
    "bash",
    [
      SCRIPT_PATH,
      "--target-sha",
      args.targetSha,
      "--workflow-sha",
      args.workflowSha,
      "--release-profile",
      args.releaseProfile,
      "--run-release-soak",
      args.runReleaseSoak ?? "false",
      "--inputs-json",
      JSON.stringify(args.inputs ?? DEFAULT_INPUTS),
      "--repo",
      "openclaw/openclaw",
      "--repo-dir",
      args.repoDir,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${args.binDir}:${process.env.PATH}`,
        FAKE_GH_FIXTURES: args.fixtures,
        GITHUB_OUTPUT: "",
      },
    },
  );
}

function parseOutput(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function manifestFor(targetSha: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    workflowName: "Full Release Validation",
    runId: "111",
    rerunGroup: "all",
    releaseProfile: "stable",
    runReleaseSoak: "true",
    targetSha,
    validationInputs: DEFAULT_INPUTS,
    childRuns: { normalCi: "201", productPerformance: { runId: "202" } },
    ...overrides,
  };
}

const HEALTHY_CHILDREN = { "201": "completed/success", "202": "completed/success" };

describe("scripts/github/find-reusable-release-validation.sh", () => {
  it("reuses evidence when the delta is release-metadata-only", () => {
    const { origin, priorSha } = createRepoPair();
    const targetSha = commitFile(
      origin,
      "CHANGELOG.md",
      "# Changelog\n\n- entry\n",
      "docs(changelog): refresh",
    );
    const clone = cloneHead(origin);
    // The candidate ran when the branch was at priorSha; the current dispatch
    // runs from the branch tip, so the harness delta equals the target delta.
    const { fixtures, binDir } = setUpFixtures({
      headSha: priorSha,
      manifest: manifestFor(priorSha),
      compare: { base: priorSha, head: targetSha, status: "ahead", files: ["CHANGELOG.md"] },
      childRunStates: HEALTHY_CHILDREN,
    });

    const result = runResolver({
      repoDir: clone,
      targetSha,
      workflowSha: targetSha,
      releaseProfile: "stable",
      fixtures,
      binDir,
    });
    expect(result.status).toBe(0);
    const output = parseOutput(result.stdout);
    expect(output).toMatchObject({
      reuse: "true",
      evidence_run_id: "111",
      evidence_root_run_id: "111",
      evidence_sha: priorSha,
      changed_path_count: "1",
      changed_paths: "CHANGELOG.md",
    });
    expect(JSON.parse(output.evidence_manifest ?? "{}")).toMatchObject({ targetSha: priorSha });
  });

  it("reuses identical targets without comparing and resolves the chain root", () => {
    const { origin, priorSha } = createRepoPair();
    const clone = cloneHead(origin);
    // No compare fixture: an identical target must not hit the compare API.
    const { fixtures, binDir } = setUpFixtures({
      headSha: priorSha,
      manifest: manifestFor(priorSha, { evidenceReuse: { runId: "42" } }),
      childRunStates: HEALTHY_CHILDREN,
    });

    const result = runResolver({
      repoDir: clone,
      targetSha: priorSha,
      workflowSha: priorSha,
      releaseProfile: "stable",
      fixtures,
      binDir,
    });
    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toMatchObject({
      reuse: "true",
      evidence_run_id: "111",
      evidence_root_run_id: "42",
      changed_path_count: "0",
    });
  });

  it("rejects deltas that touch non-metadata paths", () => {
    const { origin, priorSha } = createRepoPair();
    const targetSha = commitFile(
      origin,
      "index.ts",
      "export const value = 2;\n",
      "fix: change code",
    );
    const clone = cloneHead(origin);
    const { fixtures, binDir } = setUpFixtures({
      headSha: priorSha,
      manifest: manifestFor(priorSha),
      compare: { base: priorSha, head: targetSha, status: "ahead", files: ["index.ts"] },
    });

    // The candidate harness matches the pinned workflow SHA; only the target
    // delta is non-metadata here.
    const result = runResolver({
      repoDir: clone,
      targetSha,
      workflowSha: priorSha,
      releaseProfile: "stable",
      fixtures,
      binDir,
    });
    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toMatchObject({ reuse: "false" });
  });

  it("rejects evidence from a narrower release profile or diverged history", () => {
    const { origin, priorSha } = createRepoPair();
    const targetSha = commitFile(
      origin,
      "CHANGELOG.md",
      "# Changelog\n\n- entry\n",
      "docs(changelog): refresh",
    );
    const clone = cloneHead(origin);

    const beta = setUpFixtures({
      headSha: priorSha,
      manifest: manifestFor(priorSha, { releaseProfile: "beta" }),
    });
    const betaResult = runResolver({
      repoDir: clone,
      targetSha,
      workflowSha: priorSha,
      releaseProfile: "stable",
      fixtures: beta.fixtures,
      binDir: beta.binDir,
    });
    expect(betaResult.status).toBe(0);
    expect(parseOutput(betaResult.stdout)).toMatchObject({ reuse: "false" });

    const diverged = setUpFixtures({
      headSha: priorSha,
      manifest: manifestFor(priorSha),
      compare: { base: priorSha, head: targetSha, status: "diverged", files: ["CHANGELOG.md"] },
    });
    const divergedResult = runResolver({
      repoDir: clone,
      targetSha,
      workflowSha: priorSha,
      releaseProfile: "stable",
      fixtures: diverged.fixtures,
      binDir: diverged.binDir,
    });
    expect(divergedResult.status).toBe(0);
    expect(parseOutput(divergedResult.stdout)).toMatchObject({ reuse: "false" });
  });

  it("rejects evidence recorded for different lane-selection inputs", () => {
    const { origin, priorSha } = createRepoPair();
    const clone = cloneHead(origin);
    const { fixtures, binDir } = setUpFixtures({
      headSha: priorSha,
      manifest: manifestFor(priorSha, {
        validationInputs: { ...DEFAULT_INPUTS, provider: "anthropic" },
      }),
      childRunStates: HEALTHY_CHILDREN,
    });

    const result = runResolver({
      repoDir: clone,
      targetSha: priorSha,
      workflowSha: priorSha,
      releaseProfile: "stable",
      fixtures,
      binDir,
    });
    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toMatchObject({ reuse: "false" });
  });

  it("rejects evidence whose recorded child runs are no longer green", () => {
    const { origin, priorSha } = createRepoPair();
    const clone = cloneHead(origin);
    const { fixtures, binDir } = setUpFixtures({
      headSha: priorSha,
      manifest: manifestFor(priorSha),
      childRunStates: { "201": "completed/failure", "202": "completed/success" },
    });

    const result = runResolver({
      repoDir: clone,
      targetSha: priorSha,
      workflowSha: priorSha,
      releaseProfile: "stable",
      fixtures,
      binDir,
    });
    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toMatchObject({ reuse: "false" });
  });

  it("rejects evidence whose harness differs beyond release metadata", () => {
    const { origin, priorSha } = createRepoPair();
    git(origin, ["checkout", "-q", "-b", "harness-drift"]);
    const driftSha = commitFile(
      origin,
      "index.ts",
      "export const value = 3;\n",
      "ci: change harness logic",
    );
    git(origin, ["checkout", "-q", "main"]);
    const clone = cloneHead(origin);
    const { fixtures, binDir } = setUpFixtures({
      headSha: driftSha,
      manifest: manifestFor(priorSha),
      childRunStates: HEALTHY_CHILDREN,
    });

    const result = runResolver({
      repoDir: clone,
      targetSha: priorSha,
      workflowSha: priorSha,
      releaseProfile: "stable",
      fixtures,
      binDir,
    });
    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toMatchObject({ reuse: "false" });
  });

  it("rejects targets whose version stamps are internally inconsistent", () => {
    const { origin, priorSha } = createRepoPair({ plistBuildVersion: "2026061000" });
    const clone = cloneHead(origin);
    const { fixtures, binDir } = setUpFixtures({
      headSha: priorSha,
      manifest: manifestFor(priorSha),
      childRunStates: HEALTHY_CHILDREN,
    });

    const result = runResolver({
      repoDir: clone,
      targetSha: priorSha,
      workflowSha: priorSha,
      releaseProfile: "stable",
      fixtures,
      binDir,
    });
    expect(result.status).toBe(0);
    const output = parseOutput(result.stdout);
    expect(output.reuse).toBe("false");
    expect(output.reuse_reason).toContain("version metadata");
  });

  it("reports no reuse when no prior runs or manifests exist", () => {
    const { origin, priorSha } = createRepoPair();
    const clone = cloneHead(origin);
    const { fixtures, binDir } = setUpFixtures({ headSha: priorSha });

    const result = runResolver({
      repoDir: clone,
      targetSha: priorSha,
      workflowSha: priorSha,
      releaseProfile: "beta",
      fixtures,
      binDir,
    });
    expect(result.status).toBe(0);
    const output = parseOutput(result.stdout);
    expect(output.reuse).toBe("false");
    expect(output.reuse_reason).toContain("no prior validation run covers");
  });
});
