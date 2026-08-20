// Mantis Telegram Desktop Proof Workflow tests cover mantis telegram desktop proof workflow script behavior.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const PROOF_SCRIPT = "scripts/e2e/telegram-user-crabbox-proof.ts";
const MANTIS_SUT_SCRIPT = "scripts/e2e/telegram-mantis-sut.ts";
const MANTIS_LANE_SCRIPT = "scripts/e2e/telegram-mantis-lane.ts";
const DESKTOP_CRABBOX_SCRIPT = "scripts/e2e/telegram-desktop-crabbox.ts";
const SUT_CONTAINER_WRAPPER = "scripts/mantis/mantis-sut-container.sh";
const CREDENTIAL_SCRIPT = "scripts/e2e/telegram-user-credential.ts";
const USER_DRIVER = "scripts/e2e/telegram-user-driver.py";
const QA_LAB_RUNTIME_API = "extensions/qa-lab/runtime-api.ts";
const PACKAGE_JSON = "package.json";
const WORKFLOW = ".github/workflows/mantis-telegram-desktop-proof.yml";
const DISPATCH_WORKFLOW = ".github/workflows/mantis-telegram-desktop-proof-dispatch.yml";
const LIVE_WORKFLOW = ".github/workflows/mantis-telegram-live.yml";
const SCENARIO_WORKFLOW = ".github/workflows/mantis-scenario.yml";
const PROMPT = ".github/codex/prompts/mantis-telegram-desktop-proof.md";
const PREFLIGHT_PROMPT = ".github/codex/prompts/mantis-telegram-desktop-preflight.md";
const TELEGRAM_PROOF_SKILL = ".agents/skills/telegram-crabbox-e2e-proof/SKILL.md";
const DOCS = ["docs/help/testing.md", "docs/concepts/qa-e2e-automation.md"];

type WorkflowStep = {
  "continue-on-error"?: boolean;
  if?: string;
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, boolean | number | string>;
};

type WorkflowJob = {
  if?: string;
  needs?: string | string[];
  steps?: WorkflowStep[];
};

type Workflow = {
  concurrency?: unknown;
  env?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
  on?: {
    issue_comment?: {
      types?: string[];
    };
    pull_request_target?: {
      types?: string[];
    };
    workflow_dispatch?: {
      inputs?: Record<
        string,
        {
          required?: boolean;
          type?: string;
        }
      >;
    };
  };
  permissions?: Record<string, string>;
};

function workflowStep(name: string): WorkflowStep {
  const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
  const steps = workflow.jobs?.run_telegram_desktop_proof?.steps ?? [];
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  return step;
}

function jobStep(workflowFile: string, jobName: string, stepName: string): WorkflowStep {
  const workflow = parse(readFileSync(workflowFile, "utf8")) as Workflow;
  const steps = workflow.jobs?.[jobName]?.steps ?? [];
  const step = steps.find((candidate) => candidate.name === stepName);
  if (!step) {
    throw new Error(`Missing workflow step: ${workflowFile} ${jobName} ${stepName}`);
  }
  return step;
}

function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const file = `${root}/${name}`;
    return statSync(file).isDirectory() ? filesUnder(file) : [file];
  });
}

