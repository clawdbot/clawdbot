// Mantis Telegram Desktop Proof Workflow tests cover mantis telegram desktop proof workflow script behavior.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const PROOF_SCRIPT = "scripts/e2e/telegram-user-crabbox-proof.ts";
const MANTIS_SUT_SCRIPT = "scripts/e2e/telegram-mantis-sut.ts";
const DESKTOP_CRABBOX_SCRIPT = "scripts/e2e/telegram-desktop-crabbox.ts";
const SUT_CONTAINER_WRAPPER = "scripts/mantis/mantis-sut-container.sh";
const CREDENTIAL_SCRIPT = "scripts/e2e/telegram-user-credential.ts";
const USER_DRIVER = "scripts/e2e/telegram-user-driver.py";
const QA_LAB_RUNTIME_API = "extensions/qa-lab/runtime-api.ts";
const PACKAGE_JSON = "package.json";
const WORKFLOW = ".github/workflows/mantis-telegram-desktop-proof.yml";
const LIVE_WORKFLOW = ".github/workflows/mantis-telegram-live.yml";
const SCENARIO_WORKFLOW = ".github/workflows/mantis-scenario.yml";
const PROMPT = ".github/codex/prompts/mantis-telegram-desktop-proof.md";
const TELEGRAM_PROOF_SKILL = ".agents/skills/telegram-crabbox-e2e-proof/SKILL.md";
const DOCS = ["docs/help/testing.md", "docs/concepts/qa-e2e-automation.md"];

type WorkflowStep = {
  if?: string;
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, boolean | string>;
};

type WorkflowJob = {
  if?: string;
  steps?: WorkflowStep[];
};

