import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/dependency-guard.yml";
const CODEOWNERS = ".github/CODEOWNERS";

type WorkflowStep = {
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  if?: string;
  name?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
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

describe("dependency guard workflow", () => {
  it("uses the dependency guard check name", () => {
    const parsed = readWorkflow();

    expect(parsed.name).toBe("Dependency Guard");
    expect(parsed.jobs).toHaveProperty("dependency-guard-detect");
    expect(parsed.jobs).toHaveProperty("dependency-guard-autoscrub");
    expect(parsed.jobs).toHaveProperty("dependency-guard");
    expect(parsed.jobs?.["dependency-guard"]?.name).toBeUndefined();
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
    expect(parsed.jobs?.["dependency-guard-autoscrub"]?.permissions).toEqual({
      contents: "read",
      issues: "write",
      "pull-requests": "read",
    });
    expect(parsed.jobs?.["dependency-guard-detect"]?.permissions).toBeUndefined();
    expect(parsed.jobs?.["dependency-guard"]?.permissions).toBeUndefined();
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
      "github.rest.issues.createLabel",
    ];

    for (const snippet of forbiddenSnippets) {
      expect(workflow).not.toContain(snippet);
    }

    const parsed = readWorkflow();
    const jobs = [
      parsed.jobs?.["dependency-guard-detect"],
      parsed.jobs?.["dependency-guard-autoscrub"],
      parsed.jobs?.["dependency-guard"],
    ];
    for (const job of jobs) {
      const steps = job?.steps ?? [];
      expect(steps[0].uses).toBe("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd");
      expect(steps[0].with?.ref).toBe("${{ github.event.pull_request.base.sha }}");
      expect(steps[0].with?.["persist-credentials"]).toBe(false);
      expect(steps.at(-1)?.run).toBe("node scripts/github/dependency-guard.mjs");
    }
  });

  it("keeps contents write scoped to the conditional autoscrub job", () => {
    const jobs = readWorkflow().jobs ?? {};
    const detectJob = jobs["dependency-guard-detect"];
    const autoscrubJob = jobs["dependency-guard-autoscrub"];
    const finalJob = jobs["dependency-guard"];

    expect(detectJob?.outputs?.autoscrub).toBe("${{ steps.guard.outputs.autoscrub }}");
    expect(detectJob?.outputs?.["autoscrub-owner"]).toBe(
      "${{ steps.guard.outputs.autoscrub-owner }}",
    );
    expect(detectJob?.outputs?.["autoscrub-repository"]).toBe(
      "${{ steps.guard.outputs.autoscrub-repository }}",
    );
    expect(autoscrubJob?.needs).toBe("dependency-guard-detect");
    expect(autoscrubJob?.if).toContain("needs.dependency-guard-detect.outputs.autoscrub == 'true'");
    expect(finalJob?.needs).toEqual(["dependency-guard-detect", "dependency-guard-autoscrub"]);
    expect(finalJob?.if).toContain("always()");

    const detectSteps = detectJob?.steps ?? [];
    const autoscrubSteps = autoscrubJob?.steps ?? [];
    const finalSteps = finalJob?.steps ?? [];
    expect(detectSteps[1].env?.OPENCLAW_DEPENDENCY_GUARD_MODE).toBe("detect");
    expect(autoscrubSteps[1].uses).toBe(
      "actions/create-github-app-token@1b10c78c7865c340bc4f6099eb2f838309f1e8c3",
    );
    expect(autoscrubSteps[1].with).toMatchObject({
      "app-id": "2729701",
      owner: "${{ needs.dependency-guard-detect.outputs.autoscrub-owner }}",
      repositories: "${{ needs.dependency-guard-detect.outputs.autoscrub-repository }}",
      "permission-contents": "write",
    });
    expect(autoscrubSteps[1]["continue-on-error"]).toBe(true);
    expect(autoscrubSteps[2].uses).toBe(
      "actions/create-github-app-token@1b10c78c7865c340bc4f6099eb2f838309f1e8c3",
    );
    expect(autoscrubSteps[2].with).toMatchObject({
      "app-id": "2971289",
      owner: "${{ needs.dependency-guard-detect.outputs.autoscrub-owner }}",
      repositories: "${{ needs.dependency-guard-detect.outputs.autoscrub-repository }}",
      "permission-contents": "write",
    });
    expect(autoscrubSteps[2]["continue-on-error"]).toBe(true);
    expect(autoscrubSteps[3].env?.GITHUB_TOKEN).toBe("${{ github.token }}");
    expect(autoscrubSteps[3].env?.OPENCLAW_DEPENDENCY_GUARD_AUTOSCRUB_TOKEN).toBe(
      "${{ steps.app-token.outputs.token || steps.app-token-fallback.outputs.token }}",
    );
    expect(autoscrubSteps[3].env?.OPENCLAW_DEPENDENCY_GUARD_MODE).toBe("autoscrub");
    expect(finalSteps[1].env?.OPENCLAW_DEPENDENCY_GUARD_MODE).toBe("enforce");
  });

  it("preserves dependency-guard as the final required check", () => {
    const steps = readWorkflow().jobs?.["dependency-guard"]?.steps ?? [];
    expect(steps).toHaveLength(2);
    expect(steps[0].uses).toBe("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd");
    expect(steps[0].with?.ref).toBe("${{ github.event.pull_request.base.sha }}");
    expect(steps[0].with?.["persist-credentials"]).toBe(false);
    expect(steps[1].run).toBe("node scripts/github/dependency-guard.mjs");
  });

  it("uses a dedicated checked-in script and bounded sticky comments", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const detectSteps = readWorkflow().jobs?.["dependency-guard-detect"]?.steps ?? [];
    const runStep = detectSteps[1];
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
    expect(script).toContain("createAutoscrubCommit");
    expect(script).toContain("chore: remove dependency lockfile change");
    expect(script).toContain("process.exitCode = 1");
  });

  it("cleans dependency label and guard comment after successful autoscrub", () => {
    const script = readFileSync("scripts/github/dependency-guard.mjs", "utf8");
    const autoscrubCommitIndex = script.indexOf("const commit = await createAutoscrubCommit");
    const removeLabelIndex = script.indexOf(
      "await removeLabelIfPresent(dependencyChangedLabel)",
      autoscrubCommitIndex,
    );
    const deleteCommentIndex = script.indexOf(
      "await deleteCommentIfPresent(dependencyComment)",
      autoscrubCommitIndex,
    );
    const autoscrubCommentIndex = script.indexOf(
      "renderAutoscrubbedDependencyComment",
      autoscrubCommitIndex,
    );

    expect(autoscrubCommitIndex).toBeGreaterThan(0);
    expect(removeLabelIndex).toBeGreaterThan(autoscrubCommitIndex);
    expect(deleteCommentIndex).toBeGreaterThan(autoscrubCommitIndex);
    expect(autoscrubCommentIndex).toBeGreaterThan(deleteCommentIndex);
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
