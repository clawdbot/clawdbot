import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/dependency-change-awareness.yml";
const CODEOWNERS = ".github/CODEOWNERS";

type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
  permissions?: Record<string, string>;
};

function readWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
}

describe("dependency change awareness workflow", () => {
  it("uses a metadata-only pull_request_target workflow with minimal write permissions", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const parsed = readWorkflow();

    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain("metadata-only workflow; no checkout or untrusted code execution");
    expect(parsed.permissions).toEqual({
      "pull-requests": "read",
      issues: "write",
    });
  });

  it("does not checkout or execute PR-controlled code", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const forbiddenSnippets = [
      "actions/checkout",
      "github.event.pull_request.head",
      "pullRequest.head",
      "pnpm install",
      "npm install",
      "pnpm dlx",
      "contents: write",
      "actions: write",
      "id-token: write",
      "secrets.",
      "github.rest.issues.createLabel",
    ];

    for (const snippet of forbiddenSnippets) {
      expect(workflow).not.toContain(snippet);
    }

    const steps = readWorkflow().jobs?.["dependency-change-awareness"]?.steps ?? [];
    expect(steps).toHaveLength(1);
    expect(steps[0].run).toBeUndefined();
  });

  it("uses a pinned GitHub Script action and bounded sticky comments", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const steps = readWorkflow().jobs?.["dependency-change-awareness"]?.steps ?? [];
    const step = steps[0];

    expect(step.uses).toBe("actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3");
    expect(step.with?.script).toContain("<!-- openclaw:dependency-change-awareness -->");
    expect(step.with?.script).toContain("const maxListedFiles = 25;");
    expect(step.with?.script).toContain("const sanitizeDisplayValue = (value)");
    expect(step.with?.script).toContain('.replace(/[\\u0000-\\u001f\\u007f]/gu, "?")');
    expect(step.with?.script).toContain(".slice(0, 240)");
    expect(step.with?.script).toContain('comment.user?.login === "github-actions[bot]"');
    expect(step.with?.script).toContain("github.rest.pulls.listFiles");
    expect(step.with?.script).toContain("github.rest.issues.createComment");
    expect(step.with?.script).toContain("github.rest.issues.updateComment");
    expect(step.with?.script).toContain("github.rest.issues.deleteComment");
    expect(workflow).toContain('"dependencies-changed"');
  });

  it("detects the intended dependency-related file surfaces", () => {
    const script = readWorkflow().jobs?.["dependency-change-awareness"]?.steps?.[0].with?.script;
    expect(script).toContain('filename === "package.json"');
    expect(script).toContain('filename === "pnpm-lock.yaml"');
    expect(script).toContain('filename === "pnpm-workspace.yaml"');
    expect(script).toContain('filename === "ui/package.json"');
    expect(script).toContain('filename.startsWith("patches/")');
    expect(script).toContain("^packages\\/[^/]+\\/package\\.json$");
    expect(script).toContain("^extensions\\/[^/]+\\/package\\.json$");
  });

  it("requires secops review for future workflow or guard changes", () => {
    const codeowners = readFileSync(CODEOWNERS, "utf8");
    expect(codeowners).toContain(
      "/.github/workflows/dependency-change-awareness.yml @openclaw/openclaw-secops",
    );
    expect(codeowners).toContain(
      "/test/scripts/dependency-change-awareness-workflow.test.ts @openclaw/openclaw-secops",
    );
  });
});