type Workflow = {
  concurrency?: unknown;
  env?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
  on?: {
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

    expect(checkouts).toHaveLength(3);
    for (const checkout of checkouts) {
      expect(checkout.with?.ref).toBe("${{ github.workflow_sha }}");
      expect(checkout.with?.["persist-credentials"]).toBe(false);
    }
  });

  it("serializes on the shared credential rather than on other runs", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const liveWorkflow = parse(readFileSync(LIVE_WORKFLOW, "utf8")) as Workflow;
    const steps = workflow.jobs?.run_telegram_desktop_proof?.steps ?? [];
    const lease = workflowStep("Install TDLib and restore Telegram QA user");

    expect(workflow.concurrency).toBeUndefined();
    expect(liveWorkflow.concurrency).toBeUndefined();

    // A run-liveness lock cannot see reality: GitHub leaves runs queued with no
    // jobs, they cannot be cancelled, and every later run then waits on a ghost.
    // The Convex credential is the authoritative mutex, so acquiring it is the lock.
    expect(steps.some((step) => /Wait for older/u.test(step.name ?? ""))).toBe(false);
    expect(workflow.permissions?.actions).toBe("read");
    expect(lease.run).toContain("lease-restore");
    expect(lease.run).toContain("until node --import tsx");
    expect(lease.run).toContain("deadline=$(( SECONDS + 15 * 60 ))");
    expect(lease.run).toContain("still leased by another run after 15 minutes");
    expect(lease.run).toContain("sleep 60");
  });

  it("releases the runner Telegram QA lease after the agent", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const steps = workflow.jobs?.run_telegram_desktop_proof?.steps ?? [];
    const codexStep = workflowStep("Run Codex Mantis Telegram agent");
    const cleanupIndex = steps.findIndex((step) => step.name === "Release Telegram QA user lease");
    const inspectIndex = steps.findIndex(
      (step) => step.name === "Inspect Mantis evidence manifest",
    );
    const returnArtifactsIndex = steps.findIndex(
      (step) => step.name === "Return proof artifacts to the runner",
    );

    expect(codexStep.env?.OPENCLAW_QA_CREDENTIAL_OWNER_ID).toContain(
      "mantis-telegram-desktop-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(workflowStep("Prepare Codex user").run).toContain("OPENCLAW_QA_CREDENTIAL_OWNER_ID");
    expect(cleanupIndex).toBeGreaterThan(steps.findIndex((step) => step.name === codexStep.name));
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(returnArtifactsIndex).toBeGreaterThan(cleanupIndex);
    expect(inspectIndex).toBeGreaterThan(returnArtifactsIndex);

    const cleanupStep = workflowStep("Release Telegram QA user lease");
    expect(cleanupStep.if).toBe("${{ always() }}");
    expect(cleanupStep.env?.OPENCLAW_QA_CONVEX_SECRET_CI).toContain(
      "secrets.OPENCLAW_QA_CONVEX_SECRET_CI",
    );
    expect(cleanupStep.env?.OPENCLAW_QA_CONVEX_SITE_URL).toContain(
      "secrets.OPENCLAW_QA_CONVEX_SITE_URL",
    );
    expect(cleanupStep.run).toContain("telegram-user-credential.ts");
    expect(cleanupStep.run).toContain("OPENCLAW_TELEGRAM_USER_CREDENTIAL_LEASE");
    expect(cleanupStep.run).toContain("sudo env");
    expect(cleanupStep.run).toContain("/usr/local/lib/mantis-toolchain/node --import tsx");

    const returnArtifactsStep = workflowStep("Return proof artifacts to the runner");
    expect(returnArtifactsStep.if).toBe("${{ always() }}");
    expect(returnArtifactsStep.run).toContain(
      'sudo chown -R "$(id -u):$(id -g)" "$MANTIS_OUTPUT_DIR"',
    );

    const sutWrapper = readFileSync(SUT_CONTAINER_WRAPPER, "utf8");
    expect(sutWrapper).toContain(
      'exec "$timeout_bin" --signal=TERM --kill-after=5s 30s /bin/bash "$0" "__${action}" "$@"',
    );
    expect(sutWrapper).toContain('"$(readlink -f "/proc/$PPID/exe")" == "$timeout_bin"');
    expect(sutWrapper).toContain("__stop)");
    expect(sutWrapper).toContain("__destroy)");
  });

  it("cleans partially started proof daemons when local SUT startup fails", () => {
    const proofScript = readFileSync(MANTIS_SUT_SCRIPT, "utf8");

    expect(proofScript).toContain("let gatewayPid: number | undefined;");
    expect(proofScript).toContain('runSutContainerAction("stop", containerName, config.tempRoot)');
    expect(proofScript).toContain("Local SUT startup failed and cleanup was incomplete.");
    expect(proofScript).toContain("throw error;");
  });

  it("requires explicit maintainer dispatch before executing a PR worktree", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const workflowText = readFileSync(WORKFLOW, "utf8");

    expect(workflow.on?.workflow_dispatch).toBeDefined();
    expect(workflowText).not.toContain("issue_comment:");
    expect(workflowText).not.toContain("pull_request_target:");
    expect(workflowText).not.toContain("clear_issue_comment_reaction:");
    expect(workflowText).toContain("allow-bot-users: github-actions[bot]");
    expect(workflowText).not.toContain("allow-bot-users: clawsweeper[bot]");
    expect(workflowText).toContain('setOutput("request_source", "workflow_dispatch")');
  });

  it("can publish an existing proof artifact without recapturing", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const workflowText = readFileSync(WORKFLOW, "utf8");
    const publishJob = workflow.jobs?.publish_existing_telegram_desktop_proof;
    const captureJob = workflow.jobs?.run_telegram_desktop_proof;
    const validateJob = workflow.jobs?.validate_refs;

    expect(workflow.on?.workflow_dispatch?.inputs?.publish_artifact_name?.required).toBe(false);
    expect(workflow.on?.workflow_dispatch?.inputs?.publish_run_id?.required).toBe(false);
    expect(captureJob?.if).toBe(
      "needs.resolve_request.outputs.should_run == 'true' && needs.resolve_request.outputs.publish_artifact_name == ''",
    );
    expect(validateJob?.if).toBe(
      "needs.resolve_request.outputs.should_run == 'true' && needs.resolve_request.outputs.publish_artifact_name == ''",
    );
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
    expect(crabbox.run).toContain("github.com/openclaw/crabbox.git");
    // Every variable the restored step reads must exist, or `set -u` kills it.
    expect((parse(workflowText) as Workflow).env?.CRABBOX_REF).toBe("main");
    // Never pipe into `grep -q` under pipefail: the writer dies of SIGPIPE on the
    // first match and the assertion fails precisely when it should pass.
    expect(crabbox.run).toContain('crabbox_warmup_help="$(crabbox warmup --help 2>&1)"');
    expect(crabbox.run).not.toMatch(/\|\s*grep -q/u);
    expect(workflowText).not.toContain("CRABBOX_ACCESS_CLIENT_ID");
    expect(workflowText).not.toContain("CRABBOX_ACCESS_CLIENT_SECRET");
    expect(workflowText).not.toContain("CRABBOX_COORDINATOR");
    const install = workflowStep("Install local proof tools");
    expect(install.run).toContain("test -f scripts/e2e/telegram-user-driver.py");
    expect(install.run).toContain('node_bin="$(command -v node)"');
    expect(install.run).toContain('corepack_bin="$(command -v corepack)"');
    expect(install.run).toContain("/usr/local/lib/mantis-toolchain/node");
    expect(install.run).toContain("/usr/local/lib/mantis-toolchain/pnpm");
    expect(install.run).toContain("/usr/local/bin/openclaw-telegram-mantis-sut");
    expect(install.run).toContain("/usr/local/bin/openclaw-telegram-desktop-recorder");
    expect(install.run).toContain(
      'exec /usr/local/lib/mantis-toolchain/node --import tsx "${GITHUB_WORKSPACE}/scripts/e2e/telegram-mantis-sut.ts" "\\$@"',
    );
    expect(install.run).not.toContain("BtbN/FFmpeg-Builds");
    expect(install.run).not.toContain("ffmpeg-master-latest-linux64-gpl.tar.xz");
    expect(install.run).not.toContain("apt-get install");

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
    expect(agent.env?.OPENCLAW_TELEGRAM_USER_DRIVER_CMD).toContain(
      "uv run ${{ github.workspace }}/scripts/e2e/telegram-user-driver.py",
    );
    expect(agent.env?.OPENCLAW_TELEGRAM_MANTIS_SUT_CMD).toBe(
      "/usr/local/bin/openclaw-telegram-mantis-sut",
    );
    expect(agent.env?.OPENCLAW_TELEGRAM_DESKTOP_RECORDER_CMD).toBe(
      "/usr/local/bin/openclaw-telegram-desktop-recorder",
    );
    expect(agent.env?.MANTIS_NODE_BIN).toBe("/usr/local/lib/mantis-toolchain/node");
    expect(agent.env?.MANTIS_PNPM_BIN).toBe("/usr/local/lib/mantis-toolchain/pnpm");
    expect(agent.env?.CRABBOX_COORDINATOR).toBeUndefined();
    expect(agent.env?.CRABBOX_COORDINATOR_TOKEN).toBeUndefined();

    const prepare = workflowStep("Prepare Codex user");
    expect(prepare.run).toContain(
      "OPENCLAW_TELEGRAM_DESKTOP_RECORDER_CMD OPENCLAW_TELEGRAM_MANTIS_SUT_CMD OPENCLAW_TELEGRAM_USER_CREDENTIAL_PAYLOAD OPENCLAW_TELEGRAM_USER_DRIVER_CMD TELEGRAM_USER_DRIVER_STATE_DIR",
    );
    expect(prepare.run).toContain("MANTIS_CANDIDATE_TRUST");
    expect(prepare.run).toContain("MANTIS_BASELINE_ROOT MANTIS_CANDIDATE_ROOT");
    expect(prepare.run).toContain("MANTIS_NODE_BIN MANTIS_PNPM_BIN");

    const prompt = readFileSync(PROMPT, "utf8");
    expect(prompt).toContain('"$OPENCLAW_TELEGRAM_MANTIS_SUT_CMD" start');
    expect(prompt).toContain('"$OPENCLAW_TELEGRAM_DESKTOP_RECORDER_CMD" start');
    expect(prompt).toContain("--provider docker");
    expect(prompt).toContain("$OPENCLAW_TELEGRAM_USER_DRIVER_CMD send");
    expect(prompt).toContain("$OPENCLAW_TELEGRAM_USER_DRIVER_CMD wait");
    expect(prompt).toContain("--after-message-id");
    expect(prompt).toContain("--crop telegram-window");
    expect(prompt).toContain("MCP App Funnel proof is not supported");
    expect(prompt).not.toContain("--sut-container");
    expect(prompt).not.toContain("OPENCLAW_TELEGRAM_USER_PROOF_CMD");
  });

  it("prepares exact proof worktrees before agent secrets are available", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const steps = workflow.jobs?.run_telegram_desktop_proof?.steps ?? [];
    const step = workflowStep("Prepare proof worktrees with pinned toolchain");
    const run = step.run ?? "";

    expect(steps.findIndex((candidate) => candidate.name === step.name)).toBeLessThan(
      steps.findIndex(
        (candidate) => candidate.name === "Install TDLib and restore Telegram QA user",
      ),
    );

    expect(run).toContain('git cat-file -e "${BASELINE_SHA}^{commit}"');
    expect(run).toContain('git fetch --no-tags origin "pull/${MANTIS_PR_NUMBER}/head"');
    expect(run).toContain('git worktree add --detach "$baseline_root" "$BASELINE_SHA"');
    expect(run).toContain('git worktree add --detach "$candidate_root" "$CANDIDATE_SHA"');
    expect(run.match(/env -i/gu)).toHaveLength(2);
    expect(run).toContain('"$toolchain_dir/pnpm" install --frozen-lockfile');
    expect(run).toContain('"$toolchain_dir/pnpm" build');
    expect(run).toContain('sudo chown -R mantis-builder:mantis-builder "$candidate_root"');
    expect(run).toContain(
      'sudo /usr/local/sbin/openclaw-mantis-sut-container build "$candidate_root"',
    );
    expect(run).not.toContain("sudo -u mantis-builder");
    expect(run).not.toContain("sudo setfacl");
    expect(run).toContain('test "$(cat "$candidate_root/.git")" = "$candidate_git_link"');
    expect(run).toContain(
      'git -c safe.directory="$candidate_root" -C "$candidate_root" diff --exit-code',
    );
    expect(run).not.toContain("GH_TOKEN");
    expect(run).not.toContain("OPENAI_API_KEY");
    expect(run).not.toContain("CRABBOX_");
    expect(run).not.toContain("OPENCLAW_QA_");
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
    const workflowText = readFileSync(WORKFLOW, "utf8");
    expect(workflowText).toContain('setOutput("baseline_ref", pr.base.sha)');
    expect(workflowText).toContain('setOutput("candidate_ref", pr.head.sha)');
    expect(workflowText).not.toContain("body.match");
    expect(workflowText).not.toContain("baselineMatch");
    expect(workflowText).not.toContain("candidateMatch");
    expect(workflowText).not.toContain("leaseMatch");
    expect(workflowText).not.toContain("fork-ok");
    expect(workflowText).not.toContain("allow_fork_candidate");
  });

  it("trusts the open PR head and marks fork heads for sandboxed handling", () => {
    const workflowText = readFileSync(WORKFLOW, "utf8");
    expect(workflowText).toContain("repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}");
    expect(workflowText).toContain('candidate_trust="fork-pr-head"');
    expect(workflowText).toContain('pr_head_repo" != "$GITHUB_REPOSITORY"');

    const agent = workflowStep("Run Codex Mantis Telegram agent");
    expect(agent.env?.MANTIS_CANDIDATE_TRUST).toBe(
      "${{ needs.validate_refs.outputs.candidate_trust }}",
    );

    const prompt = readFileSync(PROMPT, "utf8");
    expect(prompt).toContain("MANTIS_CANDIDATE_TRUST");
    expect(prompt).toContain("fork-pr-head");
    expect(prompt).toContain("untrusted fork code");
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

  it("does not pass the full workflow environment into the local Telegram SUT", () => {
    const proofScript = readFileSync(PROOF_SCRIPT, "utf8");
    const prompt = readFileSync(PROMPT, "utf8");
    const workflow = readFileSync(WORKFLOW, "utf8");
    const wrapper = readFileSync(SUT_CONTAINER_WRAPPER, "utf8");
    expect(proofScript).toContain("function childProcessBaseEnv()");
    expect(proofScript).toContain("...childProcessBaseEnv()");
    expect(proofScript).not.toContain("...process.env,\n    OPENAI_API_KEY");
    expect(proofScript).not.toContain("...process.env,\n    MOCK_PORT");
    expect(proofScript).toContain('process.env.MANTIS_CANDIDATE_TRUST === "fork-pr-head"');
    expect(wrapper).toContain("network create --driver bridge");
    expect(wrapper).toContain("--cap-drop ALL");
    expect(wrapper).toContain("--log-driver none");
    expect(wrapper).toContain("--memory 8g");
    expect(wrapper).toContain("--cpus 4");
    expect(wrapper).toContain("--memory 16g");
    expect(readFileSync(MANTIS_SUT_SCRIPT, "utf8")).toContain("requireCodexProxyPort");
    expect(proofScript).toContain("preserveLocalSutRuntimeArtifacts");
    const finishSession = proofScript.slice(proofScript.indexOf("async function finishSession"));
    expect(finishSession.indexOf("stopLocalSutDaemon(session.localSut)")).toBeLessThan(
      finishSession.indexOf("preserveLocalSutRuntimeArtifacts(session.localSut"),
    );
    expect(finishSession.indexOf("preserveLocalSutRuntimeArtifacts(session.localSut")).toBeLessThan(
      finishSession.indexOf("destroyLocalSutRuntime(session.localSut)"),
    );
    expect(prompt).toContain("--lane <baseline|candidate>");
    expect(prompt).toContain("--repo-root <MANTIS_BASELINE_ROOT|MANTIS_CANDIDATE_ROOT>");
    expect(prompt).toContain("--provider docker");
    expect(prompt).not.toContain("--sut-container");
    expect(prompt).toContain('--baseline-repo-root "$GITHUB_WORKSPACE"');
    expect(prompt).toContain('--candidate-repo-root "$GITHUB_WORKSPACE"');
    expect(workflow).toContain(
      "sudo install -m 0755 scripts/mantis/mantis-sut-container.sh /usr/local/sbin/openclaw-mantis-sut-container",
    );
    expect(workflow).toContain(
      "codex ALL=(root) NOPASSWD: /usr/local/sbin/openclaw-mantis-sut-container",
    );
    expect(workflow).not.toContain("NOPASSWD:SETENV:");
    expect(workflow).toContain("/etc/openclaw-mantis-sut-revisions");
    expect(workflow).toContain("Validate root-owned SUT attestations");
    expect(workflow).toContain('"$runtime_parent/attestations/$lane.json"');
    const attestationValidation = workflowStep("Validate root-owned SUT attestations").run ?? "";
    expect(attestationValidation.indexOf(".comparison[$lane].sha == $sha")).toBeLessThan(
      attestationValidation.indexOf('if [[ "$lane_status" == "skipped" ]]'),
    );
    expect(attestationValidation.indexOf('if [[ "$lane_status" == "skipped" ]]')).toBeLessThan(
      attestationValidation.indexOf('"$runtime_parent/attestations/$lane.json"'),
    );
    expect(workflow).toContain('sudo chmod 0700 "$proof_worktree_root"');
    expect(workflow).toContain('sudo chown -R root:root "$proof_worktree_root"');
    const uploadPaths = String(
      workflowStep("Upload Mantis Telegram desktop artifacts").with?.path ?? "",
    );
    expect(uploadPaths).toContain("/mantis-evidence.json");
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
    expect(wrapper).toContain('"$worktree_root/candidate"');
    expect(wrapper).toContain('"${SUDO_USER:-}" == "runner"');
    expect(wrapper).toContain("corepack pnpm install --frozen-lockfile");
    expect(wrapper).toContain('published_root="$worktree_root/.candidate-built-$$"');
    expect(wrapper).toContain('/bin/cp -a --no-dereference "$isolated_root/." "$published_root/"');
    expect(wrapper).toContain('rm -rf --one-file-system "$candidate_root"');
    expect(wrapper).not.toContain('/bin/cp -a "$isolated_root/." "$candidate_root/"');
    expect(wrapper).toContain('filesystem="$(create_bounded_filesystem "$container_name" 2G)"');
    expect(wrapper).toContain('mv -T "$runtime_source" "$quarantine"');
    expect(wrapper).toContain("/usr/sbin/runuser -u codex --");
    expect(wrapper).toContain('/bin/cp -a --no-dereference "$quarantine/." "$safe_runtime/"');
    expect(wrapper).not.toContain('/bin/cp -a "$runtime_source/." "$safe_runtime/"');
    expect(wrapper).toContain('create_bounded_filesystem "${container_name}-fs" 10G');
    expect(wrapper).toContain('ln -s "$safe_runtime" "$runtime_source"');
    expect(wrapper).toContain("refusing to destroy a running SUT container");
    expect(wrapper).toContain('destroy_bounded_filesystem "$runtime_root"');
    expect(wrapper).toContain('create_runtime_claim "$container_name" "$runtime_source"');
    expect(wrapper).toContain('cancel_runtime_claim "$1" "$runtime_source"');
    expect(wrapper).toContain("terminate_runtime_claim");
    expect(wrapper).toContain("Never reread by name here");
    expect(wrapper).toContain("refusing to destroy an active runtime claim");
    expect(wrapper).toContain("refusing to destroy runtime with pending network cleanup");
    expect(wrapper).toContain('remove_claimed_runtime_input "$runtime_parent/$1-input"');
    expect(wrapper).toContain('*) die "expected build, check, run, stop, or destroy"');
    expect(wrapper).toContain("install -T -o codex -g codex -m 0600");
    expect(wrapper).toContain('attested_sha="$(attest_worktree "$repo_root" "$lane")"');
    expect(wrapper).toContain("sut-attestation.json");
    expect(wrapper.match(/run_network_probe "\$network_name"/gu)).toHaveLength(3);
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
