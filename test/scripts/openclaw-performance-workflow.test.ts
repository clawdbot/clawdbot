// Openclaw Performance Workflow tests cover openclaw performance workflow script behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/openclaw-performance.yml";

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

type WorkflowJob = {
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

function findStep(name: string): WorkflowStep {
  const steps = readWorkflow().jobs?.kova?.steps ?? [];
  const step = steps.find((candidate) => candidate.name === name);
  expect(step).toBeDefined();
  return step as WorkflowStep;
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
    const kovaRef = "886a0005269de56632491cfac89bf55256fff778";

    expect(workflow).toContain(`default: ${kovaRef}`);
    expect(workflow).toContain(`inputs.kova_ref || '${kovaRef}'`);
  });

  it("resolves dispatch target refs before checkout", () => {
    const resolveTarget = findStep("Resolve OpenClaw target ref");
    const checkout = findStep("Checkout OpenClaw");

    expect(resolveTarget.id).toBe("target");
    expect(resolveTarget.if).toBe("steps.lane.outputs.run == 'true'");
    expect(resolveTarget.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(resolveTarget.env?.TARGET_REF_INPUT).toBe("${{ inputs.target_ref }}");
    expect(resolveTarget.run).toContain("encodeURIComponent");
    expect(resolveTarget.run).toContain(
      'gh api "repos/${GITHUB_REPOSITORY}/commits/${encoded_ref}"',
    );
    expect(resolveTarget.run).toContain("checkout_ref=${resolved_sha}");
    expect(checkout.with?.ref).toBe("${{ steps.target.outputs.checkout_ref }}");
  });

  it("uses the clawgrit reports token for every report repo push path", () => {
    const prepare = findStep("Prepare clawgrit reports checkout");
    const publish = findStep("Publish to clawgrit reports");

    expect(prepare.env?.CLAWGRIT_REPORTS_TOKEN).toBe("${{ secrets.CLAWGRIT_REPORTS_TOKEN }}");
    expect(publish.env?.CLAWGRIT_REPORTS_TOKEN).toBe("${{ secrets.CLAWGRIT_REPORTS_TOKEN }}");
    expect(prepare.run).toContain(
      'remote add origin "https://x-access-token:${CLAWGRIT_REPORTS_TOKEN}@github.com/openclaw/clawgrit-reports.git"',
    );
    expect(publish.run).toContain(
      'remote set-url origin "https://x-access-token:${CLAWGRIT_REPORTS_TOKEN}@github.com/openclaw/clawgrit-reports.git"',
    );
    expect(publish.run).toContain('git -C "$reports_root" push origin HEAD:main');
  });

  it("keeps optional clawgrit report publishing bounded", () => {
    const prepare = findStep("Prepare clawgrit reports checkout");
    const publish = findStep("Publish to clawgrit reports");

    expect(prepare.run).toContain('echo "ready=false" >> "$GITHUB_OUTPUT"');
    expect(prepare.run).toContain("timeout 60s git");
    expect(prepare.run).toContain("timeout 120s git");
    expect(prepare.run).toContain('echo "ready=true" >> "$GITHUB_OUTPUT"');
    expect(publish.if).toContain("steps.clawgrit_reports.outputs.ready == 'true'");
    expect(publish.run).toContain("timeout 120s git");
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
