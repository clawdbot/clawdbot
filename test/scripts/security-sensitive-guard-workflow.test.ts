// Security Sensitive Guard Workflow tests cover sensitive file guard workflow behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/security-sensitive-guard.yml";
const CODEOWNERS = ".github/CODEOWNERS";

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
  name?: string;
  permissions?: Record<string, string>;
};

function readWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
}

describe("security-sensitive guard workflow", () => {
  it("uses the security-sensitive guard check name", () => {
    const parsed = readWorkflow();

    expect(parsed.name).toBe("Security Sensitive Guard");
    expect(parsed.jobs).toHaveProperty("security-sensitive-guard-detect");
    expect(parsed.jobs).toHaveProperty("security-sensitive-guard");
  });

  it("uses a metadata-only pull_request_target workflow with bounded write permissions", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const parsed = readWorkflow();

    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain("checks trusted base script only; never checks out PR head");
    expect(parsed.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
      issues: "write",
    });
    expect(parsed.jobs?.["security-sensitive-guard-detect"]?.permissions).toBeUndefined();
    expect(parsed.jobs?.["security-sensitive-guard"]?.permissions).toBeUndefined();
  });

  it("checks out only trusted base scripts and does not execute PR-controlled code", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const forbiddenSnippets = [
      "github.event.pull_request.head",
      "pullRequest.head",
      "pnpm install",
      "npm install",
      "pnpm dlx",
      "actions: write",
      "id-token: write",
    ];

    for (const snippet of forbiddenSnippets) {
      expect(workflow).not.toContain(snippet);
    }

    const jobs = readWorkflow().jobs ?? {};
    for (const jobName of ["security-sensitive-guard-detect", "security-sensitive-guard"]) {
      const steps = jobs[jobName]?.steps ?? [];
      const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));

      expect(checkout?.uses).toBe("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd");
      expect(checkout?.with?.ref).toBe("${{ github.workflow_sha }}");
      expect(checkout?.with?.ref).not.toBe("${{ github.event.pull_request.base.sha }}");
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
      expect(steps.at(-1)?.run).toBe("node scripts/github/security-sensitive-guard.mjs");
    }

    expect(workflow).not.toContain("OPENCLAW_SECURITY_SENSITIVE_GUARD_ROLLOUT_SHA");
    expect(workflow).not.toContain("Check security-sensitive guard rollout eligibility");
    expect(workflow).not.toContain("steps.rollout.outputs.ready");
    expect(workflow).not.toContain("/compare/");
  });

  it("keeps detection separate from the final required check", () => {
    const jobs = readWorkflow().jobs ?? {};
    const detectJob = jobs["security-sensitive-guard-detect"];
    const finalJob = jobs["security-sensitive-guard"];
    const detectSteps = detectJob?.steps ?? [];
    const finalSteps = finalJob?.steps ?? [];

    expect(finalJob?.needs).toEqual(["security-sensitive-guard-detect"]);
    expect(finalJob?.if).toContain("always()");
    expect(detectSteps.at(-1)?.env?.OPENCLAW_SECURITY_SENSITIVE_GUARD_MODE).toBe("detect");
    expect(finalSteps.at(-1)?.env?.OPENCLAW_SECURITY_SENSITIVE_GUARD_MODE).toBe("enforce");
    expect(finalSteps.at(-1)?.env?.OPENCLAW_SECURITY_TEAM_SLUG).toBe("openclaw-secops");
    expect(finalSteps.at(-1)?.env?.OPENCLAW_SECURITY_APPROVERS).toBe(
      "vincentkoc,steipete,joshavant",
    );
  });

  it("uses a dedicated checked-in script and detects the intended file surfaces", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const script = readFileSync("scripts/github/security-sensitive-guard.mjs", "utf8");
    const sharedScript = readFileSync("scripts/github/guard-shared.mjs", "utf8");
    const guardSources = `${script}\n${sharedScript}`;

    expect(workflow).toContain("scripts/github/security-sensitive-guard.mjs");
    expect(script).toContain('"security-sensitive-changed"');
    expect(script).toContain('path: ".gitignore"');
    expect(script).toContain(".env");
    expect(script).toContain("/allow-security-sensitive-change");
    expect(script).toContain("openclaw-secops");
    expect(guardSources).toContain("/memberships/");
    expect(script).toContain("A later push requires a fresh approval.");
    expect(script).toContain("process.exitCode = 1");
  });

  it("requires secops review for future workflow or guard changes", () => {
    const codeowners = readFileSync(CODEOWNERS, "utf8");
    expect(codeowners).toContain(
      "/.github/workflows/security-sensitive-guard.yml @openclaw/openclaw-secops",
    );
    expect(codeowners).toContain(
      "/test/scripts/security-sensitive-guard-workflow.test.ts @openclaw/openclaw-secops",
    );
    expect(codeowners).toContain(
      "/test/scripts/security-sensitive-guard-script.test.ts @openclaw/openclaw-secops",
    );
    expect(codeowners).toContain(
      "/scripts/github/security-sensitive-guard.mjs @openclaw/openclaw-secops",
    );
    expect(codeowners).toContain("/.gitignore @openclaw/openclaw-secops");
  });
});
