import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const PROOF_SCRIPT = "scripts/e2e/telegram-user-crabbox-proof.ts";
const USER_DRIVER = "scripts/e2e/telegram-user-driver.py";
const PACKAGE_JSON = "package.json";
const WORKFLOW = ".github/workflows/mantis-telegram-desktop-proof.yml";
const LIVE_WORKFLOW = ".github/workflows/mantis-telegram-live.yml";

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
};

type WorkflowJob = {
  steps?: WorkflowStep[];
};

type Workflow = {
  env?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
};

type PackageJson = {
  packageManager?: string;
};

function repositoryPnpmMajor(): string {
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as PackageJson;
  const major = packageJson.packageManager?.match(/^pnpm@(\d+)\./)?.[1];
  if (!major) {
    throw new Error(`Missing pnpm packageManager pin in ${PACKAGE_JSON}`);
  }
  return major;
}

function workflowStep(name: string): WorkflowStep {
  const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
  const steps = workflow.jobs?.run_telegram_desktop_proof?.steps ?? [];
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  return step;
}

describe("Mantis Telegram Desktop proof workflow", () => {
  it("runs with the repository pnpm major", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const liveWorkflow = parse(readFileSync(LIVE_WORKFLOW, "utf8")) as Workflow;
    const pnpmMajor = repositoryPnpmMajor();

    expect(workflow.env?.PNPM_VERSION?.split(".", 1)[0]).toBe(pnpmMajor);
    expect(liveWorkflow.env?.PNPM_VERSION?.split(".", 1)[0]).toBe(pnpmMajor);
  });

  it("uses the repo-owned Telegram user driver by default", () => {
    expect(existsSync(USER_DRIVER)).toBe(true);
    expect(readFileSync(PROOF_SCRIPT, "utf8")).toContain(
      'const DEFAULT_USER_DRIVER = "scripts/e2e/telegram-user-driver.py";',
    );
    expect(readFileSync(USER_DRIVER, "utf8")).toContain("/usr/local/lib/libtdjson.so");
  });

  it("installs local proof tools before the Codex agent runs", () => {
    const install = workflowStep("Install local proof tools");
    expect(install.run).toContain("test -f scripts/e2e/telegram-user-driver.py");
    expect(install.run).toContain("BtbN/FFmpeg-Builds");
    expect(install.run).toContain("ffmpeg-master-latest-linux64-gpl.tar.xz");
    expect(install.run).toContain("/usr/local/bin/ffmpeg");
    expect(install.run).toContain("/usr/local/bin/ffprobe");
    expect(install.run).not.toContain("apt-get install");

    const agent = workflowStep("Run Codex Mantis Telegram agent");
    expect(agent.env?.OPENCLAW_TELEGRAM_USER_DRIVER_SCRIPT).toBe(
      "${{ github.workspace }}/scripts/e2e/telegram-user-driver.py",
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
      "OPENCLAW_TELEGRAM_USER_CRABBOX_BIN OPENCLAW_TELEGRAM_USER_CRABBOX_PROVIDER OPENCLAW_TELEGRAM_USER_DRIVER_SCRIPT",
    );
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
    expect(defaultProof.indexOf("requireUserDriverScript(opts);")).toBeLessThan(
      defaultProof.indexOf("leaseCredential({ localRoot, opts, root })"),
    );
  });
});