describe("Mantis Telegram Desktop proof workflow", () => {
  it("dispatches from the scenario workflow using the proof workflow input contract", () => {
    const run = jobStep(SCENARIO_WORKFLOW, "dispatch", "Dispatch scenario").run ?? "";
    const branch = run.match(/telegram-desktop-proof\)([\s\S]*?)\n\s*;;/)?.[1];

    expect(branch).toBeDefined();
    expect(branch).toContain('if [[ -z "${PR_NUMBER:-}" ]]');
    expect(branch).toContain('-f "pr_number=${PR_NUMBER}"');
    expect(branch).not.toContain("baseline_ref=");
    expect(branch).not.toContain("candidate_ref=");
  });

  it("uses repository pnpm setup defaults", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const liveWorkflow = parse(readFileSync(LIVE_WORKFLOW, "utf8")) as Workflow;

    expect(workflow.env?.PNPM_VERSION).toBeUndefined();
    expect(liveWorkflow.env?.PNPM_VERSION).toBeUndefined();
  });

  it("pins every harness checkout to the dispatched workflow revision", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const checkouts = Object.values(workflow.jobs ?? {}).flatMap((job) =>
      (job.steps ?? []).filter((step) => step.name === "Checkout harness ref"),
    );

    expect(checkouts).toHaveLength(2);
    for (const checkout of checkouts) {
      expect(checkout.with?.ref).toBe("${{ github.workflow_sha }}");
      expect(checkout.with?.["persist-credentials"]).toBe(false);
    }
    const proofCheckout = workflow.jobs?.run_telegram_desktop_proof?.steps?.find(
      (step) => step.name === "Checkout harness ref",
    );
    expect(proofCheckout?.with?.["fetch-depth"]).toBe(1);
  });

  it("serializes on the shared credential rather than on other runs", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const liveWorkflow = parse(readFileSync(LIVE_WORKFLOW, "utf8")) as Workflow;
    const steps = workflow.jobs?.run_telegram_desktop_proof?.steps ?? [];
    const lease = workflowStep("Install TDLib and restore Telegram QA user");
    const leaseRun = lease.run;
    if (!leaseRun) {
      throw new Error("Telegram credential step must be a shell step");
    }

    expect(workflow.concurrency).toBeUndefined();
    expect(liveWorkflow.concurrency).toBeUndefined();

    // A run-liveness lock cannot see reality: GitHub leaves runs queued with no
    // jobs, they cannot be cancelled, and every later run then waits on a ghost.
    // The Convex credential is the authoritative mutex, so acquiring it is the lock.
    expect(steps.some((step) => /Wait for older/u.test(step.name ?? ""))).toBe(false);
    expect(workflow.permissions?.actions).toBe("read");
    expect(leaseRun).toContain("lease-restore");
    expect(leaseRun).toContain("until node --import tsx");
    expect(leaseRun).toContain("deadline=$(( SECONDS + 15 * 60 ))");
    expect(leaseRun).toContain("still leased by another run after 15 minutes");
    expect(leaseRun).toContain("sleep 60");
    expect(leaseRun.indexOf('echo "lease_file=$credential_dir/lease.json"')).toBeLessThan(
      leaseRun.indexOf("until node --import tsx"),
    );
  });

  it("releases the runner Telegram QA lease after the agent", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const steps = workflow.jobs?.run_telegram_desktop_proof?.steps ?? [];
    const codexStep = workflowStep("Run Codex Mantis Telegram agent");
    const cleanupIndex = steps.findIndex((step) => step.name === "Release Telegram QA user lease");
    const inspectIndex = steps.findIndex(
      (step) => step.name === "Inspect Mantis evidence manifest",
    );
    const restoreIndex = steps.findIndex(
      (step) => step.name === "Restore and validate trusted lane evidence",
    );
    const privateCleanupIndex = steps.findIndex(
      (step) => step.name === "Remove private Mantis runtime state",
    );

    expect(codexStep.env?.OPENCLAW_QA_CREDENTIAL_OWNER_ID).toBeUndefined();
    expect(codexStep.env?.OPENCLAW_TELEGRAM_USER_CREDENTIAL_PAYLOAD).toBeUndefined();
    expect(workflowStep("Prepare Codex user").run).not.toContain("OPENCLAW_QA_CREDENTIAL_OWNER_ID");
    expect(cleanupIndex).toBeGreaterThan(steps.findIndex((step) => step.name === codexStep.name));
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(cleanupIndex).toBeGreaterThan(restoreIndex);
    expect(privateCleanupIndex).toBeGreaterThan(cleanupIndex);
    expect(inspectIndex).toBeGreaterThan(cleanupIndex);
    const abandoned = workflowStep("Clean up abandoned Mantis sessions");
    expect(abandoned.if).toBe("${{ always() }}");
    expect(abandoned.run).toContain("sudo pkill -TERM -u codex");
    expect(abandoned.run).toContain("active_codex_pids()");
    expect(abandoned.run).toContain("sudo pkill -KILL -u codex");
    expect(abandoned.run).toContain('test -z "$(active_codex_pids)"');
    expect(abandoned.run).toContain('lane_uid="$(sudo stat -c %u "/proc/$lane_pid")"');
    expect(abandoned.run).toContain('[[ "$lane_pgid" == "$lane_pid" ]]');
    expect(abandoned.run).toContain('[[ "$lane_exe" == /usr/local/lib/mantis-toolchain/node ]]');
    expect(abandoned.run).toContain(
      "/usr/local/lib/mantis-toolchain/scripts/e2e/telegram-mantis-lane.mjs",
    );
    expect(abandoned.run).toContain('sudo kill -TERM -- "-$lane_pgid"');
    expect(abandoned.run).toContain('sudo kill -KILL -- "-$lane_pgid"');
    expect(abandoned.run).toContain('abort --lane "$lane"');
    expect(abandoned.run).toContain('echo "safe_to_release=true" >> "$GITHUB_OUTPUT"');

    const cleanupStep = workflowStep("Release Telegram QA user lease");
    expect(cleanupStep.if).toBe(
      "${{ always() && steps.abandoned_cleanup.outputs.safe_to_release == 'true' }}",
    );
    expect(cleanupStep.env?.OPENCLAW_QA_CONVEX_SECRET_CI).toContain(
      "secrets.OPENCLAW_QA_CONVEX_SECRET_CI",
    );
    expect(cleanupStep.env?.OPENCLAW_QA_CONVEX_SITE_URL).toContain(
      "secrets.OPENCLAW_QA_CONVEX_SITE_URL",
    );
    expect(cleanupStep.run).toContain("telegram-user-credential.ts");
    expect(cleanupStep.run).toContain("steps.telegram_credential.outputs.lease_file");
    expect(cleanupStep.run).toContain("sudo env");
    expect(cleanupStep.run).toContain("/usr/local/lib/mantis-toolchain/node --import tsx");
    expect(workflowStep("Clean up abandoned Mantis sessions").run).toContain(
      "${lane}.starting.json",
    );
    expect(workflowStep("Remove private Mantis runtime state").if).toBe(
      "${{ always() && steps.abandoned_cleanup.outputs.safe_to_release == 'true' }}",
    );
    expect(workflowStep("Remove private Mantis runtime state").run).toContain(
      "SESSION_ROOT:-/tmp/openclaw-mantis-proof-sessions-",
    );

    const returnArtifactsStep = workflowStep("Return proof artifacts to the runner");
    expect(returnArtifactsStep.if).toBe(
      "${{ always() && (steps.trusted_evidence.outcome == 'success' || steps.trusted_evidence_failure.outcome == 'success') }}",
    );
    expect(returnArtifactsStep.run).toContain(
      'sudo chown -R "$(id -u):$(id -g)" "$MANTIS_OUTPUT_DIR"',
    );

    const failureDiagnostics = workflowStep("Preserve trusted-evidence failure diagnostics");
    expect(failureDiagnostics.if).toBe(
      "${{ always() && steps.trusted_evidence.outcome == 'failure' }}",
    );
    expect(failureDiagnostics.run).toContain("The agent-authored output was quarantined");
    expect(failureDiagnostics.run).toContain('"$failure_output/$lane-diagnostic.json"');
    expect(failureDiagnostics.run).toContain('sudo mv -T "$agent_output" "$quarantine"');
    expect(failureDiagnostics.run).toContain('sudo mv -T "$failure_output" "$agent_output"');

    const sutWrapper = readFileSync(SUT_CONTAINER_WRAPPER, "utf8");
    expect(sutWrapper).toContain(
      'exec "$timeout_bin" --signal=TERM --kill-after=5s 30s /bin/bash "$0" "__${action}" "$@"',
    );
    expect(sutWrapper).toContain('"$(readlink -f "/proc/$PPID/exe")" == "$timeout_bin"');
    expect(sutWrapper).toContain("__stop)");
    expect(sutWrapper).toContain("__destroy)");
  });

  it("requires trusted activity facts for both proof lanes", () => {
    const gate = workflowStep("Restore and validate trusted lane evidence").run ?? "";

    expect(gate).toContain('[[ "$lane_status" != "skipped" ]]');
    expect(gate).toContain(".schemaVersion == 2");
    expect(gate).toContain('[[ "$fact_status" == "complete" ]]');
    expect(gate).toContain(".sendCount >= 1");
    expect(gate).toContain(".observation.truncated == false");
    expect(gate).toContain('any(.observation.events[]; .messageId == $focus and .actor == "bot")');
    expect(gate).toContain('any(.invocations[]; .command == "send")');
    expect(gate).toContain('any(.invocations[]; .command == "finish")');
    expect(gate).toContain(".observation.events");
    expect(gate).toContain(".providerRequests");
    expect(gate).toContain('copy_verified_artifacts "$lane" "$attempt_facts"');
    expect(gate).toContain('copy_verified_artifacts "$lane" "$verdict"');
    expect(gate).toContain('"$SESSION_ROOT/$lane.json"');
    expect(gate).toContain("build-telegram-desktop-proof-evidence.mts");
    expect(gate).toContain('--baseline-status "$baseline_status"');
    expect(gate).toContain('--candidate-status "$candidate_status"');
    expect(gate).toContain(".summary = $judgment[0].summary");
    expect(gate).toContain('sudo mv "$trusted_manifest" "$manifest"');
    expect(gate.indexOf('"$trusted_output/$lane/summary.json"')).toBeLessThan(
      gate.indexOf("build-telegram-desktop-proof-evidence.mts"),
    );
    expect(gate).toContain('sudo install -d -m 0755 -o root -g root "$trusted_output"');
    expect(gate).toContain('sudo mv -T "$agent_output" "$quarantine"');
    expect(gate).toContain('sudo mv -T "$trusted_output" "$agent_output"');
    expect(gate).toContain('agent_manifest="$quarantine/mantis-evidence.json"');
    expect(gate).toContain('sudo test ! -L "$agent_manifest"');
    expect(gate).toContain('test "$(sudo stat -c %h "$agent_manifest")" = 1');
    expect(gate).toContain(
      'sudo install -m 0400 -o root -g root "$agent_manifest" "$trusted_agent_manifest"',
    );
    expect(gate).toContain('agent_manifest="$trusted_agent_manifest"');
    expect(
      gate.indexOf(
        'sudo install -m 0400 -o root -g root "$agent_manifest" "$trusted_agent_manifest"',
      ),
    ).toBeLessThan(
      gate.indexOf("sudo jq -e '", gate.indexOf('agent_manifest="$trusted_agent_manifest"')),
    );
    expect(gate).toContain(
      'baseline_status="$(sudo jq -r \'.comparison.baseline.status\' "$agent_manifest")"',
    );
    expect(gate).not.toMatch(/sudo (?:install|tee)[^\n]*\$MANTIS_OUTPUT_DIR/u);
    expect(gate).toContain('.comparison.baseline.status == "pass"');
    expect(gate).toContain('.comparison.candidate.status == "pass"');
    expect(gate).not.toContain("recorder-self-check.png");
    expect(gate).not.toContain("capture_path_changed");
  });

  it("cleans partially started proof daemons when local SUT startup fails", () => {
    const proofScript = readFileSync(MANTIS_SUT_SCRIPT, "utf8");

    expect(proofScript).toContain("let stopped = false;");
    expect(proofScript).toContain('runSutContainerAction("stop", containerName, config.tempRoot)');
    expect(proofScript).toContain("Local SUT startup failed and cleanup was incomplete.");
    expect(proofScript).toContain("throw error;");
  });

  it("accepts maintainer comments and ClawSweeper labels without wasting proof setup", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const workflowText = readFileSync(WORKFLOW, "utf8");
    const dispatchWorkflow = parse(readFileSync(DISPATCH_WORKFLOW, "utf8")) as Workflow;
    const dispatchText = readFileSync(DISPATCH_WORKFLOW, "utf8");
    const dispatch = dispatchWorkflow.jobs?.dispatch;
    const resolver = workflow.jobs?.resolve_request;
    const capture = workflow.jobs?.run_telegram_desktop_proof;
    const noVisible = workflow.jobs?.report_no_visible_change;

    expect(workflow.on?.workflow_dispatch).toBeDefined();
    expect(workflow.on?.workflow_dispatch?.inputs?.approved_head_sha?.required).toBe(false);
    expect(workflow.on?.workflow_dispatch?.inputs?.request_source?.required).toBe(false);
    expect(workflow.on?.issue_comment).toBeUndefined();
    expect(workflow.on?.pull_request_target).toBeUndefined();
    expect(dispatchWorkflow.on?.issue_comment?.types).toEqual(["created"]);
    expect(dispatchWorkflow.on?.pull_request_target?.types).toEqual(["labeled"]);
    expect(dispatchWorkflow.permissions).toEqual({
      actions: "write",
      "pull-requests": "read",
    });
    expect(dispatchText).toContain("@openclaw-mantis");
    expect(dispatchText).toContain("telegram desktop proof");
    expect(dispatchText).toContain('new Set(["admin", "maintain", "write"])');
    expect(dispatchText).toContain('context.actor !== "clawsweeper[bot]"');
    expect(dispatchText).toContain("Ignoring Mantis label applied by");
    expect(dispatchText).toContain("actions.createWorkflowDispatch");
    expect(dispatchText).toContain('workflow_id: "mantis-telegram-desktop-proof.yml"');
    expect(dispatchText).toContain('inputs.allow_fork_candidate = "true"');
    expect(dispatchText).toContain("inputs.approved_head_sha = pr.head.sha");
    expect(dispatchText).toContain("pr.head.repo?.full_name");
    expect(dispatchText).toContain("if (!pr.head.repo)");
    expect(dispatchText).not.toContain("actions/checkout");
    expect(dispatchText).not.toContain("secrets.");
    expect(dispatch?.steps).toHaveLength(1);
    expect(workflowText).toContain('setOutput("request_source", requestSource)');
    expect(workflowText).toContain('context.actor === "github-actions[bot]"');
    expect(workflowText).toContain(
      'const dispatcherSources = new Set(["clawsweeper_label", "issue_comment"]);',
    );
    expect(workflowText).toContain("dispatcherSources.has(inputs.request_source)");
    expect(workflowText).toContain('requestSource === "clawsweeper_label"');
    expect(workflowText).toContain("pr.head.repo.full_name !== `${owner}/${repo}`");
    expect(workflowText).toContain("allow-bot-users: github-actions[bot]");
    expect(workflowText).not.toContain("allow-bot-users: github-actions[bot],clawsweeper[bot]");
    expect(workflowText).toContain("inputs.approved_head_sha !== candidateRevision");

    const preflightCheckout = resolver?.steps?.find(
      (step) => step.name === "Checkout preflight refs",
    );
    expect(preflightCheckout?.if).toContain("requires_preflight == 'true'");
    expect(preflightCheckout?.with?.["fetch-depth"]).toBe(1);
    const preflightFetch = resolver?.steps?.find((step) => step.name === "Fetch exact PR head");
    expect(preflightFetch?.run?.match(/git fetch/gu)).toHaveLength(1);
    expect(preflightFetch?.run).toContain('"$BASELINE_SHA"');
    expect(preflightFetch?.run).toContain('"+refs/pull/${MANTIS_PR_NUMBER}/head:');
    const classifier = resolver?.steps?.find((step) => step.name === "Classify visible behavior");
    expect(classifier?.uses).toContain("openai/codex-action@");
    expect(classifier?.with?.["codex-version"]).toBe("0.148.0");
    expect(classifier?.with?.sandbox).toBe("read-only");
    expect(classifier?.with?.effort).toBe("low");
    expect(classifier?.with?.["output-schema"]).toContain('"enum": ["run", "skip"]');
    expect(classifier?.with?.["prompt-file"]).toBe(PREFLIGHT_PROMPT);
    expect(classifier?.with?.["allow-bot-users"]).toBe("github-actions[bot]");
    expect(classifier?.["continue-on-error"]).toBe(true);
    expect(readFileSync(PREFLIGHT_PROMPT, "utf8")).toContain(
      "focus inspection, not to override the diff",
    );
    expect(readFileSync(PREFLIGHT_PROMPT, "utf8")).toContain(
      "changes are also internal-only unless they change what an end user sees in",
    );
    expect(capture?.if).toContain("needs.resolve_request.outputs.visibility_decision != 'skip'");
    expect(noVisible?.if).toContain("needs.resolve_request.outputs.visibility_decision == 'skip'");
    const noVisibleComment = noVisible?.steps?.find(
      (step) => step.name === "Comment that no visible proof applies",
    );
    const noVisibleToken = noVisible?.steps?.find(
      (step) => step.name === "Create Mantis GitHub App token",
    );
    expect(noVisibleToken?.with?.["permission-pull-requests"]).toBe("write");
    expect(noVisibleComment?.with?.script).toContain(
      "There was nothing visible to test in this PR at all.",
    );
    expect(noVisibleComment?.with?.script).toContain("mantis-telegram-desktop-proof");
    expect(noVisibleComment?.with?.script).toContain(
      'comment.user?.login === "openclaw-mantis[bot]"',
    );
    expect(noVisibleComment?.with?.script).toContain("Could not update Mantis comment");
    expect(noVisibleComment?.with?.script).toContain("issues.createComment");
    expect(workflowStep("Upload Mantis Telegram desktop artifacts").if).toContain(
      "steps.trusted_evidence.outcome == 'success'",
    );
    expect(workflowStep("Upload Mantis Telegram desktop artifacts").if).toContain(
      "steps.trusted_evidence_failure.outcome == 'success'",
    );
    expect(workflowStep("Comment PR with inline QA evidence").if).toContain(
      "steps.trusted_evidence.outcome == 'success'",
    );
  });

  it("can publish an existing proof artifact without recapturing", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const workflowText = readFileSync(WORKFLOW, "utf8");
    const publishJob = workflow.jobs?.publish_existing_telegram_desktop_proof;
    const captureJob = workflow.jobs?.run_telegram_desktop_proof;

    expect(workflow.on?.workflow_dispatch?.inputs?.publish_artifact_name?.required).toBe(false);
    expect(workflow.on?.workflow_dispatch?.inputs?.publish_run_id?.required).toBe(false);
    expect(captureJob?.if).toContain("needs.resolve_request.outputs.publish_artifact_name == ''");
    expect(captureJob?.if).toContain("needs.resolve_request.outputs.visibility_decision != 'skip'");
    expect(workflow.jobs?.validate_refs).toBeUndefined();
    expect(publishJob?.if).toBe(
      "needs.resolve_request.outputs.should_run == 'true' && needs.resolve_request.outputs.publish_artifact_name != ''",
    );
    expect(workflowText).toContain("publish_run_id is required when publish_artifact_name is set.");
    expect(workflowText).toContain('gh run download "$run_id"');
    expect(workflowText).toContain(
      '--artifact-root "mantis/telegram-desktop/pr-${TARGET_PR}/published-',
    );
    expect(workflowText).toContain(
      "PUBLISH_ARTIFACT_URL=https://github.com/${GITHUB_REPOSITORY}/actions/runs/",
    );
  });

  it("limits evidence publishers to comment and PR-read permissions", () => {
    const tokenSteps = [
      workflowStep("Create Mantis GitHub App token"),
      jobStep(
        WORKFLOW,
        "publish_existing_telegram_desktop_proof",
        "Create Mantis GitHub App token",
      ),
    ];

    for (const step of tokenSteps) {
      expect(step.with?.["permission-issues"]).toBe("write");
      expect(step.with?.["permission-pull-requests"]).toBe("read");
    }
  });

  it("uses the repo-owned Telegram user driver by default", () => {
    expect(existsSync(USER_DRIVER)).toBe(true);
    expect(readFileSync(PROOF_SCRIPT, "utf8")).toContain(
      'const DEFAULT_USER_DRIVER = "scripts/e2e/telegram-user-driver.py";',
    );
    expect(readFileSync(USER_DRIVER, "utf8")).toContain("/usr/local/lib/libtdjson.so");
  });

  it("keeps Telegram Desktop proof credentials out of the generic qa-lab API", () => {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const workflowFiles = filesUnder(".github/workflows").filter((file) => file.endsWith(".yml"));
    const telegramUserWorkflows = workflowFiles.filter((file) =>
      readFileSync(file, "utf8").includes("telegram-user"),
    );

    expect(readFileSync(QA_LAB_RUNTIME_API, "utf8")).not.toContain("telegram-user");
    expect(packageJson.scripts).not.toHaveProperty("qa:telegram-user:crabbox");
    expect(telegramUserWorkflows).toEqual([WORKFLOW]);
    for (const doc of DOCS) {
      expect(readFileSync(doc, "utf8")).not.toContain("pnpm qa:telegram-user:crabbox");
    }
    expect(readFileSync(TELEGRAM_PROOF_SKILL, "utf8")).not.toContain(
      "pnpm qa:telegram-user:crabbox",
    );
    expect(readFileSync(TELEGRAM_PROOF_SKILL, "utf8")).toContain(
      "OPENCLAW_TELEGRAM_USER_PROOF_CMD",
    );
    expect(readFileSync(PROOF_SCRIPT, "utf8")).not.toContain("pnpm qa:telegram-user:crabbox");
    expect(readFileSync(CREDENTIAL_SCRIPT, "utf8")).toContain(
      'const TELEGRAM_USER_QA_CREDENTIAL_KIND = "telegram-user";',
    );
    expect(readFileSync(CREDENTIAL_SCRIPT, "utf8")).not.toMatch(
      /from "\.\.\/qa\/convex-credential-broker\/convex\/payload_validation\.js"/u,
    );
  });

  it("authorizes Telegram Desktop from the leased TDLib user session", () => {
    const proofScript = readFileSync(PROOF_SCRIPT, "utf8");
    const userDriver = readFileSync(USER_DRIVER, "utf8");

    expect(proofScript).toContain("zbar-tools");
    expect(readFileSync(DESKTOP_CRABBOX_SCRIPT, "utf8")).toContain("isTransientSshFailure");
    expect(proofScript).toContain('rm -rf "$root/desktop/tdata"');
    expect(proofScript).toContain("terminate-desktop-sessions");
    expect(proofScript).toContain('confirm-qr --link "$link"');
    expect(proofScript).toContain("Telegram Desktop QR login code was not found.");
    expect(proofScript).toContain("terminateRemoteDesktopSession");
    expect(userDriver).toContain('"@type": "confirmQrCodeAuthentication"');
    expect(userDriver).toContain('"@type": "getActiveSessions"');
    expect(userDriver).toContain('"@type": "terminateSession"');
    expect(userDriver).toContain('sub.add_parser("terminate-session")');
    expect(userDriver).toContain('sub.add_parser("terminate-desktop-sessions")');
  });

  it("prepares the recorder, pinned TDLib, and runner QA session", () => {
    const workflowText = readFileSync(WORKFLOW, "utf8");
    // The CLI still drives the local-container desktop; only the brokered
    // coordinator path is gone, so none of its credentials may be wired.
    const crabbox = workflowStep("Install Crabbox CLI");
    const workflow = parse(workflowText) as Workflow;
    expect(workflow.env?.CRABBOX_VERSION).toMatch(/^\d+[.]\d+[.]\d+$/u);
    expect(workflow.env?.CRABBOX_LINUX_AMD64_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    expect(crabbox.run).toContain("releases/download/v${CRABBOX_VERSION}");
    expect(crabbox.run).toContain("sha256sum --check --strict");
    expect(crabbox.run).toContain('test "$(crabbox --version)" = "$CRABBOX_VERSION"');
    expect(workflow.jobs?.run_telegram_desktop_proof?.steps).not.toContainEqual(
      expect.objectContaining({ uses: expect.stringContaining("actions/setup-go@") }),
    );
    // Never pipe into `grep -q` under pipefail: the writer dies of SIGPIPE on the
    // first match and the assertion fails precisely when it should pass.
    expect(crabbox.run).toContain('crabbox_warmup_help="$(crabbox warmup --help 2>&1)"');
    expect(crabbox.run).not.toMatch(/\|\s*grep -q/u);
    expect(workflowText).not.toContain("CRABBOX_ACCESS_CLIENT_ID");
    expect(workflowText).not.toContain("CRABBOX_ACCESS_CLIENT_SECRET");
    expect(workflowText).not.toContain("CRABBOX_COORDINATOR");
    const install = workflowStep("Install local proof tools");
    const installRun = install.run;
    if (!installRun) {
      throw new Error("Proof tool installation must be a shell step");
    }
    expect(installRun).toContain("test -f scripts/e2e/telegram-user-driver.py");
    expect(installRun).toContain('node_bin="$(command -v node)"');
    expect(installRun).toContain('corepack_bin="$(command -v corepack)"');
    expect(installRun).toContain(
      'corepack_root="$(dirname "$(dirname "$(readlink -f "$corepack_bin")")")"',
    );
    expect(installRun).toContain("/usr/local/lib/mantis-toolchain/node");
    expect(installRun).toContain("/usr/local/lib/mantis-toolchain/pnpm");
    expect(installRun).toContain(
      'sudo install -m 0755 "$node_bin" /usr/local/lib/mantis-toolchain/node',
    );
    expect(installRun).toContain(
      'sudo cp -a "$corepack_root" /usr/local/lib/mantis-toolchain/corepack',
    );
    expect(installRun).toContain("/usr/local/lib/mantis-toolchain/corepack/dist/corepack.js pnpm");
    expect(installRun).not.toContain("${RUNNER_TEMP}/mantis-node");
    expect(installRun).toContain(
      'sudo install -m 0755 "$uv_bin" /usr/local/lib/mantis-toolchain/uv',
    );
    expect(installRun).not.toContain("${RUNNER_TEMP}/mantis-uv");
    expect(installRun).toContain("/usr/local/bin/openclaw-telegram-mantis-lane");
    expect(installRun).toContain("/usr/local/bin/openclaw-telegram-desktop-recorder");
    expect(installRun).toContain("node_modules/.bin/esbuild scripts/e2e/telegram-mantis-lane.ts");
    expect(installRun).toContain(
      "node_modules/.bin/esbuild scripts/e2e/telegram-desktop-recorder.ts",
    );
    expect(installRun).toContain(
      "/usr/local/lib/mantis-toolchain/scripts/e2e/telegram-mantis-lane.mjs",
    );
    expect(installRun).toContain(
      "/usr/local/lib/mantis-toolchain/scripts/e2e/telegram-desktop-recorder.mjs",
    );
    expect(installRun).not.toContain(
      '"${GITHUB_WORKSPACE}/scripts/e2e/telegram-mantis-lane.ts" "\\$@"',
    );
    const laneWrapper = installRun.slice(
      installRun.indexOf('cat >"${RUNNER_TEMP}/telegram-mantis-lane"'),
      installRun.indexOf('cat >"${RUNNER_TEMP}/openclaw-telegram-mantis-lane"'),
    );
    expect(laneWrapper).toContain("exec /usr/bin/setsid env -i");
    expect(installRun).toContain("sudo apt-get update");
    expect(installRun).toContain("sudo apt-get install -y ffmpeg");
    expect(installRun).toContain(
      "sudo ln -s /usr/bin/ffmpeg /usr/local/lib/mantis-toolchain/ffmpeg",
    );
    expect(installRun).toContain(
      "sudo ln -s /usr/bin/ffprobe /usr/local/lib/mantis-toolchain/ffprobe",
    );
    expect(installRun).toContain(
      "PATH=/usr/local/lib/mantis-toolchain:/usr/local/bin:/usr/bin:/bin",
    );
    expect(installRun).toContain(
      'cd "/tmp/openclaw-mantis-proof-sessions-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    );
    expect(installRun).toContain(
      'sudo install -d -m 2770 -o mantis-sut -g mantis-proof "$session_root"',
    );
    expect(installRun.indexOf("sudo install -d -m 2770")).toBeLessThan(
      installRun.indexOf("/usr/local/bin/openclaw-telegram-desktop-recorder --help"),
    );
    expect(installRun).not.toContain("dangerouslyAllowAllBuilds");
    expect(installRun).not.toContain("ffmpeg-static");
    expect(installRun).not.toContain("ffprobe-static");
    expect(installRun).not.toContain("BtbN/FFmpeg-Builds");
    expect(installRun).not.toContain("ffmpeg-master-latest-linux64-gpl.tar.xz");

    const image = workflowStep("Build local Telegram Desktop image");
    expect(image.run).toContain("bash scripts/mantis/build-telegram-desktop-image.sh");

    const credential = workflowStep("Install TDLib and restore Telegram QA user");
    expect(credential.run).toContain("http://artifacts.openclaw.ai/tdlib-v1.8.0-linux-x64.tgz");
    expect(credential.run).toContain('"${tdlib_url}.sha256"');
    expect(credential.run).toContain(
      "943518ad39f67e20f843713ba5c88fedbd06111fbc314c61bfb2fc3f1a45743e",
    );
    expect(credential.run).toContain('| cmp - "$tdlib_dir/tdlib-v1.8.0-linux-x64.tgz.sha256"');
    expect(credential.run).toContain(
      "sha256sum --strict --check tdlib-v1.8.0-linux-x64.tgz.sha256",
    );
    expect(credential.run).toContain("/usr/local/lib/libtdjson.so");
    expect(credential.run).toContain("telegram-user-credential.ts lease-restore");
    expect(credential.run).toContain("--payload-output");
    expect(credential.run).toContain("--lease-file");

    const agent = workflowStep("Run Codex Mantis Telegram agent");
    expect(agent.env?.OPENCLAW_TELEGRAM_MANTIS_LANE_CMD).toBe(
      "/usr/local/bin/openclaw-telegram-mantis-lane",
    );
    expect(agent.env?.OPENCLAW_TELEGRAM_USER_DRIVER_CMD).toBeUndefined();
    expect(agent.env?.OPENCLAW_TELEGRAM_MANTIS_SUT_CMD).toBeUndefined();
    expect(agent.env?.OPENCLAW_TELEGRAM_DESKTOP_RECORDER_CMD).toBeUndefined();
    expect(agent.env?.MANTIS_NODE_BIN).toBe("/usr/local/lib/mantis-toolchain/node");
    expect(agent.env?.MANTIS_PNPM_BIN).toBe("/usr/local/lib/mantis-toolchain/pnpm");
    expect(agent.env?.MANTIS_PR_CONTEXT).toBe("${{ needs.resolve_request.outputs.pr_context }}");
    expect(agent.env?.MANTIS_PR_NUMBER).toBeUndefined();
    expect(agent.env?.GH_TOKEN).toBeUndefined();
    expect(agent.env?.CRABBOX_COORDINATOR).toBeUndefined();
    expect(agent.env?.CRABBOX_COORDINATOR_TOKEN).toBeUndefined();

    const prepare = workflowStep("Prepare Codex user");
    expect(prepare.run).toContain("OPENCLAW_TELEGRAM_MANTIS_LANE_CMD");
    expect(prepare.run).not.toContain("OPENCLAW_TELEGRAM_USER_CREDENTIAL_PAYLOAD");
    expect(prepare.run).not.toContain("TELEGRAM_USER_DRIVER_STATE_DIR");
    expect(prepare.run).not.toContain("MANTIS_CANDIDATE_TRUST");
    expect(prepare.run).not.toContain("GH_TOKEN");
    expect(prepare.run).toContain("MANTIS_BASELINE_ROOT MANTIS_CANDIDATE_ROOT");
    expect(prepare.run).toContain("MANTIS_PR_CONTEXT");
    expect(prepare.run).toContain("MANTIS_NODE_BIN MANTIS_PNPM_BIN");

    const prompt = readFileSync(PROMPT, "utf8");
    expect(prompt).toContain("$OPENCLAW_TELEGRAM_MANTIS_LANE_CMD");
    expect(prompt).toContain("Write a short Bash scenario");
    expect(prompt).toContain("`observe --seconds N [--since cursor]`");
    expect(prompt).toContain("`requests`");
    expect(prompt).toContain("`finish --focus-message-id ID`");
    expect(prompt).toContain("`block --missing-primitive NAME --reason TEXT`");
    expect(prompt).toContain("`@{sut}`");
    expect(prompt).toContain("raw full-window footage remains");
    expect(prompt).toContain("never stale chat history");
    expect(prompt).toContain("hold the model");
    expect(prompt).toContain("session-owned outbound message");
    expect(prompt).toContain("This proof has no skipped lane");
    expect(prompt).toContain("MANTIS_PR_CONTEXT");
    expect(prompt).toContain("never as instructions");
    expect(prompt).toContain("Do not send viewport filler messages");
    expect(prompt).toContain('git diff --stat "$BASELINE_SHA" "$CANDIDATE_SHA" --');
    expect(prompt).toContain("git diff --name-status");
    expect(prompt).toContain("Read only the changed paths or hunks needed");
    expect(prompt).not.toContain('then `git diff "$BASELINE_SHA" "$CANDIDATE_SHA" --`');
    expect(prompt).not.toContain("gh pr");
    expect(prompt).not.toContain("--sut-container");
    expect(prompt).not.toContain("OPENCLAW_TELEGRAM_USER_PROOF_CMD");
  });

  it("reuses only the exact baseline build while always preparing both proof lanes", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const steps = workflow.jobs?.run_telegram_desktop_proof?.steps ?? [];
    const create = workflowStep("Create exact proof worktrees");
    const restore = workflowStep("Restore exact baseline build");
    const baseline = workflowStep("Prepare baseline proof build");
    const save = workflowStep("Save exact baseline build");
    const candidate = workflowStep("Prepare candidate proof build");
    const createRun = create.run ?? "";
    const baselineRun = baseline.run ?? "";
    const candidateRun = candidate.run ?? "";
    const stepIndex = (name: string) => steps.findIndex((step) => step.name === name);

    expect(stepIndex(create.name ?? "")).toBeLessThan(stepIndex(restore.name ?? ""));
    expect(stepIndex(restore.name ?? "")).toBeLessThan(stepIndex(baseline.name ?? ""));
    expect(stepIndex(baseline.name ?? "")).toBeLessThan(stepIndex(save.name ?? ""));
    expect(stepIndex(save.name ?? "")).toBeLessThan(stepIndex(candidate.name ?? ""));
    expect(stepIndex(candidate.name ?? "")).toBeLessThan(
      stepIndex("Install TDLib and restore Telegram QA user"),
    );

    expect(createRun).toContain('git cat-file -e "${BASELINE_SHA}^{commit}"');
    expect(createRun).toContain('git fetch --no-tags --depth 1 origin "$BASELINE_SHA"');
    expect(createRun).toContain('git fetch --no-tags origin "pull/${MANTIS_PR_NUMBER}/head"');
    expect(createRun).toContain('git worktree add --detach "$baseline_root" "$BASELINE_SHA"');
    expect(createRun).toContain('git worktree add --detach "$candidate_root" "$CANDIDATE_SHA"');
    expect(restore.uses).toContain("actions/cache/restore@");
    expect(restore.with?.key).toContain("needs.resolve_request.outputs.baseline_revision");
    expect(restore.with?.key).toContain("steps.proof_worktrees.outputs.lockfile_sha256");
    expect(restore.with?.key).toContain("steps.proof_worktrees.outputs.node_version");
    expect(restore.with?.key).toContain("steps.proof_worktrees.outputs.pnpm_version");
    expect(restore.with?.key).toContain("mantis-baseline-v3");
    expect(restore.with?.path).toBe(".artifacts/mantis-baseline-build.tar");
    expect(baseline.if).toBeUndefined();
    expect(baselineRun).toContain('"$toolchain_dir/pnpm" install --frozen-lockfile');
    expect(baselineRun).toContain('if [[ "$BASELINE_BUILD_CACHE_HIT" == "true" ]]');
    expect(baselineRun).toContain('tar -xf "$BASELINE_BUILD_ARCHIVE"');
    expect(baselineRun).toContain('"$toolchain_dir/pnpm" build');
    expect(baselineRun).toContain('tar -cf "$BASELINE_BUILD_ARCHIVE"');
    expect(baselineRun).toContain(".artifacts/build-all-cache");
    expect(baselineRun).toContain("for phase in tsdown-ai tsdown-packages tsdown-unified");
    expect(baselineRun).toContain("-type f -links +1");
    expect(save.if).toBe("steps.baseline_build_cache.outputs.cache-hit != 'true'");
    expect(save.uses).toContain("actions/cache/save@");
    expect(save.with?.path).toBe(restore.with?.path);
    expect(candidate.if).toBeUndefined();
    expect(candidateRun).toContain('sudo chown -R mantis-builder:mantis-builder "$candidate_root"');
    expect(candidateRun).toContain(
      'git -C "$baseline_root" diff --quiet "$BASELINE_SHA" "$CANDIDATE_SHA"',
    );
    expect(candidateRun).toContain("scripts/build-all.mts");
    expect(candidateRun).toContain("scripts/lib");
    expect(candidateRun).toContain("scripts/pnpm-runner.mts");
    expect(candidateRun).toContain("packages/normalization-core");
    expect(candidateRun).toContain("pnpm-lock.yaml");
    expect(candidateRun).toContain("pnpm-workspace.yaml");
    expect(candidateRun).toContain("tsconfig.json");
    expect(candidateRun).toContain(
      'tar --no-same-owner -C "$candidate_root" -xf "$BASELINE_BUILD_ARCHIVE"',
    );
    expect(candidateRun).toContain(".artifacts/build-all-cache dist/plugin-sdk");
    expect(candidateRun).toContain('find "$candidate_root/dist/plugin-sdk" -type l');
    expect(candidateRun).toContain('find "$candidate_root/dist/plugin-sdk" -type f -links +1');
    expect(candidateRun.indexOf("tar --no-same-owner")).toBeLessThan(
      candidateRun.indexOf('sudo chown -R mantis-builder:mantis-builder "$candidate_root"'),
    );
    expect(candidateRun).not.toContain("cp -al");
    expect(candidateRun).toContain(
      'sudo /usr/local/sbin/openclaw-mantis-sut-container build "$candidate_root"',
    );
    expect(candidateRun).not.toContain("sudo -u mantis-builder");
    expect(candidateRun).not.toContain("sudo setfacl");
    expect(candidateRun).toContain('test "$(cat "$candidate_root/.git")" = "$candidate_git_link"');
    expect(candidateRun).toContain(
      'git -c safe.directory="$candidate_root" -C "$candidate_root" diff --exit-code',
    );
    for (const run of [createRun, baselineRun, candidateRun]) {
      expect(run).not.toContain("GH_TOKEN");
      expect(run).not.toContain("OPENAI_API_KEY");
      expect(run).not.toContain("CRABBOX_");
      expect(run).not.toContain("OPENCLAW_QA_");
    }
  });

  it("keeps AWS Crabbox settings out of the local desktop proof", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const liveWorkflow = parse(readFileSync(LIVE_WORKFLOW, "utf8")) as Workflow;

    expect(workflow.env?.CRABBOX_AWS_REGION).toBeUndefined();
    expect(workflow.env?.CRABBOX_CAPACITY_REGIONS).toBeUndefined();
    expect(liveWorkflow.env?.CRABBOX_AWS_REGION).toBe("us-east-1");
    expect(liveWorkflow.env?.CRABBOX_CAPACITY_REGIONS).toBe("us-east-1");

    const agent = workflowStep("Run Codex Mantis Telegram agent");
    expect(agent.env?.CRABBOX_AWS_REGION).toBeUndefined();
    expect(agent.env?.CRABBOX_CAPACITY_REGIONS).toBeUndefined();

    const liveRun = jobStep(
      LIVE_WORKFLOW,
      "run_telegram_live",
      "Run Telegram live scenario and capture desktop evidence",
    );
    expect(liveRun.env?.CRABBOX_AWS_REGION).toBe("${{ env.CRABBOX_AWS_REGION }}");
    expect(liveRun.env?.CRABBOX_CAPACITY_REGIONS).toBe("${{ env.CRABBOX_CAPACITY_REGIONS }}");

    expect(readFileSync(WORKFLOW, "utf8")).not.toContain("CRABBOX_COORDINATOR");
  });

  it("runs the Mantis Codex agent in fast medium-effort mode", () => {
    const agent = workflowStep("Run Codex Mantis Telegram agent");

    expect(agent.uses).toContain("openai/codex-action@");
    expect(agent.with?.effort).toBe("medium");
    expect(agent.with?.["codex-args"]).toBe('["-c","service_tier=\\"fast\\""]');
  });

  it("derives refs from the PR instead of parsing comment prose", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const workflowText = readFileSync(WORKFLOW, "utf8");
    expect(workflowText).toContain("let baselineRevision = pr.base.sha");
    expect(workflowText).toContain("const candidateRevision = pr.head.sha");
    expect(workflowText).toContain("prComparison.data.merge_base_commit?.sha");
    expect(workflowText).toContain("basehead: `${pr.base.sha}...${candidateRevision}`");
    expect(workflowText).toContain("The PR comparison did not return an immutable merge base.");
    expect(workflowText).toContain('setOutput("baseline_ref", baselineRevision)');
    expect(workflowText).toContain('setOutput("candidate_ref", candidateRevision)');
    expect(workflowText).toContain('"pr_context"');
    expect(workflowText).toContain("pr.title.slice(0, 500)");
    expect(workflowText).toContain('(pr.body ?? "").slice(0, 12000)');
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        expect(step.run ?? "").not.toContain("${{ needs.resolve_request.outputs.pr_context }}");
      }
    }
    expect(workflowText).not.toContain("body.match");
    expect(workflowText).not.toContain("baselineMatch");
    expect(workflowText).not.toContain("candidateMatch");
    expect(workflowText).not.toContain("leaseMatch");
    expect(workflowText).not.toContain("fork-ok");
    expect(workflowText).toContain("allow_fork_candidate");
    expect(workflowText).toContain("Fork PR heads require explicit allow_fork_candidate approval");
  });

  it("trusts the open PR head and marks fork heads for sandboxed handling", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const workflowText = readFileSync(WORKFLOW, "utf8");
    expect(workflow.jobs?.run_telegram_desktop_proof?.needs).toBe("resolve_request");
    expect(workflowText).toContain('"GET /repos/{owner}/{repo}/compare/{basehead}"');
    expect(workflowText).toContain('baselineOnMain.data.status !== "ahead"');
    expect(workflowText).toContain('baselineOnMain.data.status !== "identical"');
    expect(workflowText).toContain('pr.state !== "open"');
    expect(workflowText).toContain("Candidate PR source repository is unavailable.");
    expect(workflowText).toContain("pr.head.repo.full_name !== `${owner}/${repo}`");

    const agent = workflowStep("Run Codex Mantis Telegram agent");
    expect(agent.env?.MANTIS_CANDIDATE_TRUST).toBeUndefined();
  });

  it("provisions uv before the step that pins it", () => {
    // The user driver is a PEP 723 script, so uv is a lane runtime dependency. The pin step
    // resolves it with `command -v`, which fails the run at setup when nothing installed it.
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const steps = workflow.jobs?.run_telegram_desktop_proof?.steps ?? [];
    const uvSetup = steps.findIndex((step) => step.uses?.startsWith("astral-sh/setup-uv@"));
    const toolPin = steps.findIndex((step) => step.name === "Install local proof tools");

    expect(uvSetup).toBeGreaterThanOrEqual(0);
    expect(uvSetup).toBeLessThan(toolPin);
  });

  it("pins every executable the agent runs to an absolute toolchain path", () => {
    // The recorder crosses a sudo boundary, where PATH is sudo's secure_path rather than
    // the agent's. A PATH-resolved tool works locally and fails in the lane as ENOENT
    // deep inside the agent step - run 32247220989 lost 25 minutes to `spawn uv ENOENT`.
    const agentEnv = workflowStep("Run Codex Mantis Telegram agent").env ?? {};
    const executables = Object.entries(agentEnv).filter(([key]) => /_(?:BIN|CMD)$/u.test(key));

    expect(executables.length).toBeGreaterThan(0);
    for (const [key, value] of executables) {
      expect(`${key}=${value.split(/\s+/u)[0]}`).toMatch(/[=]\//u);
    }
  });

  it("checks the Telegram user driver before leasing credentials", () => {
    const proofScript = readFileSync(PROOF_SCRIPT, "utf8");
    const startSession = proofScript.slice(
      proofScript.indexOf("async function startSession"),
      proofScript.indexOf("async function sendSessionProbe"),
    );
    const defaultProof = proofScript.slice(proofScript.indexOf("async function main"));

    expect(startSession).toContain("requireUserDriverScript(opts);");
    expect(startSession).toContain("leaseCredential({ localRoot, opts, root })");
    expect(defaultProof).toContain("requireUserDriverScript(opts);");
    expect(defaultProof).toContain("leaseCredential({ localRoot, opts, root })");
    expect(startSession.indexOf("requireUserDriverScript(opts);")).toBeLessThan(
      startSession.indexOf("leaseCredential({ localRoot, opts, root })"),
    );
    expect(startSession.indexOf("try {")).toBeLessThan(
      startSession.indexOf("leaseCredential({ localRoot, opts, root })"),
    );
    expect(startSession.indexOf("leaseCredential({ localRoot, opts, root })")).toBeLessThan(
      startSession.indexOf("warmupCrabbox(opts, root)"),
    );
    expect(startSession.indexOf("if (credential)")).toBeGreaterThan(
      startSession.indexOf("catch (error)"),
    );
    expect(
      startSession.indexOf("releaseCredential(root, opts, credential.leaseFile)"),
    ).toBeGreaterThan(startSession.indexOf("catch (error)"));
    expect(defaultProof.indexOf("requireUserDriverScript(opts);")).toBeLessThan(
      defaultProof.indexOf("leaseCredential({ localRoot, opts, root })"),
    );
  });

  it("crops the Telegram Desktop chat pane for PR proof GIFs", () => {
    const desktopCrabbox = readFileSync(DESKTOP_CRABBOX_SCRIPT, "utf8");
    const skill = readFileSync(TELEGRAM_PROOF_SKILL, "utf8");

    expect(desktopCrabbox).toContain("export const TELEGRAM_DESKTOP_WINDOW =");
    expect(desktopCrabbox).toContain("export const TELEGRAM_DESKTOP_CROP =");
    expect(desktopCrabbox).toContain("x: TELEGRAM_DESKTOP_WINDOW.x + 220");
    expect(desktopCrabbox).toContain("width: 430");
    expect(skill).toContain("crop can isolate the chat pane");
    expect(skill).not.toContain("650px` is the largest tested clean width");
  });

  it("bounds Telegram user Crabbox remote bootstrap network and build steps", () => {
    const proofScript = readFileSync(PROOF_SCRIPT, "utf8");

    expect(proofScript).toContain("run_setup_step()");
    expect(proofScript).toContain("download_file()");
    expect(proofScript).toContain('timeout --kill-after="$setup_step_timeout_kill_after"');
    expect(proofScript).not.toContain("timeout --foreground");
    expect(proofScript).toContain(
      'apt_timeout="\\${OPENCLAW_TELEGRAM_USER_APT_TIMEOUT_SECONDS:-900}s"',
    );
    expect(proofScript).toContain(
      'download_connect_timeout="\\${OPENCLAW_TELEGRAM_USER_DOWNLOAD_CONNECT_TIMEOUT_SECONDS:-15}"',
    );
    expect(proofScript).toContain(
      'download_timeout="\\${OPENCLAW_TELEGRAM_USER_DOWNLOAD_TIMEOUT_SECONDS:-600}"',
    );
    expect(proofScript).toContain('run_setup_step "apt-get update" "$apt_timeout"');
    expect(proofScript).toContain("download_file https://telegram.org/dl/desktop/linux");
    expect(proofScript).toContain('download_file "$tdlib_url" "$root/tdlib-linux.tgz"');
    expect(proofScript).toContain(
      'tdlib_clone_timeout="\\${OPENCLAW_TELEGRAM_USER_TDLIB_CLONE_TIMEOUT_SECONDS:-600}s"',
    );
    expect(proofScript).toContain('run_setup_step "tdlib clone" "$tdlib_clone_timeout"');
    expect(proofScript).toContain('run_setup_step "tdlib build" "$tdlib_build_timeout"');
    expect(proofScript).not.toContain("curl -fL https://telegram.org/dl/desktop/linux -o");
    expect(proofScript).not.toContain('curl -fL "$tdlib_url" -o');
  });

  it("gives the agent docker only through the recorder path", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    // Docker group membership would let the agent start the candidate build outside
    // /usr/local/sbin/openclaw-mantis-sut-container, making the attestation step decorative.
    // It reaches the daemon as the runner user, for this one exec path, instead.
    expect(workflow).not.toMatch(/usermod[^\n]*docker/);
    expect(workflow).not.toMatch(/groups[^\n]*codex[^\n]*docker/);
    expect(workflow).toContain(
      "codex ALL=(mantis-sut) NOPASSWD: /usr/local/lib/mantis-toolchain/telegram-mantis-lane",
    );
    expect(workflow).toContain(
      "mantis-sut ALL=(${recorder_user}) NOPASSWD: /usr/local/lib/mantis-toolchain/telegram-desktop-recorder",
    );
    expect(workflow).toContain(
      "exec sudo -n -u ${recorder_user} /usr/local/lib/mantis-toolchain/telegram-desktop-recorder",
    );
  });

  it("splits credential state by who owns each artifact", () => {
    const install = workflowStep("Install local proof tools").run ?? "";
    const prepare = workflowStep("Prepare Codex user").run ?? "";
    // The driver chmods its state dir to 0700, and chmod needs ownership rather than ACL
    // write, so sharing that dir between users fails as EPERM - run 32253541261 died there.
    // The credential-blind lane reaches the driver through sudo, leaving one owner.
    expect(prepare).toContain(
      "mantis-sut ALL=(${recorder_user}) NOPASSWD: /usr/local/lib/mantis-toolchain/telegram-user-driver",
    );
    expect(install).toContain(
      'exec sudo -n -u ${recorder_user} /usr/local/lib/mantis-toolchain/telegram-user-driver "\\$@"',
    );
    expect(prepare).not.toContain(
      'chown -R codex:codex "$(dirname "$OPENCLAW_TELEGRAM_USER_CREDENTIAL_LEASE")"',
    );
    expect(prepare).not.toMatch(/setfacl[^\n]*TELEGRAM_USER_DRIVER_STATE_DIR/u);
    expect(prepare).not.toMatch(/setfacl[^\n]*"\$credential_dir\/user-driver"/u);
    const credential = workflowStep("Install TDLib and restore Telegram QA user").run ?? "";
    expect(credential).toContain("sudo install -m 0400 -o mantis-sut -g mantis-proof");
    expect(credential).toContain('rm -f "$credential_dir/payload.json"');
    expect(prepare).not.toMatch(/u:codex:[^\n]*credential/u);
    expect(prepare).toContain('sudo -u codex find "$GITHUB_WORKSPACE" -xdev');
    expect(prepare).toContain('-path "$GITHUB_WORKSPACE/$MANTIS_OUTPUT_DIR" -prune');
    expect(prepare).not.toContain('chown -R codex:codex "$GITHUB_WORKSPACE"');
  });

  it("does not pass the full workflow environment into the local Telegram SUT", () => {
    const sutScript = readFileSync(MANTIS_SUT_SCRIPT, "utf8");
    const laneScript = readFileSync(MANTIS_LANE_SCRIPT, "utf8");
    const prompt = readFileSync(PROMPT, "utf8");
    const workflow = readFileSync(WORKFLOW, "utf8");
    const wrapper = readFileSync(SUT_CONTAINER_WRAPPER, "utf8");
    expect(sutScript).toContain("function childProcessBaseEnv()");
    expect(sutScript).toContain("...childProcessBaseEnv()");
    expect(sutScript).not.toContain("...process.env,\n    OPENAI_API_KEY");
    expect(sutScript).not.toContain("...process.env,\n    MOCK_PORT");
    expect(laneScript).toContain("function commandEnv()");
    expect(laneScript).toContain("fs.constants.O_NOFOLLOW");
    expect(laneScript).toContain("/proc/self/fd/${descriptor}");
    expect(laneScript).not.toContain("readRecorderSession");
    expect(laneScript).toContain('"artifacts"');
    expect(laneScript).toContain('status: status === "complete" ? "pass" : "fail"');
    expect(workflow).toContain("if .sutAttestation == null then");
    expect(workflow).toContain('.status == "infra-error" and .artifacts == {} and .sendCount == 0');
    expect(workflow).toContain(
      '(.invocations | length) == 1 and .invocations[0].command == "start"',
    );
    expect(workflow).toContain('if [[ "$pre_attestation_failure" != "true" ]]');
    expect(laneScript).toContain('requiredEnv("OPENCLAW_MANTIS_CREDENTIAL_FILE")');
    expect(wrapper).toContain("network create --driver bridge");
    expect(wrapper).toContain("--cap-drop ALL");
    expect(wrapper).toContain("--log-driver none");
    expect(wrapper).toContain("--memory 8g");
    expect(wrapper).toContain("--cpus 4");
    expect(wrapper).toContain("--memory 16g");
    expect(sutScript).not.toContain("CODEX_HOME");
    expect(sutScript).not.toContain("codexProxyPort");
    expect(wrapper).toContain('connects("runner-host", 9)');
    expect(wrapper).toContain("--add-host runner-host:host-gateway");
    expect(wrapper).not.toContain("PROXY_PORT");
    expect(wrapper.match(/run_network_probe "\$network_name"/gu)).toHaveLength(2);
    expect(wrapper).toContain('run_network_probe "$egress_network_name"');
    expect(wrapper).not.toMatch(/run_network_probe "\$network_name"[ \t]+\S/u);
    expect(wrapper).toContain('[[ $# -eq 0 ]] || die "check expects no arguments"');
    expect(wrapper).toContain("[[ $# -eq 6 ]]");
    const teardown = laneScript.slice(
      laneScript.indexOf("function teardownSut"),
      laneScript.indexOf("async function recoverStartupResources"),
    );
    expect(teardown.indexOf("stopMantisSut(sut)")).toBeLessThan(
      teardown.indexOf("preserveMantisSutRuntimeArtifacts(sut"),
    );
    expect(teardown.indexOf("preserveMantisSutRuntimeArtifacts(sut")).toBeLessThan(
      teardown.indexOf("destroyMantisSut(sut)"),
    );
    const startSession = laneScript.slice(laneScript.indexOf("async function startLane"));
    expect(startSession).not.toContain('"clear-chat"');
    expect(startSession).not.toContain("historyClearMode");
    expect(startSession.indexOf("Promise.allSettled")).toBeLessThan(
      startSession.indexOf('"serve"'),
    );
    expect(startSession.indexOf('"serve"')).toBeLessThan(
      startSession.indexOf("await waitForObserver(observerSocket)"),
    );
    expect(startSession).toContain('"--sut-username"');
    expect(prompt).toContain("--lane baseline|candidate");
    expect(prompt).toContain("start --repo-root <prepared-root>");
    expect(prompt).toContain("MANTIS_BASELINE_ROOT");
    expect(prompt).toContain("MANTIS_CANDIDATE_ROOT");
    expect(prompt).not.toContain("--sut-container");
    expect(prompt).toContain('--baseline-repo-root "$GITHUB_WORKSPACE"');
    expect(prompt).toContain('--candidate-repo-root "$GITHUB_WORKSPACE"');
    expect(workflow).toContain(
      "sudo install -m 0755 scripts/mantis/mantis-sut-container.sh /usr/local/sbin/openclaw-mantis-sut-container",
    );
    expect(workflow).toContain('sudo usermod -aG mantis-proof "$recorder_user"');
    expect(workflow).toContain(
      "mantis-sut ALL=(root) NOPASSWD: /usr/local/sbin/openclaw-mantis-sut-container",
    );
    expect(workflow).not.toContain(
      "codex ALL=(root) NOPASSWD: /usr/local/sbin/openclaw-mantis-sut-container",
    );
    expect(workflow).not.toContain("NOPASSWD:SETENV:");
    expect(workflow).toContain("/etc/openclaw-mantis-sut-revisions");
    expect(workflow).toContain('"$runtime_parent/attestations/$lane.json"');
    const attestationValidation =
      workflowStep("Restore and validate trusted lane evidence").run ?? "";
    expect(attestationValidation).toContain('[[ "$lane_status" != "skipped" ]]');
    expect(attestationValidation).not.toContain('if [[ "$lane_status" == "skipped"');
    expect(attestationValidation.indexOf(".comparison[$lane].sha == $sha")).toBeLessThan(
      attestationValidation.indexOf('"$runtime_parent/attestations/$lane.json"'),
    );
    expect(workflow).toContain('sudo chmod 0700 "$proof_worktree_root"');
    expect(workflow).toContain('sudo chown -R root:root "$proof_worktree_root"');
    const uploadPaths = String(
      workflowStep("Upload Mantis Telegram desktop artifacts").with?.path ?? "",
    );
    expect(uploadPaths).toContain("/mantis-evidence.json");
    // A capture-infrastructure failure produces no lane artifacts, so this log is the
    // only evidence of why the run could not record anything.
    expect(uploadPaths).toContain("/capture-failure.log");
    expect(uploadPaths).toContain("/baseline");
    expect(uploadPaths).toContain("/candidate");
    expect(uploadPaths).not.toContain("session.json");
    expect(wrapper).toContain("#!/bin/bash");
    expect(wrapper).toContain('readonly docker_bin="/usr/bin/docker"');
    expect(wrapper).toContain('readonly flock_bin="/usr/bin/flock"');
    expect(wrapper).toContain('readonly iptables_bin="/usr/sbin/iptables"');
    expect(wrapper).toContain("100.64.0.0/10");
    expect(wrapper).toContain("169.254.0.0/16");
    expect(wrapper).toContain("api.telegram.org");
    expect(wrapper).toContain('--network "$network_name"');
    expect(wrapper).toContain('create_internal_network "$network_name"');
    expect(wrapper).toContain('create_public_only_network "$egress_network_name"');
    expect(wrapper).toContain(
      'network connect --alias telegram-api-proxy "$network_name" "$proxy_container_name"',
    );
    expect(wrapper).toContain('--env TELEGRAM_PROXY_UPSTREAM_TOKEN="$telegram_bot_token"');
    expect(wrapper).toContain('export TELEGRAM_BOT_TOKEN="$telegram_alias_token"');
    expect(wrapper).not.toContain('export TELEGRAM_BOT_TOKEN="$telegram_bot_token"');
    expect(wrapper).toContain('remove_container_or_fail "${1}-telegram-proxy"');
    expect(workflow).toContain(
      "/usr/local/lib/mantis-toolchain/scripts/e2e/telegram-bot-api-proxy.mjs",
    );
    expect(wrapper).toContain('"$worktree_root/candidate"');
    expect(wrapper).toContain('"${SUDO_USER:-}" == "runner"');
    expect(wrapper).toContain("corepack pnpm install --frozen-lockfile");
    expect(wrapper).toContain('published_root="$worktree_root/.candidate-built-$$"');
    expect(wrapper).toContain('/bin/cp -a --no-dereference "$isolated_root/." "$published_root/"');
    expect(wrapper).toContain('rm -rf --one-file-system "$candidate_root"');
    expect(wrapper).not.toContain('/bin/cp -a "$isolated_root/." "$candidate_root/"');
    expect(wrapper).toContain('filesystem="$(create_bounded_filesystem "$container_name" 2G)"');
    expect(wrapper).toContain('mv -T "$runtime_source" "$quarantine"');
    expect(wrapper).toContain("/usr/sbin/runuser -u mantis-sut --");
    expect(wrapper).toContain('/bin/cp -a --no-dereference "$quarantine/." "$safe_runtime/"');
    expect(wrapper).not.toContain('/bin/cp -a "$runtime_source/." "$safe_runtime/"');
    expect(wrapper).toContain('create_bounded_filesystem "${container_name}-fs" 10G');
    expect(wrapper).toContain('ln -s "$safe_runtime" "$runtime_source"');
    expect(wrapper.indexOf('ln -s "$safe_runtime" "$runtime_source"')).toBeLessThan(
      wrapper.indexOf(
        "install -T -o mantis-sut -g mantis-proof -m 0600",
        wrapper.indexOf('ln -s "$safe_runtime" "$runtime_source"'),
      ),
    );
    expect(sutScript).toContain(
      'const mockResponseControlDir = path.join(config.tempRoot, "mock-control")',
    );
    expect(sutScript).toContain(
      'const requestLog = path.join(config.tempRoot, "mock-openai-requests.ndjson")',
    );
    expect(wrapper).toContain(
      'export MOCK_RESPONSE_CONTROL="$runtime_source/mock-control/response.json"',
    );
    const forwardedEnv = wrapper.slice(
      wrapper.indexOf("forwarded_env=("),
      wrapper.indexOf("docker_env=()"),
    );
    expect(forwardedEnv).toContain("MOCK_RESPONSE_CONTROL");
    expect(wrapper).toContain("refusing to destroy a running SUT container");
    expect(wrapper).toContain('destroy_bounded_filesystem "$runtime_root"');
    expect(wrapper).toContain('create_runtime_claim "$container_name" "$runtime_source"');
    expect(wrapper).toContain('cancel_runtime_claim "$1" "$runtime_source"');
    expect(wrapper).toContain("terminate_runtime_claim");
    expect(wrapper).toContain("never reread the claim by name here");
    expect(wrapper).toContain("refusing to destroy an active runtime claim");
    expect(wrapper).toContain("refusing to destroy runtime with pending network cleanup");
    expect(wrapper).toContain('remove_claimed_runtime_input "$runtime_parent/$1-input"');
    expect(wrapper).toContain('*) die "expected build, check, run, stop, or destroy"');
    expect(wrapper).toContain("chown mantis-sut:mantis-proof");
    expect(wrapper).toContain("install -T -o mantis-sut -g mantis-proof -m 0600");
    expect(wrapper).not.toContain("mantis-sut:mantis-sut");
    expect(wrapper).toContain('attested_sha="$(attest_worktree "$repo_root" "$lane")"');
    expect(wrapper).toContain("sut-attestation.json");
    expect(wrapper).toContain("host isolation rule did not observe the probe");
    expect(wrapper).toContain("remove_container_or_fail");
    expect(wrapper).toContain('if network_exists "$network_name"; then');
    expect(wrapper).toContain("with_network_lock create_public_only_network_unlocked");
    expect(wrapper).toContain("with_network_lock cleanup_network_unlocked");
    expect(wrapper).toContain('readonly network_state_root="/run/openclaw-mantis-sut-networks"');
    expect(wrapper).toContain('write_network_state "$network_name" "$subnet"');
    expect(wrapper).toContain('rm -f "$state_path"');
    expect(wrapper).not.toContain("/var/run/docker.sock");
  });
});
