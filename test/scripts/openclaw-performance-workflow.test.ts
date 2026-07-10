// Openclaw Performance Workflow tests cover openclaw performance workflow script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/openclaw-performance.yml";

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  uses?: string;
  with?: Record<string, string>;
  "continue-on-error"?: boolean | string;
};

type WorkflowJob = {
  env?: Record<string, string>;
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  "runs-on"?: string;
  steps?: WorkflowStep[];
  strategy?: {
    matrix?: {
      include?: Array<Record<string, string>>;
    };
  };
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

function readWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
}

function findStep(name: string, job = "kova"): WorkflowStep {
  const steps = readWorkflow().jobs?.[job]?.steps ?? [];
  const step = steps.find((candidate) => candidate.name === name);
  expect(step).toBeDefined();
  return step as WorkflowStep;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function kovaMatrixEntries(): Array<Record<string, string>> {
  return readWorkflow().jobs?.kova?.strategy?.matrix?.include ?? [];
}

describe("OpenClaw performance workflow", () => {
  it("uses an optional dispatch identifier to name parent-owned runs", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");

    expect(workflow).toContain(
      "run-name: ${{ inputs.dispatch_id != '' && format('OpenClaw Performance {0}', inputs.dispatch_id) || 'OpenClaw Performance' }}",
    );
    expect(workflow).toContain("dispatch_id:");
    expect(workflow).toContain("Optional parent workflow dispatch identifier");
  });

  it("pins the Kova evaluator that reads agent payloads", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const kovaRef = "a2dd84e7d65507e614afaff850d3932d18c859b6";

    expect(workflow).toContain(`default: ${kovaRef}`);
    expect(workflow).toContain(`inputs.kova_ref || '${kovaRef}'`);
  });

  it("resolves each target once before benchmark and publication fan out", () => {
    const workflow = readWorkflow();
    const resolveTarget = findStep("Resolve OpenClaw target ref", "resolve_target");
    const checkout = findStep("Checkout OpenClaw");
    const record = findStep("Record tested revision");

    expect(workflow.jobs?.kova?.needs).toBe("resolve_target");
    expect(resolveTarget.id).toBe("resolve");
    expect(resolveTarget.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(resolveTarget.env?.TARGET_REF_INPUT).toBe("${{ inputs.target_ref }}");
    expect(resolveTarget.run).toContain("encodeURIComponent");
    expect(resolveTarget.run).toContain(
      'gh api "repos/${GITHUB_REPOSITORY}/commits/${encoded_ref}"',
    );
    expect(resolveTarget.run).toContain("checkout_ref=$resolved_sha");
    expect(resolveTarget.run).toContain("tested_sha=$resolved_sha");
    expect(checkout.with?.ref).toBe("${{ needs.resolve_target.outputs.checkout_ref }}");
    expect(record.run).toContain('[[ "$tested_sha" != "$EXPECTED_TESTED_SHA" ]]');
    expect(
      Object.values(workflow.jobs ?? {})
        .flatMap((job) => job.steps ?? [])
        .filter((step) => step.name === "Resolve OpenClaw target ref"),
    ).toHaveLength(1);
  });

  it("fetches the public clawgrit baseline without publisher credentials", () => {
    const workflowText = readFileSync(WORKFLOW, "utf8");
    const baseline = findStep("Fetch previous source performance baseline");

    expect(baseline.if).toBe(
      "${{ steps.lane.outputs.run == 'true' && matrix.lane == 'mock-provider' }}",
    );
    expect(baseline.env?.CLAWGRIT_REPORTS_TOKEN).toBeUndefined();
    expect(baseline.run).toContain(
      'remote add origin "https://github.com/openclaw/clawgrit-reports.git"',
    );
    expect(workflowText).not.toContain("https://x-access-token:");
  });

  it("isolates required publication in a fresh artifact-consuming job", () => {
    const workflow = readWorkflow();
    const publisher = workflow.jobs?.publish;
    const kovaSteps = workflow.jobs?.kova?.steps ?? [];
    const publishSteps = publisher?.steps ?? [];
    const appTokenIndex = publishSteps.findIndex(
      (step) => step.name === "Create clawgrit reports app token",
    );
    const artifactIndex = publishSteps.findIndex((step) => step.name === "Resolve Kova artifact");
    const downloadIndex = publishSteps.findIndex((step) => step.name === "Download Kova artifacts");
    const prepareIndex = publishSteps.findIndex(
      (step) => step.name === "Prepare clawgrit report commit",
    );
    const pushIndex = publishSteps.findIndex((step) => step.name === "Publish to clawgrit reports");

    expect(publisher?.needs).toEqual(["resolve_target", "kova"]);
    expect(publisher?.if).toBe(
      "${{ always() && needs.resolve_target.result == 'success' && needs.kova.result != 'cancelled' }}",
    );
    expect(publisher?.["runs-on"]).toBe("ubuntu-24.04");
    expect(publisher?.permissions?.actions).toBe("read");
    expect(publisher?.env?.REPORT_PUBLISH_REQUIRED).toBe(
      "${{ github.event_name == 'schedule' || inputs.profile == 'release' }}",
    );
    expect(kovaSteps.some((step) => step.name === "Upload Kova artifacts")).toBe(true);
    expect(JSON.stringify(kovaSteps)).not.toContain("CLAWSWEEPER_APP_PRIVATE_KEY");
    expect(artifactIndex).toBeGreaterThanOrEqual(0);
    expect(downloadIndex).toBeGreaterThan(artifactIndex);
    expect(prepareIndex).toBeGreaterThan(downloadIndex);
    expect(appTokenIndex).toBeGreaterThan(prepareIndex);
    expect(pushIndex).toBeGreaterThan(appTokenIndex);
  });

  it("mints only a short-lived repo-scoped ClawSweeper app token", () => {
    const workflowText = readFileSync(WORKFLOW, "utf8");
    const publisher = readWorkflow().jobs?.publish;
    const publishSteps = publisher?.steps ?? [];
    const appToken = findStep("Create clawgrit reports app token", "publish");
    const publish = findStep("Publish to clawgrit reports", "publish");
    const appTokenOutput = "${{ steps.clawgrit_app_token.outputs.token }}";
    const tokenConsumers = publishSteps.filter((step) =>
      Object.values(step.env ?? {}).includes(appTokenOutput),
    );

    expect(appToken.id).toBe("clawgrit_app_token");
    expect(appToken.if).toBe(
      "${{ steps.prepare.outputs.ready == 'true' && steps.prepare.outputs.already_published != 'true' }}",
    );
    expect(appToken.uses).toBe(
      "actions/create-github-app-token@1b10c78c7865c340bc4f6099eb2f838309f1e8c3",
    );
    expect(appToken.with).toEqual({
      "client-id": "Iv23liOECG0slfuhz093",
      "private-key": "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
      owner: "openclaw",
      repositories: "clawgrit-reports",
      "permission-contents": "write",
    });
    expect(appToken.with?.["skip-token-revoke"]).toBeUndefined();
    expect(tokenConsumers.map((step) => step.name)).toEqual(["Publish to clawgrit reports"]);
    expect(publish.env?.CLAWGRIT_REPORTS_APP_TOKEN).toBe(appTokenOutput);
    expect(workflowText.split(appTokenOutput)).toHaveLength(2);
    expect(workflowText.split("${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}")).toHaveLength(2);
    expect(publish.if).toBe(
      "${{ steps.prepare.outputs.ready == 'true' && steps.prepare.outputs.already_published != 'true' }}",
    );
    expect(workflowText).not.toContain("CLAWGRIT_REPORTS_TOKEN");
    expect(workflowText).not.toContain("secrets.GH_APP_PRIVATE_KEY");
    expect(workflowText).not.toContain('app-id: "2729701"');
  });

  it("keeps manual non-release publication advisory", () => {
    const continuation = "${{ env.REPORT_PUBLISH_REQUIRED != 'true' }}";
    const steps = [
      findStep("Create clawgrit reports app token", "publish"),
      findStep("Resolve Kova artifact", "publish"),
      findStep("Download Kova artifacts", "publish"),
      findStep("Prepare clawgrit report commit", "publish"),
      findStep("Publish to clawgrit reports", "publish"),
    ];

    for (const step of steps) {
      expect(step["continue-on-error"]).toBe(continuation);
    }
    for (const step of steps.filter((candidate) => candidate.run)) {
      expect(step.run).toContain(
        'annotation="$([[ "$REPORT_PUBLISH_REQUIRED" == "true" ]] && printf error || printf warning)"',
      );
    }
  });

  it("keeps app credentials out of artifact processing and scopes them to Git push", () => {
    const workflow = readWorkflow();
    const kovaJob = workflow.jobs?.kova;
    const artifact = findStep("Resolve Kova artifact", "publish");
    const paths = findStep("Create isolated publisher paths", "publish");
    const download = findStep("Download Kova artifacts", "publish");
    const prepare = findStep("Prepare clawgrit report commit", "publish");
    const publish = findStep("Publish to clawgrit reports", "publish");

    expect(JSON.stringify(kovaJob)).not.toContain("CLAWSWEEPER_APP_PRIVATE_KEY");
    expect(artifact.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(artifact.run).toContain("gh api --paginate");
    expect(artifact.run).toContain("candidate_attempt <= GITHUB_RUN_ATTEMPT");
    expect(artifact.run).toContain('echo "producer_attempt=$producer_attempt"');
    expect(paths.run).toContain('mktemp -d "${RUNNER_TEMP}/clawgrit-input.XXXXXX"');
    expect(paths.run).toContain('mktemp -d "${RUNNER_TEMP}/clawgrit-reports.XXXXXX"');
    expect(download.uses).toBe(
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    );
    expect(download.with?.["artifact-ids"]).toBe("${{ steps.artifact.outputs.id }}");
    expect(download.with?.name).toBeUndefined();
    expect(download.with?.path).toBe("${{ steps.paths.outputs.input_root }}");
    expect(JSON.stringify(artifact.env ?? {})).not.toContain("clawgrit_app_token.outputs.token");
    expect(JSON.stringify(download.env ?? {})).not.toContain("clawgrit_app_token.outputs.token");
    expect(JSON.stringify(prepare.env ?? {})).not.toContain("clawgrit_app_token.outputs.token");
    expect(prepare.env?.TESTED_SHA).toBe("${{ needs.resolve_target.outputs.tested_sha }}");
    expect(prepare.env?.PRODUCER_ATTEMPT).toBe("${{ steps.artifact.outputs.producer_attempt }}");
    expect(prepare.run).toContain('run_slug="${GITHUB_RUN_ID}-${PRODUCER_ATTEMPT}"');
    expect(prepare.run).toContain('cat-file -e "HEAD:${dest_rel}/report.json"');
    expect(prepare.run).toContain('echo "already_published=true"');
    expect(prepare.run).toContain('git -C "$reports_root" diff --cached --quiet');
    expect(prepare.run).toContain('input_root="$(realpath "$INPUT_ROOT")"');
    expect(prepare.run).toContain('find "$input_root" -type f -path');
    expect(prepare.run).toContain("contains a symlink or special file");
    expect(prepare.run).toContain("config core.hooksPath /dev/null");
    expect(prepare.run).toContain(
      'remote add origin "https://github.com/openclaw/clawgrit-reports.git"',
    );
    expect(publish.env?.CLAWGRIT_REPORTS_APP_TOKEN).toBe(
      "${{ steps.clawgrit_app_token.outputs.token }}",
    );
    expect(publish.if).toContain("steps.prepare.outputs.already_published != 'true'");
    expect(publish.run).not.toContain("${{ steps.kova.outputs.");
    expect(publish.run).toContain("unset CLAWGRIT_REPORTS_APP_TOKEN");
    expect(publish.run).toContain("GIT_CONFIG_KEY_0=core.hooksPath");
    expect(publish.run).toContain("GIT_CONFIG_VALUE_0=/dev/null");
    expect(publish.run).toContain("GIT_CONFIG_KEY_1=http.https://github.com/.extraheader");
    expect(publish.run).toContain('GIT_CONFIG_VALUE_1="AUTHORIZATION: basic ${auth_header}"');
    expect(publish.run).not.toContain("export GIT_CONFIG_");
    expect(readFileSync(WORKFLOW, "utf8")).not.toContain("https://x-access-token:");
  });

  it("replays concurrent report commits on the current reports tip", () => {
    const publish = findStep("Publish to clawgrit reports", "publish");

    expect(publish.run).toContain(
      'git -C "$reports_root" -c core.hooksPath=/dev/null fetch --depth=1 origin main',
    );
    expect(publish.run).toContain('git_local cat-file -e "FETCH_HEAD:${DEST_REL}/report.json"');
    expect(publish.run).toContain("git_local checkout --detach FETCH_HEAD");
    expect(publish.run).toContain('git_local cherry-pick -X theirs "$report_commit"');
    expect(publish.run).toContain('report_commit="$(git_local rev-parse HEAD)"');
    expect(publish.run).not.toContain("rebase FETCH_HEAD");
  });

  it("reuses the producing artifact when only publisher jobs rerun", () => {
    const artifact = findStep("Resolve Kova artifact", "publish");
    const root = mkdtempSync(join(realpathSync(tmpdir()), "openclaw-artifact-resolver-"));
    const bin = join(root, "bin");
    const output = join(root, "output");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh
printf '%s\\n' \
  '101	openclaw-performance-mock-provider-9001-1' \
  '303	openclaw-performance-mock-provider-9001-3'
`,
    );
    chmodSync(join(bin, "gh"), 0o755);

    try {
      const result = spawnSync("bash", ["-c", artifact.run ?? ""], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "openclaw/openclaw",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_RUN_ID: "9001",
          LANE_ID: "mock-provider",
          REPORT_PUBLISH_REQUIRED: "true",
        },
      });
      expect(result.status).toBe(0);
      expect(readFileSync(output, "utf8")).toBe("id=101\nproducer_attempt=1\n");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("advertises a clawgrit URL only after a direct or remotely verified push", () => {
    const publish = findStep("Publish to clawgrit reports", "publish");
    const root = mkdtempSync(join(realpathSync(tmpdir()), "openclaw-publish-shell-"));
    const bin = join(root, "bin");
    const reportsRoot = join(root, "reports");
    const reportUrl =
      "https://github.com/openclaw/clawgrit-reports/tree/main/openclaw-performance/main/123-1/mock-provider";
    mkdirSync(bin);
    mkdirSync(reportsRoot);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/bash
case "$*" in
  *"config --local --get core.hooksPath"*) echo /dev/null ;;
  *"remote get-url origin"*) echo https://github.com/openclaw/clawgrit-reports.git ;;
  *" push origin HEAD:main"*) printf push > "$STUB_PUSH_MARKER"; exit "\${STUB_PUSH_STATUS:-0}" ;;
  *" fetch --depth=1 origin main"*) exit "\${STUB_FETCH_STATUS:-1}" ;;
  *"cat-file -e FETCH_HEAD:"*) exit "\${STUB_REMOTE_REPORT_STATUS:-1}" ;;
  *) exit 0 ;;
esac
`,
    );
    writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(bin, "timeout"), '#!/bin/sh\nshift\nexec "$@"\n');
    chmodSync(join(bin, "git"), 0o755);
    chmodSync(join(bin, "sleep"), 0o755);
    chmodSync(join(bin, "timeout"), 0o755);

    const execute = ({
      pushStatus,
      appToken = "test-app-token",
      fetchSucceeds = false,
      remoteReportPresent = false,
    }: {
      pushStatus: string;
      appToken?: string | null;
      fetchSucceeds?: boolean;
      remoteReportPresent?: boolean;
    }) => {
      const scenario = [
        pushStatus,
        appToken === null ? "missing" : "token",
        fetchSucceeds ? "fetch" : "no-fetch",
        remoteReportPresent ? "remote" : "absent",
      ].join("-");
      const summary = join(root, `summary-${scenario}.md`);
      const pushMarker = join(root, `push-${scenario}.marker`);
      const result = spawnSync("bash", ["-c", publish.run ?? ""], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          ...(appToken === null ? {} : { CLAWGRIT_REPORTS_APP_TOKEN: appToken }),
          DEST_REL: "openclaw-performance/main/123-1/mock-provider",
          GITHUB_STEP_SUMMARY: summary,
          REPORT_COMMIT: "a".repeat(40),
          REPORT_PUBLISH_REQUIRED: "true",
          REPORT_URL: reportUrl,
          REPORTS_ROOT: reportsRoot,
          RUNNER_TEMP: root,
          STUB_FETCH_STATUS: fetchSucceeds ? "0" : "1",
          STUB_PUSH_MARKER: pushMarker,
          STUB_PUSH_STATUS: pushStatus,
          STUB_REMOTE_REPORT_STATUS: remoteReportPresent ? "0" : "1",
        },
      });
      return {
        result,
        pushMarker,
        summary: readFileSync(summary, "utf8"),
      };
    };

    try {
      const success = execute({ pushStatus: "0" });
      expect(success.result.status).toBe(0);
      expect(success.summary).toContain(`- Published report: ${reportUrl}`);

      const ambiguousSuccess = execute({
        pushStatus: "1",
        fetchSucceeds: true,
        remoteReportPresent: true,
      });
      expect(ambiguousSuccess.result.status).toBe(0);
      expect(ambiguousSuccess.summary).toContain(`- Published report: ${reportUrl}`);

      const failure = execute({ pushStatus: "1" });
      expect(failure.result.status).toBe(1);
      expect(failure.summary).toContain("Clawgrit report publish failed");
      expect(failure.summary).toContain("ClawSweeper GitHub App installation");
      expect(failure.summary).not.toContain("Published report:");

      const missing = execute({ pushStatus: "0", appToken: null });
      expect(missing.result.status).toBe(1);
      expect(missing.result.stdout).toContain("ClawSweeper GitHub App token is unavailable");
      expect(missing.summary).toContain("Clawgrit report publish unavailable");
      expect(missing.summary).not.toContain("Published report:");
      expect(existsSync(missing.pushMarker)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("preserves both reports when concurrent writers update one latest pointer", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "openclaw-report-race-"));
    const remote = join(root, "reports.git");
    const seed = join(root, "seed");
    const writerA = join(root, "writer-a");
    const writerB = join(root, "writer-b");
    const verify = join(root, "verify");
    const latest = "openclaw-performance/main/latest-mock-provider.json";
    const reportA = "openclaw-performance/main/100-1/mock-provider";
    const reportB = "openclaw-performance/main/200-1/mock-provider";

    const configureWriter = (repo: string) => {
      runGit(repo, ["config", "user.name", "publisher-test"]);
      runGit(repo, ["config", "user.email", "publisher-test@example.com"]);
      runGit(repo, ["config", "commit.gpgsign", "false"]);
      runGit(repo, ["config", "core.hooksPath", "/dev/null"]);
    };
    const commitReport = (repo: string, reportPath: string, marker: string) => {
      mkdirSync(join(repo, reportPath), { recursive: true });
      writeFileSync(join(repo, reportPath, "report.json"), JSON.stringify({ marker }));
      writeFileSync(join(repo, latest), JSON.stringify({ path: reportPath }));
      runGit(repo, ["add", "--", "openclaw-performance"]);
      runGit(repo, ["commit", "-m", `perf: add ${marker}`]);
    };

    try {
      runGit(root, ["init", "--bare", "--initial-branch=main", remote]);
      mkdirSync(seed);
      runGit(seed, ["init", "--initial-branch=main"]);
      configureWriter(seed);
      writeFileSync(join(seed, "README.md"), "reports\n");
      runGit(seed, ["add", "README.md"]);
      runGit(seed, ["commit", "-m", "chore: seed"]);
      runGit(seed, ["remote", "add", "origin", remote]);
      runGit(seed, ["push", "origin", "HEAD:main"]);
      runGit(root, ["clone", remote, writerA]);
      runGit(root, ["clone", remote, writerB]);
      configureWriter(writerA);
      configureWriter(writerB);

      commitReport(writerA, reportA, "writer-a");
      const reportCommit = runGit(writerA, ["rev-parse", "HEAD"]);
      commitReport(writerB, reportB, "writer-b");
      runGit(writerB, ["push", "origin", "HEAD:main"]);
      const rejectedPush = spawnSync("git", ["push", "origin", "HEAD:main"], {
        cwd: writerA,
        encoding: "utf8",
      });
      expect(rejectedPush.status).not.toBe(0);

      runGit(writerA, ["fetch", "--depth=1", "origin", "main"]);
      const remoteHasA = spawnSync("git", ["cat-file", "-e", `FETCH_HEAD:${reportA}/report.json`], {
        cwd: writerA,
      });
      expect(remoteHasA.status).not.toBe(0);
      runGit(writerA, ["checkout", "--detach", "FETCH_HEAD"]);
      runGit(writerA, ["cherry-pick", "-X", "theirs", reportCommit]);
      runGit(writerA, ["push", "origin", "HEAD:main"]);

      runGit(root, ["clone", remote, verify]);
      expect(JSON.parse(readFileSync(join(verify, reportA, "report.json"), "utf8"))).toEqual({
        marker: "writer-a",
      });
      expect(JSON.parse(readFileSync(join(verify, reportB, "report.json"), "utf8"))).toEqual({
        marker: "writer-b",
      });
      expect(JSON.parse(readFileSync(join(verify, latest), "utf8"))).toEqual({
        path: reportA,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("requires the shared Kova report gate before tolerating partial verdicts", () => {
    const runKova = findStep("Run Kova");

    expect(runKova.run).toContain(
      'node "$PERFORMANCE_HELPER_DIR/scripts/lib/kova-report-gate.mjs" "$report_json"',
    );
    expect(runKova.run).not.toContain("report.summary?.statuses ?? {}");
    expect(runKova.run).toContain(
      "profiling-affected resource thresholds with no baseline regression",
    );
  });

  it("passes one comma-delimited include set to the lane plan and run", () => {
    const plan = findStep("Kova version and plan sanity");
    const runKova = findStep("Run Kova");
    const matrixEntries = kovaMatrixEntries();
    const includeFilters = matrixEntries.map((entry) => entry.include_filters);
    const expectedReleaseEntries = matrixEntries.map((entry) => entry.expected_release_entries);

    expect(includeFilters).toEqual([
      "scenario:fresh-install,scenario:gateway-performance,scenario:bundled-plugin-startup,scenario:bundled-runtime-deps,scenario:agent-cold-warm-message",
      "scenario:fresh-install,scenario:gateway-performance,scenario:agent-cold-warm-message",
      "scenario:agent-cold-warm-message",
    ]);
    expect(includeFilters.every((filters) => !filters.includes(" "))).toBe(true);
    expect(plan.run).toContain('plan_dir="${RUNNER_TEMP}/kova-plans"');
    expect(plan.run).toContain('--include "$INCLUDE_FILTERS"');
    expect(plan.run).toContain('--repeat "$repeat"');
    expect(plan.run).toContain('echo "KOVA_PLAN_JSON=$plan_json" >> "$GITHUB_ENV"');
    expect(plan.run).not.toContain("$REPORT_DIR");
    expect(runKova.run).toContain('--include "$INCLUDE_FILTERS"');
    expect(runKova.run).not.toContain("for filter in $INCLUDE_FILTERS");
    expect(expectedReleaseEntries).toEqual([
      "fresh-install:fresh,fresh-install:onboarded-user,bundled-runtime-deps:missing-plugin-index,bundled-plugin-startup:fresh,agent-cold-warm-message:mock-openai-provider,gateway-performance:many-bundled-plugins",
      "fresh-install:fresh,fresh-install:onboarded-user,agent-cold-warm-message:mock-openai-provider,gateway-performance:many-bundled-plugins",
      "agent-cold-warm-message:mock-openai-provider",
    ]);
  });

  it("prepares a fail-closed systemd user session for OCM", () => {
    const workflow = readWorkflow();
    const steps = workflow.jobs?.kova?.steps ?? [];
    const managedServiceLanes = workflow.jobs?.kova?.strategy?.matrix?.include?.map(
      (lane) => lane.managed_service,
    );
    const prepare = findStep("Prepare systemd user session");
    const stepNames = steps.map((step) => step.name);

    expect(managedServiceLanes).toEqual(["true", "true", "false"]);
    expect(prepare.if).toBe(
      "${{ steps.lane.outputs.run == 'true' && matrix.managed_service == 'true' }}",
    );
    expect(prepare.run).toContain("set -euo pipefail");
    expect(prepare.run).toContain('test "$(ps -p 1 -o comm= | xargs)" = systemd');
    expect(prepare.run).toContain("sudo systemctl is-active --quiet systemd-logind.service");
    expect(prepare.run).toContain('sudo loginctl enable-linger "$user"');
    expect(prepare.run).toContain('sudo systemctl start "user@${uid}.service"');
    expect(prepare.run).toContain(
      'runtime_dir="$(loginctl show-user "$user" --property=RuntimePath --value)"',
    );
    expect(prepare.run).toContain('test -S "$XDG_RUNTIME_DIR/systemd/private"');
    expect(prepare.run).toContain('echo "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR" >> "$GITHUB_ENV"');
    expect(prepare.run).toContain('if [[ -S "$runtime_dir/bus" ]]; then');
    expect(prepare.run).toContain(
      'echo "DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS" >> "$GITHUB_ENV"',
    );
    expect(prepare.run).toContain("systemctl --user show-environment >/dev/null");
    expect(prepare.run).not.toContain("|| true");
    expect(stepNames.indexOf("Prepare systemd user session")).toBeLessThan(
      stepNames.indexOf("Install OCM and Kova"),
    );
  });

  it("validates exact Kova release-plan coverage before execution", () => {
    const sanity = findStep("Kova version and plan sanity");

    expect(sanity.run).toContain('--include "$INCLUDE_FILTERS"');
    expect(sanity.run).toContain("plan.controls?.include");
    expect(sanity.run).toContain("process.env.EXPECTED_RELEASE_ENTRIES.split");
    expect(sanity.run).toContain('entry.status !== "SELECTED"');
    expect(sanity.run).toContain("Kova release plan entries did not match");
    expect(sanity.run).not.toContain("--include scenario:fresh-install");
  });

  it("makes the live lane use live auth through the OpenClaw runtime", () => {
    const override = findStep("Prepare live OpenAI candidate state");

    expect(override.if).toContain("matrix.live == 'true'");
    expect(override.run).toContain("states/mock-openai-provider.json");
    expect(override.run).toContain('state.auth?.mode !== "mock"');
    expect(override.run).toContain('state.auth.mode = "default"');
    expect(override.run).toContain(
      "This ephemeral checkout must honor the lane's explicit --auth live selection.",
    );
    expect(override.run).toContain(
      'state.auth.reason = "Honor the workflow lane\'s explicit run-level auth selection."',
    );
    expect(override.run).toContain('id: "force-openclaw-agent-runtime"');
    expect(override.run).toContain('afterPhase: "provision"');
    expect(override.run).toContain(
      "ocm @{env} -- config set models.providers.openai.agentRuntime.id openclaw",
    );
    expect(override.run).not.toContain("agents.defaults.agentRuntime");
  });

  it("runs the trusted lane evidence validator before tolerating gate failures", () => {
    const runKova = findStep("Run Kova");
    const run = runKova.run ?? "";
    const evidenceValidator = run.indexOf("scripts/lib/kova-workflow-evidence.mjs");
    const trustedGateAdapter = run.indexOf("scripts/lib/kova-report-gate.mjs");

    expect(evidenceValidator).toBeGreaterThan(-1);
    expect(trustedGateAdapter).toBeGreaterThan(evidenceValidator);
    expect(run).toContain('--plan "$KOVA_PLAN_JSON"');
    expect(run).toContain('--report "$report_json"');
    expect(run).toContain('--profile "$PROFILE"');
    expect(run).toContain('--target "local-build:${GITHUB_WORKSPACE}"');
    expect(run).toContain('--repeat "$repeat"');
    expect(run).toContain('--include "$INCLUDE_FILTERS"');
    expect(run).toContain('--auth "$AUTH_MODE"');
  });

  it("installs local workspace packages beside the OCM root tarball", () => {
    const configure = findStep("Configure OCM local workspace dependencies");

    expect(configure.run).toContain(
      'npm_wrapper="$PERFORMANCE_HELPER_DIR/scripts/ocm-npm-workspace-deps.mjs"',
    );
    expect(configure.run).toContain("OCM_INTERNAL_NPM_BIN=$npm_wrapper");
    expect(configure.run).toContain(
      'if [[ -f "${GITHUB_WORKSPACE}/packages/ai/package.json" ]]; then',
    );
    expect(configure.run).toContain(
      "OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS=$workspace_dependency_dirs",
    );
  });

  it("fails selected live Kova lanes when live auth is missing", () => {
    const configureAuth = findStep("Configure live OpenAI auth");
    const runKova = findStep("Run Kova");

    expect(configureAuth.if).toContain("matrix.live == 'true'");
    expect(configureAuth.env?.OPENAI_API_KEY).toBe("${{ secrets.OPENAI_API_KEY }}");
    expect(configureAuth.run).toContain('if [[ -z "${OPENAI_API_KEY:-}" ]]; then');
    expect(configureAuth.run).toContain("cannot run without live evidence");
    expect(configureAuth.run).toContain("exit 1");
    expect(configureAuth.run).not.toContain("will be skipped");
    expect(runKova.run).not.toContain('echo "skipped=true" >> "$GITHUB_OUTPUT"');
  });

  it("requires Kova evidence before uploading selected lane artifacts", () => {
    const validateEvidence = findStep("Validate Kova evidence");
    const upload = findStep("Upload Kova artifacts");

    expect(validateEvidence.if).toContain("always()");
    expect(validateEvidence.if).toContain("steps.lane.outputs.run == 'true'");
    expect(validateEvidence.run).toContain('"$REPORT_DIR" -maxdepth 1 -type f -name');
    expect(validateEvidence.run).toContain('"$BUNDLE_DIR/bundle.json"');
    expect(validateEvidence.run).toContain('"$SUMMARY_DIR/${LANE_ID}.md"');
    expect(validateEvidence.run).toContain("exit 1");
    expect(upload.with?.["if-no-files-found"]).toBe("error");
  });
});
