// Ci Workflow Guards tests cover ci workflow guards script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { NATIVE_I18N_LOCALES } from "../../scripts/native-app-i18n.ts";
import { SUPPORTED_LOCALES } from "../../ui/src/i18n/lib/registry.ts";

const CHECKOUT_V6 = "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10";
const CACHE_V5 = "actions/cache/restore@27d5ce7f107fe9357f9df03efb73ab90386fccae";
const SETUP_GO_V6 = "actions/setup-go@4a3601121dd01d1626a1e23e37211e3254c1c06c";
const UPLOAD_ARTIFACT_V7 = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD_ARTIFACT_V8 = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const CREATE_GITHUB_APP_TOKEN_V3 =
  "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1";
const OPENGREP_PR_DIFF_WORKFLOW = ".github/workflows/opengrep-precise.yml";
const OPENGREP_FULL_WORKFLOW = ".github/workflows/opengrep-precise-full.yml";
const CONTROL_UI_LOCALE_REFRESH_WORKFLOW = ".github/workflows/control-ui-locale-refresh.yml";
const NATIVE_APP_LOCALE_REFRESH_WORKFLOW = ".github/workflows/native-app-locale-refresh.yml";
const CREATE_GENERATED_PR_TOKENS_ACTION = ".github/actions/create-generated-pr-tokens/action.yml";
const PUBLISH_GENERATED_PR_ACTION = ".github/actions/publish-generated-pr/action.yml";
const MATURITY_SCORECARD_WORKFLOW = ".github/workflows/maturity-scorecard.yml";
const MATURITY_SCORECARD_WORKFLOW_REF =
  "openclaw/openclaw/.github/workflows/maturity-scorecard.yml@refs/heads/main";
const OIDC_BOUND_MAIN_REUSABLE_WORKFLOWS = new Set<string>();
const MATURITY_GENERATED_PR_PATHS = [
  "qa/maturity-scores.yaml",
  "docs/maturity/scorecard.md",
  "docs/maturity/taxonomy.md",
];

function readCiWorkflow() {
  return parse(readFileSync(".github/workflows/ci.yml", "utf8"));
}

function readAndroidReleaseWorkflow() {
  return parse(readFileSync(".github/workflows/android-release.yml", "utf8"));
}

function readBuildArtifactsTestboxWorkflow() {
  return parse(readFileSync(".github/workflows/ci-build-artifacts-testbox.yml", "utf8"));
}

function readTestboxWorkflow() {
  return parse(readFileSync(".github/workflows/ci-check-testbox.yml", "utf8"));
}

function readWorkflowSanityWorkflow() {
  return parse(readFileSync(".github/workflows/workflow-sanity.yml", "utf8"));
}

function readRealBehaviorProofWorkflow() {
  return parse(readFileSync(".github/workflows/real-behavior-proof.yml", "utf8"));
}

function readMaturityScorecardWorkflow() {
  return parse(readFileSync(MATURITY_SCORECARD_WORKFLOW, "utf8"));
}

function runMaturityInvocationScenario(options: {
  callerEventName: string;
  callerWorkflowRef: string;
  jobWorkflowRef?: string;
  publishPullRequest: boolean;
}) {
  const workflow = readMaturityScorecardWorkflow();
  const authorizeStep = workflow.jobs.validate_selected_ref.steps.find(
    (step: { name?: string }) => step.name === "Authorize workflow invocation",
  );
  const authorizeRun = spawnSync("bash", ["-c", authorizeStep.run], {
    encoding: "utf8",
    env: {
      CALLER_EVENT_NAME: options.callerEventName,
      CALLER_WORKFLOW_REF: options.callerWorkflowRef,
      JOB_WORKFLOW_FILE_PATH: MATURITY_SCORECARD_WORKFLOW,
      JOB_WORKFLOW_REF: options.jobWorkflowRef ?? MATURITY_SCORECARD_WORKFLOW_REF,
      JOB_WORKFLOW_REPOSITORY: "openclaw/openclaw",
      PATH: process.env.PATH ?? "",
      PUBLISH_PULL_REQUEST: String(options.publishPullRequest),
    },
  });
  return {
    output: `${authorizeRun.stdout}${authorizeRun.stderr}`,
    status: authorizeRun.status,
  };
}

function runMaturityArtifactCopyScenario(
  options: { destinationSymlink?: boolean; extraFile?: boolean; sourceSymlink?: boolean } = {},
) {
  const workflow = readMaturityScorecardWorkflow();
  const copyStep = workflow.jobs.publish_generated_pr.steps.find(
    (step: { name?: string }) => step.name === "Validate and copy generated PR files",
  );
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-maturity-copy-"));
  const staging = path.join(root, "staging");
  try {
    for (const generatedPath of MATURITY_GENERATED_PR_PATHS) {
      const staged = path.join(staging, generatedPath);
      const selected = path.join(root, "selected", generatedPath);
      mkdirSync(path.dirname(staged), { recursive: true });
      mkdirSync(path.dirname(selected), { recursive: true });
      writeFileSync(staged, `new ${generatedPath}\n`, "utf8");
      writeFileSync(selected, `old ${generatedPath}\n`, "utf8");
    }
    if (options.extraFile) {
      writeFileSync(path.join(staging, "unexpected.txt"), "unexpected\n", "utf8");
    }
    if (options.sourceSymlink) {
      const staged = path.join(staging, MATURITY_GENERATED_PR_PATHS[0]);
      rmSync(staged);
      symlinkSync("missing-score-source", staged);
    }
    const escaped = path.join(root, "escaped.txt");
    if (options.destinationSymlink) {
      const selected = path.join(root, "selected", MATURITY_GENERATED_PR_PATHS[0]);
      writeFileSync(escaped, "outside\n", "utf8");
      rmSync(selected);
      symlinkSync(escaped, selected);
    }
    const run = spawnSync("bash", ["-c", copyStep.run], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", STAGING_DIR: staging },
    });
    return {
      copied: MATURITY_GENERATED_PR_PATHS.map((generatedPath) =>
        readFileSync(path.join(root, "selected", generatedPath), "utf8"),
      ),
      escaped: existsSync(escaped) ? readFileSync(escaped, "utf8") : "",
      output: `${run.stdout}${run.stderr}`,
      status: run.status,
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function readQaProfileEvidenceWorkflow() {
  return parse(readFileSync(".github/workflows/qa-profile-evidence.yml", "utf8"));
}

function readReleaseChecksWorkflow() {
  return parse(readFileSync(".github/workflows/openclaw-release-checks.yml", "utf8"));
}

function readCriticalQualityWorkflow() {
  return readFileSync(".github/workflows/codeql-critical-quality.yml", "utf8");
}

function readTrackedText(relativePath: string): string {
  if (existsSync(relativePath)) {
    return readFileSync(relativePath, "utf8");
  }
  return execFileSync("git", ["show", `:${relativePath}`], { encoding: "utf8" });
}

function readAndroidCompileSdk(relativePath: string): number {
  const match = readTrackedText(relativePath).match(/^\s*compileSdk\s*=\s*(\d+)\s*$/mu);
  if (!match) {
    throw new Error(`Missing compileSdk in ${relativePath}`);
  }
  return Number(match[1]);
}

function findYamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return findYamlFiles(path);
    }
    return entry.isFile() && /\.ya?ml$/u.test(entry.name) ? [path] : [];
  });
}

