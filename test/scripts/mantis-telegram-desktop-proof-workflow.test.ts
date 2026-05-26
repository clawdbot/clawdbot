import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const PROOF_SCRIPT = "scripts/e2e/telegram-user-crabbox-proof.ts";
const CREDENTIAL_SCRIPT = "scripts/e2e/telegram-user-credential.ts";
const USER_DRIVER = "scripts/e2e/telegram-user-driver.py";
const QA_LAB_RUNTIME_API = "extensions/qa-lab/runtime-api.ts";
const PACKAGE_JSON = "package.json";
const WORKFLOW = ".github/workflows/mantis-telegram-desktop-proof.yml";
const LIVE_WORKFLOW = ".github/workflows/mantis-telegram-live.yml";
const PROMPT = ".github/codex/prompts/mantis-telegram-desktop-proof.md";
const TELEGRAM_PROOF_SKILL = ".agents/skills/telegram-crabbox-e2e-proof/SKILL.md";
const DOCS = ["docs/help/testing.md", "docs/concepts/qa-e2e-automation.md"];

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
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
  it("uses repository pnpm setup defaults", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const liveWorkflow = parse(readFileSync(LIVE_WORKFLOW, "utf8")) as Workflow;

    expect(workflow.env?.PNPM_VERSION).toBeUndefined();
    expect(liveWorkflow.env?.PNPM_VERSION).toBeUndefined();
  });

  it("serializes all Mantis Telegram account runs without workflow concurrency cancellation", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const liveWorkflow = parse(readFileSync(LIVE_WORKFLOW, "utf8")) as Workflow;

    expect(workflow.concurrency).toBeUndefined();
    expect(liveWorkflow.concurrency).toBeUndefined();
    expect(workflow.permissions?.actions).toBe("read");
    expect(liveWorkflow.permissions?.actions).toBe("read");

    for (const step of [
      jobStep(WORKFLOW, "run_telegram_desktop_proof", "Wait for older Mantis Telegram account run"),
      jobStep(LIVE_WORKFLOW, "run_telegram_live", "Wait for older Mantis Telegram account run"),
    ]) {
      expect(step.run).toContain("mantis-telegram-desktop-proof.yml");
      expect(step.run).toContain("mantis-telegram-live.yml");
      expect(step.run).toContain('gh run list --repo "$GITHUB_REPOSITORY"');
      expect(step.run).toContain('--status "$status"');
      expect(step.run).toContain("GITHUB_RUN_ID");
      expect(step.run).toContain(".createdAt < $current_created");
      expect(step.run).toContain("for status in queued in_progress waiting pending requested");
      expect(step.run).toContain("stale_before=");
      expect(step.run).toContain(".createdAt >= $stale_before");
      expect(step.run).toContain("run_has_active_jobs()");
      expect(step.run).toContain('gh run view "$run_id"');
      expect(step.run).toContain("${run_id#\\#}");
      expect(step.run).not.toContain('.[] | select(.status == "queued"');
      expect(step.run).toContain("sleep 60");
    }
  });

  it("releases Telegram Desktop proof leases left by interrupted agents", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const steps = workflow.jobs?.run_telegram_desktop_proof?.steps ?? [];
    const codexStep = workflowStep("Run Codex Mantis Telegram agent");
    const cleanupIndex = steps.findIndex(
      (step) => step.name === "Release leaked Telegram proof leases",
    );
    const inspectIndex = steps.findIndex(
      (step) => step.name === "Inspect Mantis evidence manifest",
    );

    expect(codexStep.env?.OPENCLAW_QA_CREDENTIAL_OWNER_ID).toContain(
      "mantis-telegram-desktop-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(workflowStep("Prepare Codex user").run).toContain("OPENCLAW_QA_CREDENTIAL_OWNER_ID");
    expect(cleanupIndex).toBeGreaterThan(steps.findIndex((step) => step.name === codexStep.name));
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(inspectIndex).toBeGreaterThan(cleanupIndex);

    const cleanupStep = workflowStep("Release leaked Telegram proof leases");
    expect(cleanupStep.if).toBe("${{ always() }}");
    expect(cleanupStep.env?.OPENCLAW_QA_CONVEX_SECRET_CI).toContain(
      "secrets.OPENCLAW_QA_CONVEX_SECRET_CI",
    );
    expect(cleanupStep.env?.OPENCLAW_QA_CONVEX_SITE_URL).toContain(
      "secrets.OPENCLAW_QA_CONVEX_SITE_URL",
    );
    expect(cleanupStep.env?.CRABBOX_PROVIDER).toContain(
      "needs.resolve_request.outputs.crabbox_provider",
    );
    expect(cleanupStep.run).toContain("sudo find .artifacts/qa-e2e");
    expect(cleanupStep.run).toContain("-name session.json");
    expect(cleanupStep.run).toContain('session.command === "telegram-user-crabbox-session"');
    expect(cleanupStep.run).toContain("telegram-user-crabbox-proof.ts");
    expect(cleanupStep.run).toContain(
      'finish --session "$session_file" --preview-crop telegram-window',
    );
    expect(cleanupStep.run).toContain("*/.session/lease.json");
    expect(cleanupStep.run).toContain('lease.kind === "telegram-user"');
    expect(cleanupStep.run).toContain("telegram-user-credential.ts");
    expect(cleanupStep.run).toContain("release --lease-file");
    expect(cleanupStep.run).toContain("status=1");
    expect(cleanupStep.run).toContain("sudo -u codex env");
    expect(cleanupStep.run).not.toContain("*/telegram-user-crabbox/*/session.json");
    expect(cleanupStep.run).not.toContain("*/telegram-user-crabbox/*/.session/lease.json");
  });

  it("cleans partially started proof daemons when local SUT startup fails", () => {
    const proofScript = readFileSync(PROOF_SCRIPT, "utf8");

    expect(proofScript).toContain("let mockPid: number | undefined;");
    expect(proofScript).toContain("let gatewayPid: number | undefined;");
    expect(proofScript).toContain("killPidTree(gatewayPid);");
    expect(proofScript).toContain("killPidTree(mockPid);");
    expect(proofScript).toContain("throw error;");
  });

  it("uses the OpenClaw Mantis mention as the comment trigger", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const liveWorkflow = readFileSync(LIVE_WORKFLOW, "utf8");
    expect(workflow).toContain("@openclaw-mantis");
    expect(workflow).toContain("/openclaw-mantis");
    expect(workflow).toContain("mantis: telegram-visible-proof");
    expect(workflow).toContain('setOutput("should_run", "false")');
    expect(workflow).toContain('normalized.includes("telegram desktop")');
    expect(liveWorkflow).toContain('normalized.includes("telegram desktop")');
    expect(liveWorkflow).toContain("!requestedDesktopProof");
    expect(workflow).not.toContain("@Mantis");
    expect(workflow).not.toContain("@mantis");
    expect(workflow).not.toContain('"/mantis"');
  });

  it("runs when ClawSweeper applies the Telegram proof label", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const workflowText = readFileSync(WORKFLOW, "utf8");

    expect(workflow.on?.pull_request_target?.types).toContain("labeled");
    expect(workflowText).toContain("github.event.label.name == 'mantis: telegram-visible-proof'");
    expect(workflowText).toContain('eventName === "pull_request_target"');
    expect(workflowText).toContain("context.payload.pull_request?.number");
    expect(workflowText).toContain("Accepted Mantis label trigger");
    expect(workflowText).toContain("allow-bot-users: clawsweeper[bot]");
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
    const payloadValidationImport =
      "../../qa/convex-credential-broker/convex/payload-validation.js";
    expect(readFileSync(CREDENTIAL_SCRIPT, "utf8")).toContain(
      'const TELEGRAM_USER_QA_CREDENTIAL_KIND = "telegram-user";',
    );
    expect(readFileSync(CREDENTIAL_SCRIPT, "utf8")).toContain(payloadValidationImport);
    const payloadValidationSource = normalize(
      `${dirname(CREDENTIAL_SCRIPT)}/${payloadValidationImport.replace(/\.js$/, ".ts")}`,
    );
    expect(existsSync(payloadValidationSource)).toBe(true);
    expect(readFileSync(CREDENTIAL_SCRIPT, "utf8")).not.toMatch(
      /from "\.\.\/qa\/convex-credential-broker\/convex\/payload-validation\.js"/u,
    );
  });

  it("authorizes Telegram Desktop from the leased TDLib user session", () => {
    const proofScript = readFileSync(PROOF_SCRIPT, "utf8");
    const userDriver = readFileSync(USER_DRIVER, "utf8");

    expect(proofScript).toContain("zbar-tools");
    expect(proofScript).toContain("isTransientSshFailure");
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

  it("installs local proof tools before the Codex agent runs", () => {
    const install = workflowStep("Install local proof tools");
    expect(install.run).toContain("test -f scripts/e2e/telegram-user-driver.py");
    expect(install.run).toContain("/usr/local/bin/openclaw-telegram-user-crabbox-proof");
    expect(install.run).toContain(
      'exec node --import tsx "${GITHUB_WORKSPACE}/scripts/e2e/telegram-user-crabbox-proof.ts" "$@"',
    );
    expect(install.run).toContain("BtbN/FFmpeg-Builds");
    expect(install.run).toContain("ffmpeg-master-latest-linux64-gpl.tar.xz");
    expect(install.run).toContain("/usr/local/bin/ffmpeg");
    expect(install.run).toContain("/usr/local/bin/ffprobe");
    expect(install.run).not.toContain("apt-get install");

    const agent = workflowStep("Run Codex Mantis Telegram agent");
    expect(agent.env?.OPENCLAW_TELEGRAM_USER_DRIVER_SCRIPT).toBe(
      "${{ github.workspace }}/scripts/e2e/telegram-user-driver.py",
    );
    expect(agent.env?.OPENCLAW_TELEGRAM_USER_PROOF_CMD).toBe(
      "/usr/local/bin/openclaw-telegram-user-crabbox-proof",
    );
    expect(agent.env?.OPENCLAW_TELEGRAM_USER_CRABBOX_BIN).toBe("/usr/local/bin/crabbox");
    expect(agent.env?.CRABBOX_COORDINATOR).toContain(
      "secrets.CRABBOX_COORDINATOR || secrets.OPENCLAW_QA_MANTIS_CRABBOX_COORDINATOR",
    );
    expect(agent.env?.CRABBOX_COORDINATOR_TOKEN).toContain(
      "secrets.CRABBOX_COORDINATOR_TOKEN || secrets.OPENCLAW_QA_MANTIS_CRABBOX_COORDINATOR_TOKEN",
    );

    const prepare = workflowStep("Prepare Codex user");
    expect(prepare.run).toContain(
      "OPENCLAW_TELEGRAM_USER_CRABBOX_BIN OPENCLAW_TELEGRAM_USER_CRABBOX_PROVIDER OPENCLAW_TELEGRAM_USER_DRIVER_SCRIPT OPENCLAW_TELEGRAM_USER_PROOF_CMD",
    );
    expect(prepare.run).toContain("MANTIS_CANDIDATE_TRUST");

    const prompt = readFileSync(PROMPT, "utf8");
    expect(prompt).toContain("$OPENCLAW_TELEGRAM_USER_PROOF_CMD");
    expect(prompt).toContain("do not run\n   `pnpm qa:telegram-user:crabbox` directly");
    expect(prompt).toContain("Let `start` return or fail on its\n   own");
    expect(prompt).toContain(
      "Use a long\n   command timeout for `start`, `send`, `view`, and `finish`",
    );
  });

  it("passes AWS capacity regions to Crabbox warmup", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const regions = "eu-west-1,eu-west-2,eu-central-1,us-east-1,us-west-2";

    expect(workflow.env?.CRABBOX_CAPACITY_REGIONS).toBe(regions);

    const agent = workflowStep("Run Codex Mantis Telegram agent");
    expect(agent.env?.CRABBOX_CAPACITY_REGIONS).toBe("${{ env.CRABBOX_CAPACITY_REGIONS }}");

    const prepare = workflowStep("Prepare Codex user");
    expect(prepare.run).toContain("CRABBOX_PROVIDER CRABBOX_CAPACITY_REGIONS");
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
    const proofScript = readFileSync(PROOF_SCRIPT, "utf8");
    const skill = readFileSync(TELEGRAM_PROOF_SKILL, "utf8");

    expect(proofScript).toContain("const TELEGRAM_PROOF_WINDOW =");
    expect(proofScript).toContain("const TELEGRAM_PROOF_CROP =");
    expect(proofScript).toContain("x: TELEGRAM_PROOF_WINDOW.x + 220");
    expect(proofScript).toContain("width: 430");
    expect(proofScript).toContain("geometry: TELEGRAM_PROOF_WINDOW");
    expect(proofScript).toContain("crop: TELEGRAM_PROOF_CROP");
    expect(skill).toContain("crop can isolate the chat pane");
    expect(skill).not.toContain("650px` is the largest tested clean width");
  });

  it("does not pass the full workflow environment into the local Telegram SUT", () => {
    const proofScript = readFileSync(PROOF_SCRIPT, "utf8");
    expect(proofScript).toContain("function childProcessBaseEnv()");
    expect(proofScript).toContain("...childProcessBaseEnv()");
    expect(proofScript).not.toContain("...process.env,\n    OPENAI_API_KEY");
    expect(proofScript).not.toContain("...process.env,\n    MOCK_PORT");
  });
});
