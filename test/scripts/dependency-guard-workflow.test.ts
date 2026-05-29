import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/dependency-guard.yml";
const CODEOWNERS = ".github/CODEOWNERS";

type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  name?: string;
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

describe("dependency guard workflow", () => {
  it("uses the dependency guard check name", () => {
    const parsed = readWorkflow();

    expect(parsed.name).toBe("Dependency Guard");
    expect(parsed.jobs).toHaveProperty("dependency-guard");
    expect(parsed.jobs?.["dependency-guard"]?.name).toBeUndefined();
  });

  it("uses a metadata-only pull_request_target workflow with minimal write permissions", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const parsed = readWorkflow();

    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain("checks trusted base script only; never checks out PR head");
    expect(parsed.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
      issues: "write",
    });
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
      "secrets.",
      "github.rest.issues.createLabel",
    ];

    for (const snippet of forbiddenSnippets) {
      expect(workflow).not.toContain(snippet);
    }

    const steps = readWorkflow().jobs?.["dependency-guard"]?.steps ?? [];
    expect(steps).toHaveLength(2);
    expect(steps[0].uses).toBe("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd");
    expect(steps[0].with?.ref).toBe("${{ github.event.pull_request.base.sha }}");
    expect(steps[0].with?.["persist-credentials"]).toBe(false);
    expect(steps[1].run).toBe("node scripts/github/dependency-guard.mjs");
  });

  it("uses a dedicated checked-in script and bounded sticky comments", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const steps = readWorkflow().jobs?.["dependency-guard"]?.steps ?? [];
    const runStep = steps[1];
    const script = readFileSync("scripts/github/dependency-guard.mjs", "utf8");

    expect(runStep.env?.OPENCLAW_SECURITY_TEAM_SLUG).toBe("openclaw-secops");
    expect(runStep.env?.OPENCLAW_SECURITY_APPROVERS).toBe("vincentkoc,steipete,joshavant");
    expect(workflow).toContain("scripts/github/dependency-guard.mjs");
    expect(script).toContain('"dependencies-changed"');
    expect(script).not.toContain('"blocked: dependencies"');
  });

  it("detects the intended dependency-related file surfaces", () => {
    const script = readFileSync("scripts/github/dependency-guard.mjs", "utf8");
    expect(script).toContain('filename.endsWith("package.json")');
    expect(script).toContain('filename.endsWith("package-lock.json")');
    expect(script).toContain('filename.endsWith("npm-shrinkwrap.json")');
    expect(script).toContain('filename.endsWith("pnpm-lock.yaml")');
    expect(script).toContain('filename === "pnpm-workspace.yaml"');
    expect(script).toContain('filename.startsWith("patches/")');
    expect(script).toContain("dependencyGraphFiles");
  });

  it("blocks package lockfile and manifest graph changes unless secops approves the current head sha", () => {
    const script = readFileSync("scripts/github/dependency-guard.mjs", "utf8");
    expect(script).toContain('filename.endsWith("pnpm-lock.yaml")');
    expect(script).toContain('filename.endsWith("package-lock.json")');
    expect(script).toContain('filename.endsWith("npm-shrinkwrap.json")');
    expect(script).toContain('"optionalDependencies"');
    expect(script).toContain('"peerDependencies"');
    expect(script).toContain('"overrides"');
    expect(script).toContain('"packageManager"');
    expect(script).toContain("/allow-dependencies-change");
    expect(script).toContain("openclaw-secops");
    expect(script).toContain("securityApproverSet");
    expect(script).toContain("/memberships/");
    expect(script).toContain("isCommentNewerThan");
    expect(script).toContain("A later push requires a fresh approval.");
    expect(script).toContain("process.exitCode = 1");
  });

  it("requires secops review for future workflow or guard changes", () => {
    const codeowners = readFileSync(CODEOWNERS, "utf8");
    expect(codeowners).toContain(
      "/.github/workflows/dependency-guard.yml @openclaw/openclaw-secops",
    );
    expect(codeowners).toContain(
      "/test/scripts/dependency-guard-workflow.test.ts @openclaw/openclaw-secops",
    );
    expect(codeowners).toContain("/scripts/github/dependency-guard.mjs @openclaw/openclaw-secops");
    expect(codeowners).toContain("/package-lock.json @openclaw/openclaw-secops");
    expect(codeowners).toContain("/npm-shrinkwrap.json @openclaw/openclaw-secops");
    expect(codeowners).toContain("/extensions/*/package-lock.json @openclaw/openclaw-secops");
    expect(codeowners).toContain("/extensions/*/npm-shrinkwrap.json @openclaw/openclaw-secops");
  });
});