function findUnpinnedExternalActions(): string[] {
  const violations: string[] = [];
  for (const workflowPath of [
    ...findYamlFiles(".github/workflows"),
    ...findYamlFiles(".github/actions"),
  ]) {
    for (const [index, line] of readFileSync(workflowPath, "utf8").split("\n").entries()) {
      const uses = line.match(/^\s*(?:-\s*)?uses:\s*([^#\s]+)/u)?.[1];
      if (
        !uses ||
        uses.startsWith("./") ||
        uses.startsWith("docker://") ||
        OIDC_BOUND_MAIN_REUSABLE_WORKFLOWS.has(uses)
      ) {
        continue;
      }
      const at = uses.lastIndexOf("@");
      if (at < 1 || !/^[a-f0-9]{40}$/u.test(uses.slice(at + 1))) {
        violations.push(`${workflowPath}:${index + 1}: ${uses}`);
      }
    }
  }
  return violations;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeExecutable(filePath: string, lines: string[]): void {
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  chmodSync(filePath, 0o755);
}

function runGeneratedPublisherScenario(
  baseChangePath: "a" | "b" | null,
  options: {
    existingPr?: boolean;
    expectFailure?: boolean;
    noGeneratedChange?: boolean;
    overlapPolicy?: string;
    stalePrHeadOnce?: boolean;
    updateSource?: boolean;
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-generated-pr-"));
  try {
    const origin = path.join(root, "origin.git");
    const updater = path.join(root, "updater");
    const worktree = path.join(root, "worktree");
    const generatedDir = path.join(worktree, "generated");
    const sourceDir = path.join(worktree, "source");
    const fakeBin = path.join(root, "bin");
    const runnerTemp = path.join(root, "runner-temp");
    const prState = path.join(root, "pr-open");
    const stalePrHeadOnce = path.join(root, "stale-pr-head-once");
    const summary = path.join(root, "summary.md");

    mkdirSync(generatedDir, { recursive: true });
    mkdirSync(sourceDir);
    mkdirSync(fakeBin);
    mkdirSync(runnerTemp);
    writeFileSync(summary, "", "utf8");
    if (options.stalePrHeadOnce) {
      writeFileSync(stalePrHeadOnce, "", "utf8");
    }
    runGit(root, ["init", "--bare", origin]);
    runGit(root, ["init", "--initial-branch=main", worktree]);
    runGit(worktree, ["config", "user.name", "Test Publisher"]);
    runGit(worktree, ["config", "user.email", "publisher@example.com"]);
    writeFileSync(path.join(generatedDir, "a.txt"), "old-a\n", "utf8");
    writeFileSync(path.join(generatedDir, "b.txt"), "old-b\n", "utf8");
    writeFileSync(path.join(sourceDir, "input.txt"), "old-input\n", "utf8");
    runGit(worktree, ["add", "generated", "source"]);
    runGit(worktree, ["commit", "-m", "base"]);
    runGit(worktree, ["remote", "add", "origin", origin]);
    runGit(worktree, ["push", "-u", "origin", "main"]);
    runGit(root, ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"]);
    if (options.existingPr) {
      runGit(worktree, ["switch", "-c", "automation/locale"]);
      writeFileSync(path.join(generatedDir, "a.txt"), "stale-pr-a\n", "utf8");
      runGit(worktree, ["add", "generated"]);
      runGit(worktree, ["commit", "-m", "stale generated pull request"]);
      runGit(worktree, ["push", "-u", "origin", "automation/locale"]);
      writeFileSync(prState, "", "utf8");
      runGit(worktree, ["switch", "main"]);
    }
    runGit(root, ["clone", "--branch", "main", origin, updater]);
    runGit(updater, ["config", "user.name", "Base Updater"]);
    runGit(updater, ["config", "user.email", "updater@example.com"]);
    if (baseChangePath !== null) {
      writeFileSync(
        path.join(updater, "generated", `${baseChangePath}.txt`),
        `newer-${baseChangePath}\n`,
        "utf8",
      );
    }
    if (options.updateSource) {
      writeFileSync(path.join(updater, "source", "input.txt"), "newer-input\n", "utf8");
    }
    if (baseChangePath !== null || options.updateSource) {
      runGit(updater, ["add", "generated", "source"]);
      runGit(updater, ["commit", "-m", "update base"]);
      runGit(updater, ["push", "origin", "main"]);
    }
    if (!options.noGeneratedChange) {
      writeFileSync(path.join(generatedDir, "a.txt"), "desired-a\n", "utf8");
    }

    writeExecutable(path.join(fakeBin, "timeout"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'while [[ "$#" -gt 0 ]]; do',
      '  case "$1" in',
      "    --signal=*|--kill-after=*) shift ;;",
      "    [0-9]*s) shift; break ;;",
      "    *) break ;;",
      "  esac",
      "done",
      'exec "$@"',
    ]);
    writeExecutable(path.join(fakeBin, "gh"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'case "${1-}:${2-}" in',
      "  auth:setup-git) exit 0 ;;",
      "  api:*)",
      '    if [[ -f "$FAKE_PR_STATE" ]]; then',
      '      if [[ -f "$FAKE_STALE_HEAD_ONCE" ]]; then',
      '        head="0000000000000000000000000000000000000000"',
      '        rm -f "$FAKE_STALE_HEAD_ONCE"',
      "      else",
      '        head="$(git --git-dir="$FAKE_ORIGIN" rev-parse refs/heads/automation/locale)"',
      "      fi",
      '      printf "https://github.com/openclaw/openclaw/pull/1\\t%s\\n" "$head"',
      "    fi",
      "    ;;",
      "  pr:create)",
      '    : > "$FAKE_PR_STATE"',
      '    printf "%s\\n" "https://github.com/openclaw/openclaw/pull/1"',
      "    ;;",
      "  pr:edit) exit 0 ;;",
      '  *) printf "unexpected gh call: %s\\n" "$*" >&2; exit 2 ;;',
      "esac",
    ]);

    const action = parse(readFileSync(PUBLISH_GENERATED_PR_ACTION, "utf8"));
    const publishRun = action.runs.steps.find(
      (step: { name?: string }) => step.name === "Publish generated pull request",
    ).run;
    const publish = spawnSync("bash", ["-c", publishRun], {
      cwd: worktree,
      encoding: "utf8",
      env: {
        ...process.env,
        BASE_BRANCH: "main",
        COMMIT_MESSAGE: "chore(test): refresh generated output",
        FAKE_ORIGIN: origin,
        FAKE_PR_STATE: prState,
        FAKE_STALE_HEAD_ONCE: stalePrHeadOnce,
        GENERATED_PATHS: "generated",
        INVALIDATION_PATHS: "source",
        OVERLAP_POLICY: options.overlapPolicy ?? "defer",
        CONTENTS_TOKEN: "contents-token",
        GH_TOKEN: "test-token",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_REPOSITORY_OWNER: "openclaw",
        GITHUB_STEP_SUMMARY: summary,
        HEAD_BRANCH: "automation/locale",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        PR_BODY: "Generated test body",
        PR_TITLE: "chore(test): refresh generated output",
        RUNNER_TEMP: runnerTemp,
      },
    });
    const publishOutput = `${publish.stdout}${publish.stderr}`;
    if (options.expectFailure ? publish.status === 0 : publish.status !== 0) {
      throw new Error(
        `generated publisher exited ${String(publish.status)} (expected ${options.expectFailure ? "failure" : "success"}):\n${publishOutput}`,
      );
    }
    const authHeader = spawnSync(
      "git",
      ["config", "--local", "--get-all", "http.https://github.com/.extraheader"],
      { cwd: worktree, encoding: "utf8" },
    );
    if (authHeader.status !== 1 || authHeader.stdout.trim() !== "") {
      throw new Error("generated publisher left its Git authorization header configured");
    }

    const branchRef = "refs/heads/automation/locale";
    const branchExists =
      spawnSync("git", ["--git-dir", origin, "show-ref", "--verify", branchRef]).status === 0;
    const branchHead = branchExists
      ? runGit(root, ["--git-dir", origin, "rev-parse", branchRef])
      : "";
    return {
      branchExists,
      branchHead,
      generatedA: branchExists
        ? runGit(root, ["--git-dir", origin, "show", `${branchRef}:generated/a.txt`])
        : "",
      generatedB: branchExists
        ? runGit(root, ["--git-dir", origin, "show", `${branchRef}:generated/b.txt`])
        : "",
      mainHead: runGit(root, ["--git-dir", origin, "rev-parse", "refs/heads/main"]),
      publishOutput,
      summary: readFileSync(summary, "utf8"),
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("ci workflow guards", () => {
  it("makes the hosted release-gate fallback explicit and exact-SHA only", () => {
    const workflow = readCiWorkflow();
    const releaseGate = workflow.on.workflow_dispatch.inputs.release_gate;

    expect(releaseGate).toEqual({
      description:
        "Run an exact-SHA maintainer release-gate fallback when PR CI is capacity-stalled.",
      required: false,
      default: false,
      type: "boolean",
    });
    expect(workflow.on.workflow_dispatch.inputs.dispatch_id).toEqual({
      description: "Optional parent workflow dispatch identifier",
      required: false,
      default: "",
      type: "string",
    });
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain(
      "run-name: ${{ github.event_name == 'workflow_dispatch' && inputs.dispatch_id != '' && format('CI {0}', inputs.dispatch_id) || (github.event_name == 'workflow_dispatch' && inputs.release_gate && format('CI release gate {0}', inputs.target_ref) || 'CI') }}",
    );
    const preflightSteps = workflow.jobs.preflight.steps;
    const validationStep = preflightSteps.find(
      (step) => step.name === "Validate release-gate dispatch",
    );
    expect(validationStep.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.release_gate",
    );
    expect(validationStep.run).toContain(
      "release_gate requires target_ref to be a full commit SHA",
    );
    expect(validationStep.run).toContain("release_gate must run from the branch at target_ref");
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain(
      "OPENCLAW_CI_RUN_ANDROID: ${{ github.event_name == 'workflow_dispatch' && (inputs.release_gate || inputs.include_android) && 'true' || steps.changed_scope.outputs.run_android || 'false' }}",
    );

    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const runsOn = (job as { "runs-on"?: unknown })["runs-on"];
      if (typeof runsOn !== "string" || !runsOn.includes("blacksmith-")) {
        continue;
      }
      expect(runsOn, `${jobName} must use GitHub-hosted capacity for release gates`).toContain(
        "github.event_name == 'workflow_dispatch'",
      );
    }
  });

  it("keeps Testbox pull request validation off leased runner capacity", () => {
    const workflow = readTestboxWorkflow();

    expect(workflow.jobs.check["runs-on"]).toBe(
      "${{ github.event_name == 'pull_request' && 'ubuntu-24.04' || 'blacksmith-32vcpu-ubuntu-2404' }}",
    );
    const beginStep = workflow.jobs.check.steps.find(
      (step: { name?: string }) => step.name === "Begin Testbox",
    );
    const runStep = workflow.jobs.check.steps.find(
      (step: { name?: string }) => step.name === "Run Testbox",
    );
    expect(beginStep).toMatchObject({
      if: "github.event_name == 'workflow_dispatch'",
      with: { testbox_id: "${{ inputs.testbox_id }}" },
    });
    expect(runStep).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && always()",
    });
  });

  it("pins every external GitHub Action reference to a full commit SHA", () => {
    expect(findUnpinnedExternalActions()).toEqual([]);
  });

  it("forbids moving reusable workflow references", () => {
    expect([...OIDC_BOUND_MAIN_REUSABLE_WORKFLOWS]).toEqual([]);
  });

  it("keeps locale refresh matrices alive and publishes each aggregate through a PR", () => {
    const controlUiWorkflow = parse(readFileSync(CONTROL_UI_LOCALE_REFRESH_WORKFLOW, "utf8"));
    const workflow = parse(readFileSync(NATIVE_APP_LOCALE_REFRESH_WORKFLOW, "utf8"));
    const controlUiResolveBase = controlUiWorkflow.jobs["resolve-base"];
    const nativeResolveBase = workflow.jobs["resolve-base"];
    const controlUiPreflight = controlUiWorkflow.jobs["publisher-preflight"];
    const nativePreflight = workflow.jobs["publisher-preflight"];
    const refresh = workflow.jobs.refresh;
    const nativeFinalize = workflow.jobs.finalize;
    const controlUiFinalize = controlUiWorkflow.jobs.finalize;
    const refreshStep = refresh.steps.find(
      (step: { name?: string }) => step.name === "Refresh native locale artifact",
    );
    const nativeArtifactStep = refresh.steps.find(
      (step: { name?: string }) => step.name === "Prepare locale artifact",
    );
    const nativeInventoryStep = nativeFinalize.steps.find(
      (step: { name?: string }) => step.name === "Refresh shared native inventory",
    );
    const controlUiRefreshStep = controlUiWorkflow.jobs.refresh.steps.find(
      (step: { name?: string }) => step.name === "Refresh control UI locale files",
    );

    expect(refresh.if).toBe(
      "needs.resolve-base.result == 'success' && needs.publisher-preflight.result == 'success'",
    );
    expect(refresh.strategy.matrix.locale).toEqual(NATIVE_I18N_LOCALES);
    expect(controlUiWorkflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(controlUiWorkflow.concurrency.group.replace(/\s+/gu, " ")).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.token_preflight_only && format('control-ui-locale-token-preflight-{0}', github.ref) || 'control-ui-locale-refresh' }}",
    );
    expect(controlUiWorkflow.jobs.plan).toBeUndefined();
    expect(controlUiWorkflow.jobs.refresh.if).toBe(
      "needs.resolve-base.result == 'success' && needs.publisher-preflight.result == 'success' && !(github.event_name == 'workflow_dispatch' && inputs.token_preflight_only)",
    );
    expect(controlUiWorkflow.jobs.refresh.strategy.matrix.locale).toEqual(
      SUPPORTED_LOCALES.filter((locale) => locale !== "en"),
    );
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(workflow.concurrency.group).toBe("native-app-locale-refresh");
    expect(controlUiResolveBase.if).not.toContain("chore(ui): refresh control ui locales");
    expect(nativeResolveBase.if).not.toContain("chore(i18n): refresh native locales");
    const controlResolveCondition = controlUiResolveBase.if.replace(/\s+/gu, " ");
    expect(controlResolveCondition).toBe(
      "github.repository == 'openclaw/openclaw' && (github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main')",
    );
    expect(controlResolveCondition).not.toContain("inputs.token_preflight_only");
    expect(controlResolveCondition).not.toContain("github.ref_type");
    expect(nativeResolveBase.if).toBe(
      "github.repository == 'openclaw/openclaw' && (github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main')",
    );
    expect(controlUiWorkflow.on.workflow_dispatch.inputs.token_preflight_only).toEqual({
      description: "Verify generated PR App permissions without running locale generation.",
      required: false,
      default: false,
      type: "boolean",
    });
    expect(workflow.on.workflow_dispatch?.inputs).toBeUndefined();
    expect(workflow.on.push.paths).toContain("ui/src/i18n/.i18n/glossary.*.json");
    expect(workflow.on.push.paths).toContain("apps/.i18n/native/**");
    expect(workflow.on.push.paths).toContain("apps/.i18n/native-source.json");
    expect(refreshStep.run).toContain("run_refresh anthropic");
    expect(refreshStep.run).toContain("retrying with OpenAI");
    expect(refreshStep.run).toContain("run_openai_refresh");
    expect(refreshStep.run).toContain("repository OpenAI key");
    expect(refreshStep.env.OPENCLAW_DOCS_I18N_OPENAI_API_KEY).toBe(
      "${{ secrets.OPENCLAW_DOCS_I18N_OPENAI_API_KEY }}",
    );
    expect(refreshStep.env.OPENAI_API_KEY).toBe("${{ secrets.OPENAI_API_KEY }}");
    expect(nativeArtifactStep.run).toContain("git add -A apps/.i18n/native");
    expect(nativeArtifactStep.run).not.toContain("native-source.json");
    expect(nativeInventoryStep.run).toBe(
      "node --import tsx scripts/native-app-i18n.ts sync --write",
    );
    expect(controlUiRefreshStep.run).toContain("run_refresh anthropic");
    expect(controlUiRefreshStep.run).toContain("retrying with OpenAI");
    expect(controlUiRefreshStep.run).toContain("run_openai_refresh");
    expect(controlUiRefreshStep.run).toContain("repository OpenAI key");
    expect(controlUiRefreshStep.env.OPENCLAW_DOCS_I18N_OPENAI_API_KEY).toBe(
      "${{ secrets.OPENCLAW_DOCS_I18N_OPENAI_API_KEY }}",
    );
    expect(controlUiRefreshStep.env.OPENAI_API_KEY).toBe("${{ secrets.OPENAI_API_KEY }}");
    expect(controlUiRefreshStep.env.OPENCLAW_CONTROL_UI_I18N_AUTH_OPTIONAL).toBe("0");

    for (const ownerWorkflow of [controlUiWorkflow, workflow]) {
      expect(ownerWorkflow.on.push.paths).toContain(CREATE_GENERATED_PR_TOKENS_ACTION);
      expect(ownerWorkflow.on.push.paths).toContain(PUBLISH_GENERATED_PR_ACTION);
      const resolveBase = ownerWorkflow.jobs["resolve-base"];
      const resolveStep = resolveBase.steps.find(
        (step: { name?: string }) =>
          step.name ===
          (ownerWorkflow === controlUiWorkflow
            ? "Resolve source commit"
            : "Resolve default branch head"),
      );
      expect(resolveBase.outputs.sha).toBe("${{ steps.base.outputs.sha }}");
      expect(resolveStep.env.GH_TOKEN).toBe("${{ github.token }}");
      expect(resolveStep.run).toContain(
        'gh api --method GET "repos/${REPOSITORY}/commits/${DEFAULT_BRANCH}" --jq .sha',
      );
      expect(resolveStep.run).toContain('[[ ! "${sha}" =~ ^[0-9a-f]{40}$ ]]');

      const checkoutSteps = Object.values(ownerWorkflow.jobs).flatMap(
        (job: { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }) =>
          (job.steps ?? []).filter((step) => step.uses === CHECKOUT_V6),
      );
      expect(checkoutSteps.length).toBeGreaterThan(0);
      for (const checkoutStep of checkoutSteps) {
        expect(checkoutStep.with?.ref).toBe("${{ needs.resolve-base.outputs.sha }}");
        expect(checkoutStep.with?.["persist-credentials"]).toBe(false);
      }
    }

    const controlUiResolveStep = controlUiResolveBase.steps.find(
      (step: { name?: string }) => step.name === "Resolve source commit",
    );
    expect(controlUiResolveStep.env.TOKEN_PREFLIGHT_ONLY).toContain("inputs.token_preflight_only");
    expect(controlUiResolveStep.env.WORKFLOW_SHA).toBe("${{ github.workflow_sha }}");
    expect(controlUiResolveStep.run).toContain(
      'if [[ "${TOKEN_PREFLIGHT_ONLY}" == "true" ]]; then',
    );
    expect(controlUiResolveStep.run).toContain('sha="${WORKFLOW_SHA}"');

    for (const preflight of [controlUiPreflight, nativePreflight]) {
      expect(preflight.needs).toBe("resolve-base");
      expect(preflight.if).toBe("needs.resolve-base.result == 'success'");
      expect(preflight.strategy).toBeUndefined();
      expect(preflight.steps).toHaveLength(2);
      const checkoutStep = preflight.steps.find(
        (step: { uses?: string }) => step.uses === CHECKOUT_V6,
      );
      const tokensStep = preflight.steps.find(
        (step: { name?: string }) => step.name === "Create generated PR tokens",
      );
      expect(checkoutStep.with).toMatchObject({
        ref: "${{ needs.resolve-base.outputs.sha }}",
        "persist-credentials": false,
      });
      expect(tokensStep.uses).toBe("./.github/actions/create-generated-pr-tokens");
      expect(tokensStep.with).toEqual({
        "contents-client-id": "Iv23liOECG0slfuhz093",
        "contents-private-key": "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
        "pull-request-app-id": "${{ secrets.MANTIS_GITHUB_APP_ID }}",
        "pull-request-private-key": "${{ secrets.MANTIS_GITHUB_APP_PRIVATE_KEY }}",
      });
    }

    const tokenAction = parse(readFileSync(CREATE_GENERATED_PR_TOKENS_ACTION, "utf8"));
    const tokenActionSource = readFileSync(CREATE_GENERATED_PR_TOKENS_ACTION, "utf8");
    const contentsTokenStep = tokenAction.runs.steps.find(
      (step: { name?: string }) => step.name === "Create generated branch app token",
    );
    const pullRequestTokenStep = tokenAction.runs.steps.find(
      (step: { name?: string }) => step.name === "Create generated PR app token",
    );
    const publishAction = parse(readFileSync(PUBLISH_GENERATED_PR_ACTION, "utf8"));
    const publishActionSource = readFileSync(PUBLISH_GENERATED_PR_ACTION, "utf8");
    const createTokensStep = publishAction.runs.steps.find(
      (step: { name?: string }) => step.name === "Create generated PR tokens",
    );
    const actionPublishStep = publishAction.runs.steps.find(
      (step: { name?: string }) => step.name === "Publish generated pull request",
    );

    expect(tokenAction.runs.steps).toHaveLength(2);
    for (const input of [
      "contents-client-id",
      "contents-private-key",
      "pull-request-app-id",
      "pull-request-private-key",
    ]) {
      expect(tokenAction.inputs[input].required).toBe(true);
      expect(publishAction.inputs[input].required).toBe(true);
    }
    expect(`${tokenActionSource}\n${publishActionSource}`).not.toMatch(
      /2729701|2971289|primary-private-key|fallback-private-key/u,
    );
    expect(contentsTokenStep).toEqual({
      name: "Create generated branch app token",
      id: "contents-token",
      uses: CREATE_GITHUB_APP_TOKEN_V3,
      with: {
        "client-id": "${{ inputs.contents-client-id }}",
        "private-key": "${{ inputs.contents-private-key }}",
        owner: "${{ github.repository_owner }}",
        repositories: "${{ github.event.repository.name }}",
        "permission-contents": "write",
      },
    });
    expect(pullRequestTokenStep).toEqual({
      name: "Create generated PR app token",
      id: "pull-request-token",
      uses: CREATE_GITHUB_APP_TOKEN_V3,
      with: {
        "app-id": "${{ inputs.pull-request-app-id }}",
        "private-key": "${{ inputs.pull-request-private-key }}",
        owner: "${{ github.repository_owner }}",
        repositories: "${{ github.event.repository.name }}",
        "permission-pull-requests": "write",
      },
    });
    expect(tokenAction.outputs["contents-token"].value).toBe(
      "${{ steps.contents-token.outputs.token }}",
    );
    expect(tokenAction.outputs["pull-request-token"].value).toBe(
      "${{ steps.pull-request-token.outputs.token }}",
    );
    expect(createTokensStep).toMatchObject({
      id: "tokens",
      uses: "./.github/actions/create-generated-pr-tokens",
      with: {
        "contents-client-id": "${{ inputs.contents-client-id }}",
        "contents-private-key": "${{ inputs.contents-private-key }}",
        "pull-request-app-id": "${{ inputs.pull-request-app-id }}",
        "pull-request-private-key": "${{ inputs.pull-request-private-key }}",
      },
    });
    expect(
      publishAction.runs.steps.filter(
        (step: { uses?: string }) => step.uses === CREATE_GITHUB_APP_TOKEN_V3,
      ),
    ).toEqual([]);
    expect(actionPublishStep.env.CONTENTS_TOKEN).toBe("${{ steps.tokens.outputs.contents-token }}");
    expect(actionPublishStep.env.GH_TOKEN).toBe("${{ steps.tokens.outputs.pull-request-token }}");
    expect(actionPublishStep.env.INVALIDATION_PATHS).toBe("${{ inputs.invalidation-paths }}");
    expect(publishAction.inputs["working-directory"]).toEqual({
      description: "Repository root containing the generated files.",
      required: false,
      default: ".",
    });
    expect(actionPublishStep["working-directory"]).toBe("${{ inputs.working-directory }}");
    expect(publishAction.inputs["overlap-policy"]).toEqual({
      description: "Whether stale inputs or owned-path overlap defer to a successor run or fail.",
      required: false,
      default: "defer",
    });
    expect(actionPublishStep.env.OVERLAP_POLICY).toBe("${{ inputs.overlap-policy }}");
    expect(actionPublishStep.run).toContain('case "${OVERLAP_POLICY}" in');
    expect(actionPublishStep.run).toContain("defer | fail");
    expect(actionPublishStep.run).toContain("GIT_TERMINAL_PROMPT=0");
    expect(actionPublishStep.run).toContain(
      'git config --local http.https://github.com/.extraheader "AUTHORIZATION: basic ${git_auth}"',
    );
    expect(actionPublishStep.run).toContain("printf '::add-mask::%s\\n' \"${git_auth}\"");
    expect(actionPublishStep.run).toContain(
      "git config --local --unset-all http.https://github.com/.extraheader",
    );
    expect(actionPublishStep.run).toContain("trap cleanup_git_auth EXIT");
    expect(actionPublishStep.run).not.toContain("gh auth setup-git");
    expect(actionPublishStep.run).toContain("timeout --signal=TERM --kill-after=10s 120s");
    expect(actionPublishStep.run).toContain("--force-with-lease=refs/heads/");
    expect(actionPublishStep.run).toContain(
      "GH013|repository rule violations|required status check",
    );
    expect(actionPublishStep.run).toContain("refusing a doomed retry");
    expect(actionPublishStep.run).toContain("branch_was_deleted");
    expect(actionPublishStep.run).toContain(
      '[[ -n "${remote_head}" && -z "${current_remote_head}" ]]',
    );
    expect(actionPublishStep.run).toContain('push_generated_branch ""');
    expect(actionPublishStep.run).toContain(
      "overlap policy decides whether stale output defers or fails",
    );
    expect(actionPublishStep.run).toContain(
      'gh api --method GET "repos/${GITHUB_REPOSITORY}/pulls"',
    );
    expect(actionPublishStep.run).toContain('-f "head=${GITHUB_REPOSITORY_OWNER}:${HEAD_BRANCH}"');
    expect(actionPublishStep.run).toContain(".head.repo.full_name == env.GITHUB_REPOSITORY");
    expect(actionPublishStep.run).toContain(".head.ref == env.HEAD_BRANCH");
    expect(actionPublishStep.run).toContain(".head.sha");
    expect(actionPublishStep.run).not.toContain("gh pr list");
    expect(actionPublishStep.run).toContain("neutralize_stale_pr");
    expect(actionPublishStep.run).toContain(
      'git diff --quiet "${source_commit}" "${base_ref}" -- "${invalidation_paths[@]}"',
    );
    expect(actionPublishStep.run).not.toContain("force_retirement");
    expect(actionPublishStep.run).toContain("unsafe close mutation");
    expect(actionPublishStep.run).not.toContain("gh pr close");
    expect(actionPublishStep.run).toContain('source_commit="$(git rev-parse HEAD)"');
    expect(actionPublishStep.run).toContain(
      'git merge-base --is-ancestor "${source_commit}" "${base_ref}"',
    );
    expect(actionPublishStep.run).toContain("Snapshot the generator's desired blobs");
    expect(actionPublishStep.run).toContain(
      'git diff --name-only -z --no-renames "${source_commit}" "${desired_commit}"',
    );
    expect(actionPublishStep.run).toContain(
      '[[ "${source_entry}" != "${base_entry}" && "${desired_entry}" != "${base_entry}" ]]',
    );
    expect(actionPublishStep.run).toContain('git switch -C "${HEAD_BRANCH}" "${base_ref}"');
    expect(actionPublishStep.run).toContain(
      'git restore --source="${desired_commit}" --staged --worktree -- "${path}"',
    );
    expect(actionPublishStep.run).not.toContain("git rebase");
    expect(actionPublishStep.run).toContain("verify_publication");
    expect(actionPublishStep.run).toContain("desired_matches_tree");
    expect(actionPublishStep.run).toContain(
      '[[ "${current_remote_head}" != "${published_commit}" ]]',
    );
    expect(actionPublishStep.run).toContain('[[ "${final_pr_head}" != "${published_commit}" ]]');
    expect(actionPublishStep.run).toContain("gh pr edit");
    expect(actionPublishStep.run).toContain("gh pr create");
    expect(actionPublishStep.run).toContain('--base "${BASE_BRANCH}"');
    expect(actionPublishStep.run).toContain('--head "${HEAD_BRANCH}"');
    expect(actionPublishStep.run).toContain('--body-file "${body_file}"');
    expect(actionPublishStep.run).not.toContain('HEAD:"${BASE_BRANCH}"');

    for (const [
      ownerWorkflow,
      refreshJob,
      finalizeJob,
      artifactPattern,
      commitMessage,
      automationBranch,
    ] of [
      [
        workflow,
        refresh,
        nativeFinalize,
        "native-locale-*",
        "chore(i18n): refresh native locales",
        "automation/native-app-locale-refresh",
      ],
      [
        controlUiWorkflow,
        controlUiWorkflow.jobs.refresh,
        controlUiFinalize,
        "control-ui-locale-*",
        "chore(ui): refresh control ui locales",
        "automation/control-ui-locale-refresh",
      ],
    ] as const) {
      const uploadStep = refreshJob.steps.find(
        (step: { name?: string }) => step.name === "Upload locale artifact",
      );
      const downloadStep = finalizeJob.steps.find(
        (step: { name?: string }) => step.name === "Download locale artifacts",
      );
      const checkoutStep = finalizeJob.steps.find(
        (step: { uses?: string }) => step.uses === CHECKOUT_V6,
      );
      const publishStep = finalizeJob.steps.find(
        (step: { name?: string }) => step.name === "Open or update generated locale PR",
      );

      expect(ownerWorkflow.permissions.contents).toBe("read");
      expect(refreshJob.needs).toEqual(["resolve-base", "publisher-preflight"]);
      expect(finalizeJob.needs).toEqual(["resolve-base", "publisher-preflight", "refresh"]);
      const isNative = automationBranch.includes("native");
      expect(finalizeJob.if).toBe(
        isNative
          ? "needs.resolve-base.result == 'success' && needs.publisher-preflight.result == 'success' && needs.refresh.result == 'success'"
          : "needs.resolve-base.result == 'success' && needs.publisher-preflight.result == 'success' && needs.refresh.result == 'success' && !(github.event_name == 'workflow_dispatch' && inputs.token_preflight_only)",
      );
      expect(uploadStep.uses).toBe(UPLOAD_ARTIFACT_V7);
      expect(downloadStep.uses).toBe(DOWNLOAD_ARTIFACT_V8);
      expect(downloadStep.with.pattern).toBe(artifactPattern);
      expect(downloadStep.with["merge-multiple"]).toBe(true);
      expect(checkoutStep.with["persist-credentials"]).toBe(false);
      expect(checkoutStep.with["fetch-depth"]).toBe(0);
      expect(publishStep.uses).toBe("./.github/actions/publish-generated-pr");
      expect(publishStep.with).toMatchObject({
        "contents-client-id": "Iv23liOECG0slfuhz093",
        "contents-private-key": "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
        "pull-request-app-id": "${{ secrets.MANTIS_GITHUB_APP_ID }}",
        "pull-request-private-key": "${{ secrets.MANTIS_GITHUB_APP_PRIVATE_KEY }}",
        "base-branch": "${{ github.event.repository.default_branch }}",
        "head-branch": automationBranch,
        "commit-message": commitMessage,
        "pr-title": commitMessage,
      });
      expect(publishStep.with["generated-paths"]).toContain(
        automationBranch.includes("native") ? "apps/.i18n/native" : "ui/src/i18n",
      );
      expect(publishStep.with["invalidation-paths"]).toContain(
        automationBranch.includes("native")
          ? "apps/android/app/src/main"
          : "ui/src/i18n/locales/en.ts",
      );
      expect(publishStep.with["invalidation-paths"]).toContain(
        ".github/actions/create-generated-pr-tokens/action.yml",
      );
      expect(publishStep.with["invalidation-paths"]).toContain(
        ".github/actions/publish-generated-pr/action.yml",
      );
      expect(publishStep.with).not.toHaveProperty("overlap-policy");
      expect(publishStep.with["pr-body"]).toContain("## What Problem This Solves");
      expect(publishStep.with["pr-body"]).toContain("## Evidence");
      expect(publishStep.with["pr-body"]).toContain("${{ needs.resolve-base.outputs.sha }}");
      expect(publishStep.with["pr-body"]).not.toContain("${{ github.sha }}");
    }
  });

  it.skipIf(process.platform === "win32")(
    "defers a newer owned snapshot even when the desired diff is disjoint",
    () => {
      const result = runGeneratedPublisherScenario("b");

      expect(result.branchExists).toBe(false);
      expect(result.summary).toContain(
        "Deferred stale generated output because owned generated paths changed on main.",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "defers instead of overwriting a newer overlapping generated path",
    () => {
      const result = runGeneratedPublisherScenario("a");

      expect(result.branchExists).toBe(false);
      expect(result.summary).toContain(
        "Deferred stale generated output because owned generated paths changed on main.",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "retries a stale pull request head read after the branch push",
    () => {
      const result = runGeneratedPublisherScenario(null, { stalePrHeadOnce: true });

      expect(result.branchExists).toBe(true);
      expect(result.generatedA).toBe("desired-a");
      expect(result.summary).toContain("https://github.com/openclaw/openclaw/pull/1");
    },
  );

  it.skipIf(process.platform === "win32")(
    "defers stale generator inputs and neutralizes an existing pull request",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        existingPr: true,
        updateSource: true,
      });

      expect(result.branchHead).toBe(result.mainHead);
      expect(result.generatedA).toBe("old-a");
      expect(result.summary).toContain(
        "Deferred stale generated output because generator inputs changed on main.",
      );
      expect(result.summary).toContain("Neutralized stale generated pull request");
    },
  );

  it.skipIf(process.platform === "win32")(
    "neutralizes an existing pull request when generation has no changes",
    () => {
      const result = runGeneratedPublisherScenario("b", {
        existingPr: true,
        noGeneratedChange: true,
      });

      expect(result.branchHead).toBe(result.mainHead);
      expect(result.generatedA).toBe("old-a");
      expect(result.generatedB).toBe("newer-b");
      expect(result.summary).toContain(
        "Deferred stale generated output because owned generated paths changed on main.",
      );
      expect(result.summary).toContain("Neutralized stale generated pull request");
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails stale generated publication when no successor run is guaranteed",
    () => {
      const overlap = runGeneratedPublisherScenario("a", {
        expectFailure: true,
        overlapPolicy: "fail",
      });
      expect(overlap.branchExists).toBe(false);
      expect(overlap.publishOutput).toContain(
        "::error::Refusing stale generated output because owned generated paths changed on main.",
      );

      const stalePr = runGeneratedPublisherScenario(null, {
        existingPr: true,
        expectFailure: true,
        noGeneratedChange: true,
        overlapPolicy: "fail",
        updateSource: true,
      });
      expect(stalePr.branchHead).toBe(stalePr.mainHead);
      expect(stalePr.summary).toContain("Neutralized stale generated pull request");
      expect(stalePr.publishOutput).toContain(
        "::error::Refusing stale generated output because generator inputs changed on main.",
      );

      const noPr = runGeneratedPublisherScenario(null, {
        expectFailure: true,
        noGeneratedChange: true,
        overlapPolicy: "fail",
        updateSource: true,
      });
      expect(noPr.branchExists).toBe(false);
      expect(noPr.publishOutput).toContain(
        "::error::Refusing stale generated output because generator inputs changed on main.",
      );

      const unchangedOverlap = runGeneratedPublisherScenario("b", {
        expectFailure: true,
        noGeneratedChange: true,
        overlapPolicy: "fail",
      });
      expect(unchangedOverlap.branchExists).toBe(false);
      expect(unchangedOverlap.publishOutput).toContain(
        "::error::Refusing stale generated output because owned generated paths changed on main.",
      );

      const invalidPolicy = runGeneratedPublisherScenario("b", {
        expectFailure: true,
        overlapPolicy: "continue",
      });
      expect(invalidPolicy.branchExists).toBe(false);
      expect(invalidPolicy.publishOutput).toContain(
        "Generated PR publication overlap policy must be 'defer' or 'fail'.",
      );
    },
  );

  it("fails OpenGrep SARIF artifact uploads when reports are missing", () => {
    const cases = [
      {
        workflowPath: OPENGREP_PR_DIFF_WORKFLOW,
        artifactName: "opengrep-pr-diff-sarif",
      },
      {
        workflowPath: OPENGREP_FULL_WORKFLOW,
        artifactName: "opengrep-full-sarif",
      },
    ];

    for (const item of cases) {
      const workflow = parse(readFileSync(item.workflowPath, "utf8"));
      const uploadStep = workflow.jobs.scan.steps.find(
        (step) => step.name === "Upload SARIF as workflow artifact",
      );

      expect(uploadStep.if, item.workflowPath).toBe("always()");
      expect(uploadStep.uses, item.workflowPath).toBe(UPLOAD_ARTIFACT_V7);
      expect(uploadStep.with, item.workflowPath).toMatchObject({
        name: item.artifactName,
        path: ".opengrep-out/precise.sarif",
        "if-no-files-found": "error",
      });
    }
  });

  it("runs real behavior proof from the trusted workflow revision", () => {
    const workflow = readRealBehaviorProofWorkflow();
    const source = readFileSync(".github/workflows/real-behavior-proof.yml", "utf8");
    const checkout = workflow.jobs["real-behavior-proof"].steps.find(
      (step) => step.uses === CHECKOUT_V6,
    );

    expect(checkout.with.ref).toBe("${{ github.workflow_sha }}");
    expect(checkout.with.ref).not.toBe("${{ github.event.pull_request.base.sha }}");
    expect(source).toContain("Old PR events can carry a stale base SHA");
  });

  it("keeps docs-change detection fail-safe and fixture-aware", () => {
    const action = readFileSync(".github/actions/detect-docs-changes/action.yml", "utf8");

    expect(action).toContain("docs_only:");
    expect(action).toContain("docs_changed:");
    expect(action).toContain('BASE="${{ github.event.before }}"');
    expect(action).toContain('BASE="${{ github.event.pull_request.base.sha }}"');
    expect(action).toContain(
      'CHANGED=$(git diff --name-only "$BASE" HEAD 2>/dev/null || echo "UNKNOWN")',
    );
    expect(action).toContain('if [ "$CHANGED" = "UNKNOWN" ] || [ -z "$CHANGED" ]; then');
    expect(action).toContain("docs_only=false");
    expect(action).toContain("docs_changed=false");
    expect(action).toContain("test/fixtures/*)");
    expect(action).toContain("docs/* | *.md | *.mdx)");
  });

  it("bounds matrix fan-out for runner-registration pressure", () => {
    const workflow = readCiWorkflow();

    expect(workflow.concurrency.group).toContain("github.event.pull_request.number");
    expect(workflow.concurrency["cancel-in-progress"]).toContain(
      "github.event_name == 'pull_request'",
    );
    expect(workflow.jobs["checks-fast-core"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["checks-node-core-test-nondist-shard"].strategy["max-parallel"]).toBe(28);
    expect(workflow.jobs["checks-fast-plugin-contracts-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["checks-fast-channel-contracts-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["check-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["check-additional-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["checks-windows"].strategy["max-parallel"]).toBe(2);
    expect(workflow.jobs.android.strategy["max-parallel"]).toBe(2);
  });

  it("installs the Android SDK platform used by Gradle", () => {
    const workflow = readCiWorkflow();
    const releaseWorkflow = readAndroidReleaseWorkflow();
    const appCompileSdk = readAndroidCompileSdk("apps/android/app/build.gradle.kts");
    const benchmarkCompileSdk = readAndroidCompileSdk("apps/android/benchmark/build.gradle.kts");
    const sdkJobs = [workflow.jobs.android, releaseWorkflow.jobs.publish_signed_android_apk];
    const packageId = `platforms;android-${appCompileSdk}.0`;

    expect(appCompileSdk).toBe(benchmarkCompileSdk);
    for (const job of sdkJobs) {
      const cacheStep = job.steps.find((step) => step.name === "Cache Android SDK");
      const installStep = job.steps.find((step) => step.name === "Install Android SDK packages");

      expect(cacheStep.with.key).toContain(`platform-${appCompileSdk}.0-`);
      expect(installStep.run).toContain(`"${packageId}"`);
    }
  });

  it("covers Android app variants, lint, and benchmark compilation", () => {
    const workflow = readCiWorkflow();
    const source = readFileSync(".github/workflows/ci.yml", "utf8");
    const runStep = workflow.jobs.android.steps.find(
      (step) => step.name === "Run Android ${{ matrix.task }}",
    );

    expect(source).toContain('{ check_name: "android-test-play", task: "test-play" }');
    expect(source).toContain(
      '{ check_name: "android-test-third-party", task: "test-third-party" }',
    );
    expect(source).toContain('{ check_name: "android-build-play", task: "build-play" }');
    expect(runStep.run).toContain(":app:testPlayDebugUnitTest");
    expect(runStep.run).toContain(":app:testThirdPartyDebugUnitTest");
    expect(runStep.run).toContain(":app:assemblePlayDebug");
    expect(runStep.run).toContain(":app:assembleThirdPartyDebug");
    expect(runStep.run).toContain(":app:lintPlayDebug");
    expect(runStep.run).toContain(":app:lintThirdPartyDebug");
    expect(runStep.run).toContain(":benchmark:assembleDebug");
  });

  it("debounces canonical main pushes before Blacksmith admission", () => {
    const workflow = readCiWorkflow();
    const source = readFileSync(".github/workflows/ci.yml", "utf8");
    const admission = workflow.jobs["runner-admission"];

    expect(admission["runs-on"]).toBe("ubuntu-24.04");
    expect(admission.steps[0].if).toContain("github.ref == 'refs/heads/main'");
    expect(admission.steps[0].run).toContain('sleep "${OPENCLAW_MAIN_CI_DEBOUNCE_SECONDS}"');
    expect(admission.env.OPENCLAW_MAIN_CI_DEBOUNCE_SECONDS).toBe("90");
    expect(workflow.jobs.preflight.needs).toContain("runner-admission");
    expect(workflow.jobs["security-fast"].needs).toContain("runner-admission");
    expect(source).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' || (github.event_name == 'push' && github.repository == 'openclaw/openclaw' && github.ref == 'refs/heads/main') }}",
    );
  });

  it("keeps CodeQL critical quality scans off Blacksmith registrations", () => {
    const source = readCriticalQualityWorkflow();
    const workflow = parse(source);
    const blacksmithJobs = Object.entries(workflow.jobs)
      .filter(([, job]) => job && typeof job === "object")
      .filter(([, job]) => (job as Record<string, unknown>)["runs-on"] !== "ubuntu-24.04")
      .map(([name]) => name);

    expect(blacksmithJobs).toEqual([]);
    expect(source).not.toContain("blacksmith-");
  });

  it("uses bundled Node shards and telemetry-backed runner sizes", () => {
    const workflow = readCiWorkflow();
    const buildArtifactsTestbox = readBuildArtifactsTestboxWorkflow();
    const source = readFileSync(".github/workflows/ci.yml", "utf8");

    expect(source).toContain("createNodeTestShardBundles");
    expect(workflow.jobs["build-artifacts"]["runs-on"]).toContain("blacksmith-16vcpu-ubuntu-2404");
    expect(buildArtifactsTestbox.jobs["build-artifacts"]["runs-on"]).toBe(
      "blacksmith-16vcpu-ubuntu-2404",
    );
    expect(
      buildArtifactsTestbox.jobs["build-artifacts"].steps.find(
        (step: { name?: string }) => step.name === "Build dist on cache miss",
      ).env.NODE_OPTIONS,
    ).toBe("--max-old-space-size=16384");
    expect(workflow.jobs["checks-node-core-test-nondist-shard"]["runs-on"]).toContain(
      "blacksmith-4vcpu-ubuntu-2404",
    );
    expect(workflow.jobs["check-shard"].strategy.matrix.include).toContainEqual({
      check_name: "check-dependencies",
      task: "dependencies",
      runner: "blacksmith-4vcpu-ubuntu-2404",
    });
    expect(workflow.jobs["check-additional-shard"]["runs-on"]).toContain("matrix.runner");
    expect(workflow.jobs["check-additional-shard"].strategy.matrix.include).toContainEqual({
      check_name: "check-session-accessor-boundary",
      group: "session-accessor-boundary",
      runner: "blacksmith-4vcpu-ubuntu-2404",
    });
    expect(workflow.jobs["checks-windows"]["runs-on"]).toContain("matrix.runner");
    expect(source).toContain("blacksmith-8vcpu-windows-2025");
  });

  it("runs the session accessor ratchet as a visible additional check", () => {
    const workflow = readCiWorkflow();
    const additionalJob = workflow.jobs["check-additional-shard"];
    const matrixRows = additionalJob.strategy.matrix.include;
    expect(matrixRows).toContainEqual({
      check_name: "check-session-accessor-boundary",
      group: "session-accessor-boundary",
      runner: "blacksmith-4vcpu-ubuntu-2404",
    });

    const runStep = additionalJob.steps.find((step) => step.name === "Run additional check shard");
    expect(runStep.run).toContain("session-accessor-boundary)");
    expect(runStep.run).toContain(
      'run_check "lint:tmp:session-accessor-boundary" pnpm run lint:tmp:session-accessor-boundary',
    );
  });

  it("runs the transcript reader ratchet as a visible additional check", () => {
    const workflow = readCiWorkflow();
    const additionalJob = workflow.jobs["check-additional-shard"];
    const matrixRows = additionalJob.strategy.matrix.include;
    expect(matrixRows).toContainEqual({
      check_name: "check-session-transcript-reader-boundary",
      group: "session-transcript-reader-boundary",
      runner: "blacksmith-4vcpu-ubuntu-2404",
    });

    const runStep = additionalJob.steps.find((step) => step.name === "Run additional check shard");
    expect(runStep.run).toContain("session-transcript-reader-boundary)");
    expect(runStep.run).toContain(
      'run_check "lint:tmp:session-transcript-reader-boundary" pnpm run lint:tmp:session-transcript-reader-boundary',
    );
  });

  it("kills timed manual checkout fetches after the grace period", () => {
    const workflowPaths = [
      [".github/workflows/ci.yml", "120s"],
      [".github/workflows/workflow-sanity.yml", "30s"],
      [".github/workflows/ci-check-testbox.yml", "120s"],
      [".github/workflows/ci-check-arm-testbox.yml", "120s"],
      [".github/workflows/ci-build-artifacts-testbox.yml", "120s"],
      [".github/workflows/crabbox-hydrate.yml", "30s"],
    ];

    for (const [workflowPath, timeoutSeconds] of workflowPaths) {
      const workflow = readFileSync(workflowPath, "utf8");
      const fetchTimeouts = workflow.match(
        new RegExp(
          `timeout --signal=TERM[^\\n]* ${timeoutSeconds} git(?: -C "(?:\\$workdir|\\$GITHUB_WORKSPACE|clawhub-source)")?`,
          "g",
        ),
      );

      expect(fetchTimeouts?.length, workflowPath).toBeGreaterThan(0);
      expect(
        fetchTimeouts?.every((line) =>
          line.startsWith(`timeout --signal=TERM --kill-after=10s ${timeoutSeconds} git`),
        ),
        workflowPath,
      ).toBe(true);
    }
  });

  it("bounds shared base commit fetches", () => {
    const action = readFileSync(".github/actions/ensure-base-commit/action.yml", "utf8");

    expect(action).toContain("fetch_base_ref()");
    expect(action).toContain("timeout --signal=TERM --kill-after=10s 30s git");
    expect(action).toContain("-c protocol.version=2");
    expect(action).not.toContain("if ! git fetch --no-tags");
  });

  it("bounds early unauthenticated checkout fetches", () => {
    const workflow = readCiWorkflow();

    for (const jobName of ["preflight", "security-fast", "skills-python"]) {
      const checkoutStep = workflow.jobs[jobName].steps.find((step) => step.name === "Checkout");

      expect(checkoutStep.run, jobName).toContain(
        'timeout --signal=TERM --kill-after=10s 120s git -C "$GITHUB_WORKSPACE"',
      );
      expect(checkoutStep.run, jobName).toContain("for attempt in 1 2 3");
      expect(checkoutStep.run, jobName).toContain("timed out on attempt $attempt; retrying");
      expect(checkoutStep.run, jobName).not.toContain("if timeout --signal=TERM");
      expect(checkoutStep.run, jobName).toContain("-c protocol.version=2");
      const expectedDepth = jobName === "preflight" ? 2 : 1;
      expect(checkoutStep.run, jobName).toContain(
        `fetch --no-tags --prune --no-recurse-submodules --depth=${expectedDepth} origin`,
      );
      if (jobName !== "skills-python") {
        expect(checkoutStep.run, jobName).toContain('if [ "$fetch_status" = "124" ]');
        expect(checkoutStep.run, jobName).toContain("timed out");
      }
      expect(checkoutStep.run, jobName).not.toContain(
        'git -C "$GITHUB_WORKSPACE" fetch --no-tags --depth=1',
      );
    }
  });

  it("retries workflow sanity checkout fetch timeouts", () => {
    const workflow = readWorkflowSanityWorkflow();

    for (const jobName of ["no-tabs", "actionlint", "generated-doc-baselines"]) {
      const checkoutStep = workflow.jobs[jobName].steps.find((step) => step.name === "Checkout");

      expect(checkoutStep.run, jobName).toContain("fetch_checkout_ref()");
      expect(checkoutStep.run, jobName).toContain("for attempt in 1 2 3");
      expect(checkoutStep.run, jobName).toContain(
        'timeout --signal=TERM --kill-after=10s 30s git -C "$GITHUB_WORKSPACE"',
      );
      expect(checkoutStep.run, jobName).toContain(
        'if [ "$fetch_status" != "124" ] && [ "$fetch_status" != "137" ]; then',
      );
      expect(checkoutStep.run, jobName).toContain("timed out on attempt $attempt; retrying");
      expect(checkoutStep.run, jobName).toContain(
        "fetch --no-tags --prune --no-recurse-submodules --depth=1 origin",
      );
    }
  });

  it("runs plugin SDK API and surface drift checks in workflow sanity", () => {
    const workflow = readWorkflowSanityWorkflow();
    const steps = workflow.jobs["generated-doc-baselines"].steps;
    const stepNames = steps.map((step) => step.name);

    expect(stepNames).toContain("Check plugin SDK API baseline drift");
    expect(stepNames).toContain("Check plugin SDK surface budget");
    expect(stepNames.indexOf("Check plugin SDK API baseline drift")).toBeLessThan(
      stepNames.indexOf("Check plugin SDK surface budget"),
    );
    expect(steps.find((step) => step.name === "Check plugin SDK surface budget").run).toBe(
      "pnpm plugin-sdk:surface:check",
    );
  });

  it("bounds platform checkout fetches without GNU timeout", () => {
    const source = readFileSync(".github/workflows/ci.yml", "utf8");
    const workflow = readCiWorkflow();

    expect(source.match(/&platform_checkout_step/gu) ?? []).toHaveLength(1);
    expect(source.match(/\*platform_checkout_step/gu) ?? []).toHaveLength(3);
    expect(source.match(/fetch_checkout_ref_once\(\)/gu) ?? []).toHaveLength(1);

    for (const jobName of ["checks-windows", "macos-node", "macos-swift", "ios-build"]) {
      const checkoutStep = workflow.jobs[jobName].steps.find((step) => step.name === "Checkout");

      expect(checkoutStep.run, jobName).toContain("fetch_checkout_ref()");
      expect(checkoutStep.run, jobName).toContain("fetch_checkout_ref_once()");
      expect(checkoutStep.run, jobName).toContain("for attempt in 1 2 3");
      expect(checkoutStep.run, jobName).toContain("fetch_timeout_seconds=90");
      expect(checkoutStep.run, jobName).toContain("-c protocol.version=2");
      expect(checkoutStep.run, jobName).toContain(
        "fetch --no-tags --prune --no-recurse-submodules --depth=1 origin",
      );
      expect(checkoutStep.run, jobName).toContain(
        'if [ "$elapsed" -ge "$fetch_timeout_seconds" ]; then',
      );
      expect(checkoutStep.run, jobName).toContain('kill -TERM "$fetch_pid"');
      expect(checkoutStep.run, jobName).toContain('kill -KILL "$fetch_pid"');
      expect(checkoutStep.run, jobName).toContain(
        'if [ "$fetch_status" != "124" ] && [ "$fetch_status" != "137" ]; then',
      );
      expect(checkoutStep.run, jobName).toContain("timed out on attempt $attempt; retrying");
      expect(checkoutStep.run, jobName).not.toContain(
        'git -C "$GITHUB_WORKSPACE" fetch --no-tags --depth=1',
      );
    }
  });

  it("resets SwiftPM state between macOS release build retries", () => {
    const workflow = readCiWorkflow();
    const macosInstallStep = workflow.jobs["macos-swift"].steps.find(
      (step) => step.name === "Install XcodeGen / SwiftLint / SwiftFormat",
    );
    const iosInstallStep = workflow.jobs["ios-build"].steps.find(
      (step) => step.name === "Install iOS Swift tooling",
    );
    const macosLintStep = workflow.jobs["macos-swift"].steps.find(
      (step) => step.name === "Swift lint",
    );
    const iosLintStep = workflow.jobs["ios-build"].steps.find((step) => step.name === "Swift lint");
    const buildStep = workflow.jobs["macos-swift"].steps.find(
      (step) => step.name === "Swift build (release)",
    );

    for (const installStep of [macosInstallStep, iosInstallStep]) {
      expect(installStep.run).toContain("if [[ -x ./scripts/install-swift-tools.sh ]]; then");
      expect(installStep.run).toContain("brew install xcodegen swiftlint swiftformat");
    }
    for (const lintStep of [macosLintStep, iosLintStep]) {
      expect(lintStep.run).toContain(
        "if [[ -x ./scripts/lint-swift.sh && -x ./scripts/format-swift.sh ]]; then",
      );
    }
    expect(macosLintStep.run).toContain("swiftlint lint --config config/swiftlint.yml");
    expect(macosLintStep.run).toContain("swiftformat --lint apps/macos/Sources");
    expect(iosLintStep.run).toContain("skipping iOS lint for this frozen target");
    expect(buildStep.run).toContain("for attempt in 1 2 3");
    expect(buildStep.run).toContain('if [[ "$attempt" -eq 3 ]]; then');
    expect(buildStep.run).toContain("swift package --package-path apps/macos reset");
    expect(buildStep.run.indexOf("swift package --package-path apps/macos reset")).toBeGreaterThan(
      buildStep.run.indexOf("swift build failed"),
    );
  });

  it("bounds the Windows Crabbox hydrate main fetch", () => {
    const workflow = readFileSync(".github/workflows/crabbox-hydrate.yml", "utf8");

    expect(workflow).toContain("$fetchInfo = New-Object System.Diagnostics.ProcessStartInfo");
    expect(workflow).toContain('$fetchInfo.FileName = "git"');
    expect(workflow).toContain("$fetchInfo.WorkingDirectory = $repo");
    expect(workflow).toContain("$fetchInfo.UseShellExecute = $false");
    expect(workflow).not.toContain("$fetchInfo.RedirectStandardOutput = $true");
    expect(workflow).not.toContain("$fetchInfo.RedirectStandardError = $true");
    expect(workflow).toContain(
      "--no-tags --no-progress --prune --no-recurse-submodules --depth=50",
    );
    expect(workflow).toContain("$fetch = New-Object System.Diagnostics.Process");
    expect(workflow).toContain("$fetch.StartInfo = $fetchInfo");
    expect(workflow).toContain("$fetch.WaitForExit(30000)");
    expect(workflow).toContain("$fetch.Kill()");
    expect(workflow).not.toContain("StandardOutput.ReadToEnd()");
    expect(workflow).not.toContain("StandardError.ReadToEnd()");
    expect(workflow).toContain('throw "git fetch failed with exit code $($fetch.ExitCode)"');
    expect(workflow).toContain('throw "git fetch timed out after 30 seconds"');
    expect(workflow).not.toContain(
      'git fetch --no-tags --depth=50 origin "+refs/heads/main:refs/remotes/origin/main"',
    );
  });

  it("fails Windows Testbox setup when Blacksmith phone-home is not accepted", () => {
    const workflow = readFileSync(".github/workflows/windows-blacksmith-testbox.yml", "utf8");

    expect(workflow).toContain('echo "phone_home_hydrating_http=${hydrating_http_code}"');
    expect(workflow).toContain('echo "phone_home_ready_http=${http_code}"');
    expect(workflow).toContain('jq -e \'type == "number"\' <<<"$installation_model_id"');
    expect(workflow).toContain('--arg testbox_id "$TESTBOX_ID"');
    expect(workflow).toContain('--arg testbox_id "$testbox_id"');
    expect(workflow).toContain('--argjson installation_model_id "$installation_model_id"');
    expect(workflow).toContain('--data-binary @"$hydrating_body"');
    expect(workflow).toContain('--data-binary @"$ready_body"');
    const hydratingFailureBlock = workflow.slice(
      workflow.indexOf('if [[ ! "$hydrating_http_code" =~ ^2 ]]; then'),
      workflow.indexOf('response="$(cat "$hydrating_response")"'),
    );
    const missingSshKeyFailureBlock = workflow.slice(
      workflow.indexOf('if [ -z "$ssh_public_key" ]; then'),
      workflow.indexOf("mkdir -p ~/.ssh"),
    );
    const readyFailureBlock = workflow.slice(
      workflow.indexOf('if [[ ! "$http_code" =~ ^2 ]]; then'),
      workflow.indexOf('echo "============================================"'),
    );

    expect(hydratingFailureBlock).toContain("exit 1");
    expect(missingSshKeyFailureBlock).toContain("exit 1");
    expect(readyFailureBlock).toContain("exit 1");
    expect(workflow).toContain(
      "Blacksmith phone-home did not return an SSH public key; testbox cannot accept CLI connections.",
    );
    expect(workflow).not.toContain(
      'phone_home_ready_http=${http_code}"\n\n          echo "============================================"',
    );
    expect(workflow).not.toContain('\\"testbox_id\\": \\"${TESTBOX_ID}\\"');
    expect(workflow).not.toContain('cat > "$ready_body" <<JSON');
    expect(workflow).not.toContain('"testbox_id": "${testbox_id}"');
  });

  it("runs dependency policy guards in PR CI preflight", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const preflightGuards = workflow.slice(
      workflow.indexOf("guards)"),
      workflow.indexOf("shrinkwrap)"),
    );
    const shrinkwrapGuards = workflow.slice(
      workflow.indexOf("shrinkwrap)"),
      workflow.indexOf("prod-types)"),
    );

    expect(workflow).toContain("check-guards");
    expect(workflow).toContain("check-shrinkwrap");
    expect(shrinkwrapGuards).toContain("pnpm deps:shrinkwrap:check");
    expect(preflightGuards).toContain("pnpm deps:patches:check");
  });

  it("runs mobile protocol coverage for Node and native-only changes", () => {
    const workflow = readCiWorkflow();
    const coverageStep = workflow.jobs.preflight.steps.find(
      (step) => step.name === "Check mobile protocol event coverage",
    );
    const checkShardRun = workflow.jobs["check-shard"].steps.find(
      (step) => step.name === "Run check shard",
    ).run;

    expect(coverageStep.run).toBe("node scripts/check-protocol-event-coverage.mjs");
    expect(coverageStep.if).toContain("steps.manifest.outputs.run_node == 'true'");
    expect(coverageStep.if).toContain("steps.manifest.outputs.run_ios_build == 'true'");
    expect(coverageStep.if).toContain("steps.manifest.outputs.run_android_job == 'true'");
    expect(checkShardRun).not.toContain("check:protocol-coverage");
  });

  it("does not rebuild Control UI after build:ci-artifacts", () => {
    const workflow = readCiWorkflow();
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const buildDistStep = buildArtifactSteps.find((step) => step.name === "Build dist");

    expect(buildDistStep.run).toBe("pnpm build:ci-artifacts");
    expect(buildArtifactSteps.map((step) => step.name)).not.toContain("Build Control UI");
    expect(buildArtifactSteps.some((step) => step.run === "pnpm ui:build")).toBe(false);
  });

  it("keeps the hosted plugin-list memory allowance scoped to GitHub-hosted runners", () => {
    const workflow = readCiWorkflow();
    const startupMemoryStep = workflow.jobs["build-artifacts"].steps.find(
      (step) => step.name === "Check CLI startup memory",
    );

    expect(startupMemoryStep.env.OPENCLAW_STARTUP_MEMORY_PLUGINS_LIST_MB).toBe(
      "${{ runner.environment == 'github-hosted' && '425' || '350' }}",
    );
  });

  it("restores the dist build cache before building and saves only cache misses", () => {
    const workflow = readCiWorkflow();
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const stepNames = buildArtifactSteps.map((step) => step.name);
    const restoreStep = buildArtifactSteps.find((step) => step.name === "Restore dist build cache");
    const buildDistStep = buildArtifactSteps.find((step) => step.name === "Build dist");
    const saveStep = buildArtifactSteps.find((step) => step.name === "Save dist build cache");

    expect(stepNames.indexOf("Restore dist build cache")).toBeLessThan(
      stepNames.indexOf("Build dist"),
    );
    expect(stepNames.indexOf("Build dist")).toBeLessThan(
      stepNames.indexOf("Pack built runtime artifacts"),
    );
    expect(stepNames.indexOf("Run built artifact checks")).toBeLessThan(
      stepNames.indexOf("Save dist build cache"),
    );
    expect(restoreStep.uses).toBe(CACHE_V5);
    expect(buildDistStep.if).toBe("steps.dist_build_cache.outputs.cache-hit != 'true'");
    expect(saveStep.uses).toBe("actions/cache/save@27d5ce7f107fe9357f9df03efb73ab90386fccae");
    expect(saveStep.if).toBe("steps.dist_build_cache.outputs.cache-hit != 'true'");
    expect(saveStep.with.key).toBe("${{ steps.dist_build_cache.outputs.cache-primary-key }}");
    expect(restoreStep.with.path).toContain("dist/");
    expect(restoreStep.with.path).toContain("dist-runtime/");
    expect(restoreStep.with.path).toContain("packages/*/dist/");
    expect(saveStep.with.path).toContain("packages/*/dist/");
    expect(restoreStep.with.key).toContain("dist-build-v3-");
    expect(
      buildArtifactSteps.find((step) => step.name === "Pack built runtime artifacts").run,
    ).toContain("packages/*/dist");
    expect(restoreStep.with.path).toContain("extensions/*/src/host/**/.bundle.hash");
    expect(restoreStep.with.path).toContain("extensions/*/src/host/**/*.bundle.js");
    expect(buildArtifactSteps.map((step) => step.name)).not.toContain("Cache dist build");
  });

  it("keeps the AI runtime in Testbox build artifact caches", () => {
    const workflow = readBuildArtifactsTestboxWorkflow();
    const steps = workflow.jobs["build-artifacts"].steps;
    const resolveSeedsStep = steps.find((step) => step.name === "Resolve release dist cache seeds");
    const restoreStep = steps.find((step) => step.name === "Restore dist build cache");
    const verifyStep = steps.find((step) => step.name === "Verify build artifacts");
    const saveStep = steps.find((step) => step.name === "Save dist build cache");

    expect(resolveSeedsStep.run).toContain('cache_prefix="${RUNNER_OS}-dist-build-v2-"');
    expect(restoreStep.with.path).toContain("packages/*/dist/");
    expect(restoreStep.with.key).toContain("dist-build-v2-");
    expect(verifyStep.run).toContain("test -f packages/ai/dist/internal/runtime.mjs");
    expect(saveStep.with.path).toContain("packages/*/dist/");
    expect(saveStep.with.key).toContain("dist-build-v2-");
  });

  it("runs gateway watch after parallel built artifact checks", () => {
    const workflow = readCiWorkflow();
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const builtArtifactChecks = buildArtifactSteps.find(
      (step) => step.name === "Run built artifact checks",
    );
    const run = builtArtifactChecks.run;

    expect(run).toContain('start_check "channels"');
    expect(run).toContain('start_check "core-support-boundary"');
    expect(run).not.toContain('start_check "gateway-watch"');
    expect(run.indexOf('for index in "${!pids[@]}"')).toBeLessThan(
      run.indexOf('if [ "$RUN_GATEWAY_WATCH" = "true" ]; then'),
    );
    expect(run).toContain(
      'node scripts/check-gateway-watch-regression.mjs --skip-build >"$log" 2>&1',
    );
  });

  it("keeps docs i18n CI on the patched preferred Go toolchain", () => {
    const workflow = readCiWorkflow();
    const nodeTestJob = workflow.jobs["checks-node-core-test-nondist-shard"];
    const setupGoStep = nodeTestJob.steps.find((step) => step.name === "Setup Go for docs i18n");
    const verifyGoStep = nodeTestJob.steps.find(
      (step) => step.name === "Verify docs i18n Go toolchain",
    );
    expect(setupGoStep).toMatchObject({
      if: "matrix.requires_go == true",
      uses: SETUP_GO_V6,
      with: {
        "go-version-file": "scripts/docs-i18n/go.mod",
        "cache-dependency-path": "scripts/docs-i18n/go.sum",
      },
    });
    expect(setupGoStep.with).not.toHaveProperty("go-version");
    expect(verifyGoStep).toMatchObject({
      if: "matrix.requires_go == true",
      run: 'test "$(go env GOVERSION)" = "go1.25.12"',
    });

    const goMod = readTrackedText("scripts/docs-i18n/go.mod");
    expect(goMod).toMatch(/^go 1\.25\.0$/mu);
    expect(goMod).toMatch(/^toolchain go1\.25\.12$/mu);
  });

  it("fails and retries quiet Node test shard stalls quickly", () => {
    const workflow = readCiWorkflow();
    const preflightJob = workflow.jobs.preflight;
    const manifestStep = preflightJob.steps.find((step) => step.name === "Build CI manifest");
    const nodeTestJob = workflow.jobs["checks-node-core-test-nondist-shard"];
    const runStep = nodeTestJob.steps.find((step) => step.name === "Run Node test shard");

    expect(JSON.stringify(preflightJob.steps)).toContain("timeout_minutes: shard.timeoutMinutes");
    expect(manifestStep.run).toContain(
      'shard.groups?.some((group) => group.shard_name === "core-tooling")',
    );
    expect(nodeTestJob["timeout-minutes"]).toBe("${{ matrix.timeout_minutes || 60 }}");
    expect(runStep.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe("300000");
    expect(runStep.env.OPENCLAW_VITEST_NO_OUTPUT_RETRY).toBe("1");
    expect(runStep.env.OPENCLAW_TEST_PROJECTS_PARALLEL).toBe("2");
    expect(runStep.env.OPENCLAW_NODE_TEST_ENV_JSON).toBe("${{ toJson(matrix.env) }}");
    expect(runStep.run).toContain("env: JSON.parse(process.env.OPENCLAW_NODE_TEST_ENV_JSON");
    expect(runStep.run).toContain('if (plan.env && typeof plan.env === "object"');
    expect(runStep.run).toContain("childEnv[key] = value");
  });

  it("keeps the CI timing summary parked for timing optimization work", () => {
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain(
      "Re-enable this job when we want to collect CI timing data for timing optimization.",
    );

    const workflow = readCiWorkflow();
    const timingJob = workflow.jobs["ci-timings-summary"];

    expect(timingJob.permissions).toMatchObject({ actions: "read", contents: "read" });
    expect(timingJob.needs).toEqual([
      "preflight",
      "security-fast",
      "pnpm-store-warmup",
      "build-artifacts",
      "checks-fast-core",
      "checks-fast-plugin-contracts-shard",
      "checks-fast-channel-contracts-shard",
      "checks-node-compat",
      "checks-node-core-test-nondist-shard",
      "check-shard",
      "check-additional-shard",
      "check-docs",
      "skills-python",
      "checks-windows",
      "macos-node",
      "macos-swift",
      "ios-build",
      "android",
    ]);
    expect(timingJob.if).toContain("false");
    expect(timingJob.if).toContain("always()");
    expect(timingJob.if).toContain("!cancelled()");

    const checkoutStep = timingJob.steps.find(
      (step) => step.name === "Checkout timing summary helper",
    );
    expect(checkoutStep.uses).toBe(CHECKOUT_V6);
    expect(checkoutStep.with.ref).toBe(
      "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || needs.preflight.outputs.checkout_revision || github.sha }}",
    );
    expect(checkoutStep.with["persist-credentials"]).toBe(false);

    const writeStep = timingJob.steps.find((step) => step.name === "Write CI timing summary");
    expect(writeStep.env).toMatchObject({ GH_TOKEN: "${{ github.token }}" });
    expect(writeStep.run).toContain(
      'node scripts/ci-run-timings.mjs "$GITHUB_RUN_ID" --limit 25 > ci-timings-summary.txt',
    );
    expect(writeStep.run).toContain('cat ci-timings-summary.txt >> "$GITHUB_STEP_SUMMARY"');

    const uploadStep = timingJob.steps.find((step) => step.name === "Upload CI timing summary");
    expect(uploadStep.uses).toBe(UPLOAD_ARTIFACT_V7);
    expect(uploadStep.with).toMatchObject({
      name: "ci-timings-summary",
      path: "ci-timings-summary.txt",
      "retention-days": 14,
    });
  });

  it("keeps maturity scorecard generated QA evidence handoff strict", () => {
    const maturityWorkflow = readMaturityScorecardWorkflow();
    const qaEvidenceWorkflow = readQaProfileEvidenceWorkflow();
    const generateJob = maturityWorkflow.jobs.generate_qa_evidence;
    const publisherPreflight = maturityWorkflow.jobs.publisher_preflight;
    const publishJob = maturityWorkflow.jobs.publish;
    const publishPrJob = maturityWorkflow.jobs.publish_generated_pr;
    const qaRunJob = qaEvidenceWorkflow.jobs.run_qa_profile;

    expect(maturityWorkflow.on.workflow_call.inputs).toMatchObject({
      qa_evidence_run_id: {
        description: "Optional workflow run id containing qa-evidence.json",
        required: false,
        default: "",
        type: "string",
      },
      ref: {
        description: "OpenClaw branch, tag, or SHA containing the maturity score source",
        required: true,
        type: "string",
      },
      expected_sha: {
        description: "Optional full SHA that ref must resolve to",
        required: false,
        default: "",
        type: "string",
      },
    });
    expect(maturityWorkflow.on.workflow_dispatch.inputs.publish_pull_request).toEqual({
      description: "Open or update a pull request for generated maturity files",
      required: false,
      default: true,
      type: "boolean",
    });
    expect(maturityWorkflow.on.workflow_call.inputs).not.toHaveProperty("publish_pull_request");
    expect(maturityWorkflow.on.workflow_call.secrets.OPENAI_API_KEY.required).toBe(true);
    expect(
      maturityWorkflow.on.workflow_call.secrets.OPENCLAW_MATURITY_SCORECARD_AGENT_OPENAI_API_KEY
        .required,
    ).toBe(false);
    expect(Object.keys(maturityWorkflow.on.workflow_call.secrets).sort()).toEqual([
      "CLAWSWEEPER_APP_PRIVATE_KEY",
      "MANTIS_GITHUB_APP_ID",
      "MANTIS_GITHUB_APP_PRIVATE_KEY",
      "OPENAI_API_KEY",
      "OPENCLAW_MATURITY_SCORECARD_AGENT_OPENAI_API_KEY",
    ]);
    for (const secret of [
      "CLAWSWEEPER_APP_PRIVATE_KEY",
      "MANTIS_GITHUB_APP_ID",
      "MANTIS_GITHUB_APP_PRIVATE_KEY",
    ]) {
      expect(maturityWorkflow.on.workflow_call.secrets[secret].required).toBe(false);
    }
    expect(qaEvidenceWorkflow.on.workflow_dispatch.inputs).not.toHaveProperty("fail_on_qa_failure");
    expect(qaEvidenceWorkflow.on.workflow_call.inputs).not.toHaveProperty("fail_on_qa_failure");
    expect(qaEvidenceWorkflow.on.workflow_dispatch.inputs.qa_profile).not.toHaveProperty("options");
    expect(qaEvidenceWorkflow.on.workflow_dispatch.inputs.qa_profile.default).toBe("all");
    expect(qaEvidenceWorkflow.on.workflow_call.inputs.qa_profile.type).toBe("string");
    const validateProfileStep = qaRunJob.steps.find(
      (step) => step.name === "Validate QA profile input",
    );
    expect(validateProfileStep.run).toContain(
      "taxonomy.profiles.find((entry) => entry.id === requested)",
    );
    expect(validateProfileStep.run).toContain("profile=${profile.id}");
    const ensurePlaywrightStep = qaRunJob.steps.find(
      (step) => step.name === "Ensure Playwright Chromium",
    );
    expect(ensurePlaywrightStep.run).toBe("node scripts/ensure-playwright-chromium.mjs");
    expect(generateJob.needs).toEqual(["validate_selected_ref", "publisher_preflight"]);
    expect(generateJob.if.replace(/\s+/gu, " ")).toBe(
      "${{ always() && needs.validate_selected_ref.result == 'success' && (!inputs.publish_pull_request || needs.publisher_preflight.result == 'success') && inputs.qa_evidence_run_id == '' }}",
    );
    expect(generateJob.uses).toBe("./.github/workflows/qa-profile-evidence.yml");
    expect(generateJob.with).toMatchObject({
      // Keep the caller's ref while the callee verifies it against expected_sha.
      ref: "${{ inputs.ref }}",
      expected_sha: "${{ needs.validate_selected_ref.outputs.selected_revision }}",
      qa_profile: "all",
    });
    expect(generateJob.with).not.toHaveProperty("fail_on_qa_failure");

    const workflowStep = maturityWorkflow.jobs.validate_selected_ref.steps.find(
      (step) => step.name === "Resolve job workflow identity",
    );
    const authorizeStep = maturityWorkflow.jobs.validate_selected_ref.steps.find(
      (step) => step.name === "Authorize workflow invocation",
    );
    const validateRefStep = maturityWorkflow.jobs.validate_selected_ref.steps.find(
      (step) => step.name === "Validate selected ref",
    );
    expect(workflowStep.env.JOB_CONTEXT).toBe("${{ toJSON(job) }}");
    expect(workflowStep.run).toContain("job.workflow_sha must be a full lowercase commit SHA");
    expect(authorizeStep.env).toEqual({
      CALLER_EVENT_NAME: "${{ github.event_name }}",
      CALLER_WORKFLOW_REF: "${{ github.workflow_ref }}",
      JOB_WORKFLOW_FILE_PATH: "${{ steps.workflow.outputs.workflow_file_path }}",
      JOB_WORKFLOW_REF: "${{ steps.workflow.outputs.workflow_ref }}",
      JOB_WORKFLOW_REPOSITORY: "${{ steps.workflow.outputs.workflow_repository }}",
      PUBLISH_PULL_REQUEST: "${{ inputs.publish_pull_request || false }}",
    });
    expect(authorizeStep.run).toContain(
      `expected_workflow_ref="${MATURITY_SCORECARD_WORKFLOW_REF}"`,
    );
    expect(authorizeStep.run).toContain(
      '[[ "$PUBLISH_PULL_REQUEST" == "true" && "$canonical_direct" != "true" ]]',
    );
    expect(authorizeStep.run).toContain(
      "Reusable maturity workflows are artifact-only and cannot publish pull requests.",
    );
    expect(validateRefStep.env.EXPECTED_SHA).toBe("${{ inputs.expected_sha }}");
    expect(validateRefStep.env.PUBLISH_PULL_REQUEST).toBe("${{ inputs.publish_pull_request }}");
    expect(validateRefStep.env).not.toHaveProperty("TRUSTED_WORKFLOW_SHA");
    expect(validateRefStep.env.EVIDENCE_RUN_ID).toBe(
      "${{ inputs.qa_evidence_run_id || github.run_id }}",
    );
    for (const fragment of [
      "expected_sha must be a full 40-character SHA",
      'branch_candidate="${INPUT_REF#refs/heads/}"',
      'branch_lookup_status="$?"',
      "2) ;;",
      "Unable to determine whether '${INPUT_REF}' is a remote branch",
      'git merge-base --is-ancestor "$selected_revision"',
      "':(exclude)qa/maturity-scores.yaml'",
      "':(exclude)docs/maturity/scorecard.md'",
      "':(exclude)docs/maturity/taxonomy.md'",
      "qa_evidence_run_id must be a numeric GitHub Actions run id",
      'publication_head="automation/maturity-scorecard-',
    ]) {
      expect(validateRefStep.run).toContain(fragment);
    }
    expect(maturityWorkflow.jobs.validate_selected_ref.outputs).toMatchObject({
      publication_base: "${{ steps.validate.outputs.publication_base }}",
      publication_head: "${{ steps.validate.outputs.publication_head }}",
      workflow_file_path: "${{ steps.workflow.outputs.workflow_file_path }}",
      workflow_ref: "${{ steps.workflow.outputs.workflow_ref }}",
      workflow_repository: "${{ steps.workflow.outputs.workflow_repository }}",
      workflow_sha: "${{ steps.workflow.outputs.workflow_sha }}",
    });

    const trustedPublisherCondition = [
      "${{ inputs.publish_pull_request &&",
      "github.event_name == 'workflow_dispatch' &&",
      `github.workflow_ref == '${MATURITY_SCORECARD_WORKFLOW_REF}' &&`,
      `needs.validate_selected_ref.outputs.workflow_file_path == '${MATURITY_SCORECARD_WORKFLOW}' &&`,
      `needs.validate_selected_ref.outputs.workflow_ref == '${MATURITY_SCORECARD_WORKFLOW_REF}' &&`,
      "needs.validate_selected_ref.outputs.workflow_repository == 'openclaw/openclaw' }}",
    ].join(" ");
    expect(publisherPreflight.needs).toBe("validate_selected_ref");
    expect(publisherPreflight.if).toBe("${{ inputs.publish_pull_request }}");
    const preflightCheckoutStep = publisherPreflight.steps.find(
      (step) => step.name === "Checkout trusted workflow source",
    );
    const preflightTokensStep = publisherPreflight.steps.find(
      (step) => step.name === "Create generated PR tokens",
    );
    expect(preflightCheckoutStep).toMatchObject({
      uses: CHECKOUT_V6,
      with: {
        repository: "${{ needs.validate_selected_ref.outputs.workflow_repository }}",
        ref: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
        "persist-credentials": false,
        submodules: false,
      },
    });
    expect(preflightTokensStep.if.replace(/\s+/gu, " ")).toBe(trustedPublisherCondition);
    expect(preflightTokensStep).toMatchObject({
      uses: "./.github/actions/create-generated-pr-tokens",
      with: {
        "contents-client-id": "Iv23liOECG0slfuhz093",
        "contents-private-key": "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
        "pull-request-app-id": "${{ secrets.MANTIS_GITHUB_APP_ID }}",
        "pull-request-private-key": "${{ secrets.MANTIS_GITHUB_APP_PRIVATE_KEY }}",
      },
    });
    expect(publishJob.needs).toEqual([
      "validate_selected_ref",
      "publisher_preflight",
      "generate_qa_evidence",
    ]);
    expect(publishJob.if.replace(/\s+/gu, " ")).toBe(
      "${{ always() && needs.validate_selected_ref.result == 'success' && (!inputs.publish_pull_request || needs.publisher_preflight.result == 'success') && (inputs.qa_evidence_run_id != '' || needs.generate_qa_evidence.result == 'success') }}",
    );
    expect(JSON.stringify(publishJob)).not.toMatch(
      /CLAWSWEEPER_APP_PRIVATE_KEY|MANTIS_GITHUB_APP/u,
    );

    const generatedDownloadStep = publishJob.steps.find(
      (step) => step.name === "Download generated QA evidence artifact",
    );
    expect(generatedDownloadStep.if).toBe("${{ inputs.qa_evidence_run_id == '' }}");
    expect(generatedDownloadStep.env.GENERATED_ARTIFACT_NAME).toBe(
      "${{ needs.generate_qa_evidence.outputs.artifact_name }}",
    );
    expect(generatedDownloadStep.run).toContain('gh run download "$GITHUB_RUN_ID"');
    expect(generatedDownloadStep.run).toContain('--name "$GENERATED_ARTIFACT_NAME"');
    expect(generatedDownloadStep.run).not.toContain("--pattern");

    const requireEvidenceStep = publishJob.steps.find(
      (step) => step.name === "Require one QA evidence file",
    );
    expect(requireEvidenceStep.run).toContain("Expected exactly one qa-evidence.json file");

    const validateManifestStep = publishJob.steps.find(
      (step) => step.name === "Validate QA evidence manifest",
    );
    expect(validateManifestStep.run).toContain("qa-profile-evidence-manifest.json");
    expect(validateManifestStep.run).toContain("qa-evidence.json profile must be all");
    expect(validateManifestStep.run).toContain("QA evidence manifest profile must be all");
    expect(validateManifestStep.run).toContain("manifest.targetSha !== targetSha");

    expect(qaRunJob.outputs.artifact_name).toBe("${{ steps.evidence.outputs.artifact_name }}");
    const qaEvidenceStep = qaRunJob.steps.find(
      (step) => step.name === "Validate QA profile evidence",
    );
    expect(qaEvidenceStep.env.ARTIFACT_NAME).toBe(
      "qa-profile-evidence-${{ steps.profile.outputs.profile }}-${{ needs.validate_selected_ref.outputs.selected_revision }}",
    );
    expect(qaEvidenceStep.run).toContain("qa-profile-evidence-manifest.json");

    const qaUploadStep = qaRunJob.steps.find((step) => step.name === "Upload QA profile evidence");
    expect(qaUploadStep.with).toMatchObject({
      name: "qa-profile-evidence-${{ steps.profile.outputs.profile }}-${{ needs.validate_selected_ref.outputs.selected_revision }}",
      path: "${{ steps.run_profile.outputs.output_dir }}",
      "if-no-files-found": "error",
    });

    const qaFailStep = qaRunJob.steps.find((step) => step.name === "Fail if QA profile failed");
    expect(qaFailStep.if).toBe("always()");

    const renderCheckoutStep = publishJob.steps.find(
      (step) => step.name === "Checkout selected ref",
    );
    const generatedPrUploadStep = publishJob.steps.find(
      (step) => step.name === "Upload generated PR files",
    );
    expect(renderCheckoutStep.with["fetch-depth"]).toBe(0);
    expect(generatedPrUploadStep).toMatchObject({
      if: "${{ inputs.publish_pull_request }}",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        name: "maturity-scorecard-pr-${{ github.run_id }}-${{ github.run_attempt }}",
        "retention-days": 1,
        "if-no-files-found": "error",
      },
    });
    expect(generatedPrUploadStep.with.path.trim().split("\n")).toEqual(MATURITY_GENERATED_PR_PATHS);

    expect(publishPrJob.needs).toEqual(["validate_selected_ref", "publisher_preflight", "publish"]);
    expect(publishPrJob["runs-on"]).toBe("ubuntu-24.04");
    for (const fragment of [
      "needs.publisher_preflight.result == 'success'",
      "needs.publish.result == 'success'",
      `github.workflow_ref == '${MATURITY_SCORECARD_WORKFLOW_REF}'`,
      `needs.validate_selected_ref.outputs.workflow_ref == '${MATURITY_SCORECARD_WORKFLOW_REF}'`,
    ]) {
      expect(publishPrJob.if).toContain(fragment);
    }
    const trustedPublishCheckoutStep = publishPrJob.steps.find(
      (step) => step.name === "Checkout trusted workflow source",
    );
    const selectedCheckoutStep = publishPrJob.steps.find(
      (step) => step.name === "Checkout selected ref",
    );
    const downloadPrFilesStep = publishPrJob.steps.find(
      (step) => step.name === "Download generated PR files",
    );
    const openDocsPrStep = publishPrJob.steps.find(
      (step) => step.name === "Open or update generated docs PR",
    );
    expect(trustedPublishCheckoutStep).toMatchObject({
      uses: CHECKOUT_V6,
      with: {
        repository: "${{ needs.validate_selected_ref.outputs.workflow_repository }}",
        ref: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
        "persist-credentials": false,
      },
    });
    expect(selectedCheckoutStep).toMatchObject({
      uses: CHECKOUT_V6,
      with: {
        ref: "${{ needs.validate_selected_ref.outputs.selected_revision }}",
        path: "selected",
        "fetch-depth": 0,
        "persist-credentials": false,
      },
    });
    expect(downloadPrFilesStep).toMatchObject({
      uses: DOWNLOAD_ARTIFACT_V8,
      with: {
        name: "maturity-scorecard-pr-${{ github.run_id }}-${{ github.run_attempt }}",
        path: "${{ steps.staging.outputs.path }}",
      },
    });
    expect(openDocsPrStep.if.replace(/\s+/gu, " ")).toBe(trustedPublisherCondition);
    expect(openDocsPrStep.uses).toBe("./.github/actions/publish-generated-pr");
    expect(openDocsPrStep.with).toMatchObject({
      "contents-client-id": "Iv23liOECG0slfuhz093",
      "contents-private-key": "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
      "pull-request-app-id": "${{ secrets.MANTIS_GITHUB_APP_ID }}",
      "pull-request-private-key": "${{ secrets.MANTIS_GITHUB_APP_PRIVATE_KEY }}",
      "base-branch": "${{ needs.validate_selected_ref.outputs.publication_base }}",
      "head-branch": "${{ needs.validate_selected_ref.outputs.publication_head }}",
      "working-directory": "selected",
      "commit-message": "docs: update maturity scorecard",
      "pr-title": "docs: update maturity scorecard",
      "overlap-policy": "fail",
    });
    expect(openDocsPrStep.with["generated-paths"].trim().split("\n")).toEqual(
      MATURITY_GENERATED_PR_PATHS,
    );
    expect(openDocsPrStep.with["invalidation-paths"].trim().split("\n")).toEqual([
      ".",
      ":(exclude)qa/maturity-scores.yaml",
      ":(exclude)docs/maturity/scorecard.md",
      ":(exclude)docs/maturity/taxonomy.md",
    ]);
    for (const heading of [
      "## What Problem This Solves",
      "## Why This Change Was Made",
      "## User Impact",
      "## Evidence",
    ]) {
      expect(openDocsPrStep.with["pr-body"]).toContain(heading);
    }
    expect(publishPrJob.steps).not.toContainEqual(
      expect.objectContaining({ name: "Create generated docs PR app token" }),
    );
    const maturityWorkflowSource = readFileSync(".github/workflows/maturity-scorecard.yml", "utf8");
    expect(maturityWorkflowSource).not.toContain("permission-pull-requests: write");
    expect(maturityWorkflowSource).not.toContain("GH_APP_PRIVATE_KEY");
    expect(maturityWorkflowSource).not.toContain("gh auth setup-git");
    expect(maturityWorkflowSource).not.toContain("git push --force-with-lease");
  });

  it.skipIf(process.platform === "win32")(
    "authorizes maturity PR publication only for a canonical direct dispatch",
    () => {
      const direct = runMaturityInvocationScenario({
        callerEventName: "workflow_dispatch",
        callerWorkflowRef: MATURITY_SCORECARD_WORKFLOW_REF,
        publishPullRequest: true,
      });

      expect(direct.status).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps a reusable maturity call artifact-only even when its caller was dispatched",
    () => {
      const callerWorkflowRef =
        "openclaw/openclaw/.github/workflows/openclaw-release-checks.yml@refs/heads/main";
      const artifactOnly = runMaturityInvocationScenario({
        callerEventName: "workflow_dispatch",
        callerWorkflowRef,
        publishPullRequest: false,
      });

      expect(artifactOnly.status).toBe(0);
      for (const identity of [
        { callerWorkflowRef },
        { callerWorkflowRef: MATURITY_SCORECARD_WORKFLOW_REF, jobWorkflowRef: callerWorkflowRef },
      ]) {
        const rejected = runMaturityInvocationScenario({
          callerEventName: "workflow_dispatch",
          publishPullRequest: true,
          ...identity,
        });
        expect(rejected.status).not.toBe(0);
        expect(rejected.output).toContain(
          "Reusable maturity workflows are artifact-only and cannot publish pull requests.",
        );
      }
    },
  );

  // Replay the Ubuntu workflow shell only where its Bash 4 and GNU install contract exists.
  it.skipIf(process.platform !== "linux")(
    "copies only regular allowlisted maturity publication files",
    () => {
      const valid = runMaturityArtifactCopyScenario();
      expect(valid.status).toBe(0);
      expect(valid.copied).toEqual(MATURITY_GENERATED_PR_PATHS.map((path) => `new ${path}\n`));

      const extra = runMaturityArtifactCopyScenario({ extraFile: true });
      expect(extra.status).not.toBe(0);
      expect(extra.output).toContain("Generated PR artifact must contain exactly 3 files.");

      const sourceSymlink = runMaturityArtifactCopyScenario({ sourceSymlink: true });
      expect(sourceSymlink.status).not.toBe(0);
      expect(sourceSymlink.output).toContain(
        "Generated PR artifact path must be a regular file: qa/maturity-scores.yaml",
      );

      const destinationSymlink = runMaturityArtifactCopyScenario({ destinationSymlink: true });
      expect(destinationSymlink.status).not.toBe(0);
      expect(destinationSymlink.output).toContain(
        "Selected worktree destination must be a regular file: qa/maturity-scores.yaml",
      );
      expect(destinationSymlink.escaped).toBe("outside\n");
    },
  );

  it("keeps maturity scorecard release docs opt-in from release checks", () => {
    const releaseWorkflow = readReleaseChecksWorkflow();
    const job = releaseWorkflow.jobs.maturity_scorecard_release_checks;
    const summaryJob = releaseWorkflow.jobs.summary;
    const verifyStep = summaryJob.steps.find(
      (step) => step.name === "Verify release check results",
    );
    const inputs = releaseWorkflow.on.workflow_dispatch.inputs;
    const resolveJob = releaseWorkflow.jobs.resolve_target;
    const summarizeStep = resolveJob.steps.find((step) => step.name === "Summarize validated ref");

    expect(releaseWorkflow.jobs).not.toHaveProperty("qa_profile_release_evidence_release_checks");
    expect(inputs.run_maturity_scorecard).toMatchObject({
      required: false,
      default: false,
      type: "boolean",
    });
    expect(resolveJob.outputs.run_maturity_scorecard).toBe(
      "${{ steps.inputs.outputs.run_maturity_scorecard }}",
    );
    expect(summarizeStep.env.RUN_MATURITY_SCORECARD).toBe(
      "${{ steps.inputs.outputs.run_maturity_scorecard }}",
    );
    expect(summarizeStep.run).toContain("- Maturity scorecard docs:");
    expect(job.name).toBe("Render maturity scorecard release docs");
    expect(job.if).toBe(
      "contains(fromJSON('[\"all\",\"qa\"]'), needs.resolve_target.outputs.rerun_group) && needs.resolve_target.outputs.run_maturity_scorecard == 'true'",
    );
    expect(job.permissions).toMatchObject({
      actions: "read",
      contents: "read",
    });
    expect(job.uses).toBe("./.github/workflows/maturity-scorecard.yml");
    expect(job.with).toMatchObject({
      ref: "${{ needs.resolve_target.outputs.ref }}",
      expected_sha: "${{ needs.resolve_target.outputs.revision }}",
    });
    expect(job.with).not.toHaveProperty("qa_profile");
    expect(job.with).not.toHaveProperty("publish_pull_request");
    expect(Object.keys(job.secrets)).toEqual(["OPENAI_API_KEY"]);
    expect(summaryJob.needs).toContain("maturity_scorecard_release_checks");
    expect(verifyStep.env.MATURITY_SCORECARD_RELEASE_CHECKS_RESULT).toBe(
      "${{ needs.maturity_scorecard_release_checks.result }}",
    );
    expect(verifyStep.run).toContain(
      '"maturity_scorecard_release_checks=${MATURITY_SCORECARD_RELEASE_CHECKS_RESULT}"',
    );
    expect(verifyStep.run).not.toContain("qa_profile_release_evidence_release_checks");
  });

  it("keeps workflow guards in fast CI-routing checks", () => {
    const workflow = readCiWorkflow();
    const preflightStep = workflow.jobs.preflight.steps.find(
      (step) => step.name === "Build CI manifest",
    );
    const taxonomy = parse(readFileSync("taxonomy.yaml", "utf8")) as {
      profiles: Array<{ id: string; categoryIds: string[] }>;
    };
    const smokeProfile = taxonomy.profiles.find((profile) => profile.id === "smoke-ci");
    if (!smokeProfile) {
      throw new Error("taxonomy.yaml is missing the smoke-ci profile");
    }
    const fastCoreJob = workflow.jobs["checks-fast-core"];
    const runStep = fastCoreJob.steps.find(
      (step) => step.name === "Run ${{ matrix.task }} (${{ matrix.runtime }})",
    );
    const smokeProfileJob = workflow.jobs["qa-smoke-ci-profile"];
    const smokeBuildStep = smokeProfileJob.steps.find(
      (step) => step.name === "Build QA smoke runtime",
    );
    const smokeRunStep = smokeProfileJob.steps.find(
      (step) => step.name === "Run smoke profile part",
    );
    const smokeUploadStep = smokeProfileJob.steps.find(
      (step) => step.name === "Upload QA smoke profile evidence",
    );

    const ciWorkflowText = readFileSync(".github/workflows/ci.yml", "utf8");

    expect(preflightStep.run).not.toContain("qa-smoke-profile");
    expect(preflightStep.run).not.toContain("qa_category");
    expect(smokeProfile.categoryIds).toHaveLength(30);
    for (const categoryId of smokeProfile.categoryIds) {
      expect(ciWorkflowText).not.toContain(`"${categoryId}"`);
    }
    expect(runStep.run).toContain("bundled-protocol)");
    expect(runStep.run).not.toContain("qa-smoke-ci)");
    expect(runStep.run).toContain("contracts-plugins-ci-routing)");
    expect(runStep.run).toContain("ci-routing)");
    expect(fastCoreJob["runs-on"]).toContain("matrix.runner");
    expect(smokeProfileJob.name).toBe("QA Smoke CI (${{ matrix.name }})");
    expect(smokeBuildStep.run).toContain("node scripts/build-all.mjs qaRuntime");
    expect(smokeBuildStep.run).toContain("pnpm ui:build");
    expect(smokeBuildStep.env.OPENCLAW_BUILD_PRIVATE_QA).toBe("1");
    expect(smokeBuildStep.run).toContain("--skip-build");
    expect(smokeBuildStep.run).toContain("--allow-unreleased-changelog");
    expect(workflow.jobs["qa-smoke-ci-artifacts"]).toBeUndefined();
    expect(workflow.jobs["qa-smoke-ci"]).toBeUndefined();
    expect(smokeProfileJob.needs).toEqual(["preflight"]);
    expect(smokeProfileJob.strategy["max-parallel"]).toBe(2);
    expect(smokeProfileJob.strategy.matrix.include.map((entry) => entry.slug)).toEqual([
      "profile-1-of-2",
      "profile-2-of-2",
    ]);
    expect(smokeProfileJob["runs-on"]).toContain("blacksmith-16vcpu-ubuntu-2404");
    expect(smokeRunStep.run).toContain("createQaSmokeCiPart");
    expect(smokeRunStep.run).toContain("createQaSmokeCiMatrix");
    expect(smokeRunStep.run).toContain("No QA smoke runs assigned");
    expect(smokeRunStep.run).toContain("node openclaw.mjs qa run");
    expect(smokeRunStep.run).not.toContain("pnpm openclaw qa run");
    expect(smokeRunStep.run).toContain("--qa-profile smoke-ci");
    expect(smokeRunStep.run).toContain("--concurrency 10");
    expect(smokeRunStep.env.OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS).toContain(
      "github.event_name != 'workflow_dispatch'",
    );
    expect(smokeRunStep.env.OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS).toContain(
      "github.repository == 'openclaw/openclaw'",
    );
    expect(smokeRunStep.env.OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS).toContain("'0'");
    expect(smokeRunStep.env.OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS).toContain("'1500'");
    expect(smokeRunStep.run).toContain('scenario_args+=(--scenario "$scenario_id")');
    expect(smokeRunStep.run).toContain('done <<< "$PROFILE_RUNS_TSV"');
    expect(smokeRunStep.run).not.toContain('pids+=("$!")');
    expect(smokeRunStep.run).not.toContain('wait "${pids[$index]}"');
    expect(smokeRunStep.run).not.toContain("--category");
    expect(smokeRunStep.run).not.toContain("--allow-failures");
    expect(smokeRunStep.run).toContain("qa_exit_code=0");
    expect(smokeRunStep.run).toContain('exit "$qa_exit_code"');
    expect(smokeRunStep.run).toContain("OPENCLAW_CURRENT_PACKAGE_TGZ");
    expect(smokeRunStep.run).toContain("--max-old-space-size=16384");
    expect(smokeRunStep.run).not.toContain("scripts/build-all.mjs qaRuntime");
    expect(smokeRunStep.run).not.toContain("OPENAI_API_KEY");
    expect(smokeUploadStep.if).toBe("always()");
    expect(smokeUploadStep.with).toMatchObject({
      path: ".artifacts/qa-e2e/smoke-ci-profile-${{ matrix.slug }}/",
      "if-no-files-found": "warn",
    });
    expect(runStep.run.match(/test\/scripts\/ci-workflow-guards\.test\.ts/g)?.length).toBe(2);
  });

  it("keeps push docs validation ClawHub-backed", () => {
    const workflow = readFileSync(".github/workflows/docs.yml", "utf8");

    expect(workflow).toContain("repository: openclaw/clawhub");
    expect(workflow).toContain("path: clawhub-source");
    expect(workflow).toContain(
      "OPENCLAW_DOCS_SYNC_CLAWHUB_REPO: ${{ github.workspace }}/clawhub-source",
    );
  });

  it("keeps network CodeQL off unrelated source-only refactors", () => {
    const workflow = readCriticalQualityWorkflow();
    const networkConfig = readFileSync(
      ".github/codeql/codeql-network-runtime-boundary-critical-quality.yml",
      "utf8",
    );
    const rawSocketQuery = readFileSync(
      ".github/codeql/openclaw-boundary/queries/raw-socket-callsite-classification.ql",
      "utf8",
    );
    const networkSelector = workflow.slice(
      workflow.indexOf(".github/codeql/codeql-network-runtime-boundary-critical-quality.yml"),
      workflow.indexOf("network-runtime-boundary:"),
    );
    const broadCodeqlSelector = workflow.slice(
      workflow.indexOf(".github/codeql/*|.github/workflows/codeql-critical-quality.yml"),
      workflow.indexOf("src/**/*.test.ts|src/**/*.test.tsx"),
    );

    expect(broadCodeqlSelector).not.toContain("network_runtime=true");
    expect(networkSelector).toContain(
      ".github/codeql/codeql-network-runtime-boundary-critical-quality.yml",
    );
    expect(networkSelector).not.toContain("src/*.ts|src/**/*.ts");
    expect(networkSelector).not.toContain("extensions/*.ts|extensions/**/*.ts");
    expect(networkSelector).toContain("src/infra/net/*");
    expect(networkSelector).toContain("src/infra/ssh-tunnel.ts");
    expect(networkSelector).toContain("packages/net-policy/src/*");
    expect(networkConfig).not.toContain("\n  - src\n");
    expect(networkConfig).not.toContain("\n  - extensions\n");
    expect(networkConfig).toContain("\n  - src/infra/net\n");
    expect(networkConfig).toContain("\n  - packages/net-policy/src\n");
    expect(workflow).toContain("Fast PR network boundary diff scan");
    expect(workflow).toContain(
      '| select(.filename | test("(^|/)[^/]+\\\\.(?:e2e\\\\.)?test\\\\.tsx?$") | not)',
    );
    expect(workflow).toContain("Network runtime boundary-sensitive added lines");
    expect(workflow).toContain(
      'codex_transport="extensions/codex/src/app-server/transport-websocket.ts"',
    );
    expect(workflow).toContain(
      '| select(.filename != "extensions/codex/src/app-server/transport-websocket.ts")',
    );
    expect(workflow).not.toContain('grep -Fv "$codex_transport: " "$added_lines"');
    // Raw-socket exclusions are filename-structural. A monitored package line may
    // contain the transport path as data without disappearing from the scan.
    expect(workflow).toContain("packages/net-policy/src/");
    expect(workflow).toContain(
      "grep -En 'HTTP_PROXY|HTTPS_PROXY|NO_PROXY|GLOBAL_AGENT_|OPENCLAW_PROXY_' \"$added_lines\"",
    );
    expect(workflow).toContain('echo "full_codeql=true" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain(
      "if: ${{ github.event_name != 'pull_request' || steps.network-diff-scan.outputs.full_codeql == 'true' }}",
    );
    expect(rawSocketQuery).toContain(
      'allowedOwnerScope(call, "extensions/codex/src/app-server/transport-websocket.ts", "connectCodexAppServerUnixSocket")',
    );
    expect(rawSocketQuery).not.toContain(
      'call.getFile().getRelativePath() = "extensions/codex/src/app-server/transport-websocket.ts"',
    );
  });
});
