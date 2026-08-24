// Mantis Web UI Chat Proof Workflow tests cover mantis web ui chat proof workflow behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/mantis-web-ui-chat-proof.yml";
const SHARED_RESOLVE_WORKFLOW = ".github/workflows/mantis-resolve-request.yml";

type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

function resolveRequestScript(): string {
  const workflow = parse(readFileSync(SHARED_RESOLVE_WORKFLOW, "utf8")) as Workflow;
  const steps = workflow.jobs?.resolve?.steps ?? [];
  const step = steps.find((candidate) => candidate.name === "Resolve refs and target PR");
  if (!step?.with?.script) {
    throw new Error("Missing shared Resolve refs and target PR script");
  }
  return step.with.script;
}

function workflowJob(name: string): WorkflowJob {
  const workflow = parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
  const job = workflow.jobs?.[name];
  if (!job) {
    throw new Error(`Missing ${name} job`);
  }
  return job;
}

function candidateOverridePattern(): RegExp {
  const script = resolveRequestScript();
  const template = script.match(
    /const pattern = new RegExp\(\s*`((?:\\`|[^`])*)`,\s*"i",\s*\);/u,
  )?.[1];
  const keysLiteral = script.match(/const rawCandidate = token\((\[[^\n]+\])\);/u)?.[1];
  if (!template || !keysLiteral) {
    throw new Error("Missing shared candidate token pattern");
  }
  const keys = JSON.parse(keysLiteral) as string[];
  if (keys.join("|") !== "candidate|head") {
    throw new Error(`Unexpected candidate token keys: ${keys.join("|")}`);
  }
  const instantiated = template.replace('${keys.join("|")}', keys.join("|")).replaceAll("\\`", "`");
  const source = JSON.parse(`"${instantiated.replaceAll('"', '\\"')}"`) as string;
  return new RegExp(source, "i");
}

function resolveCandidateRef(body: string, pullRequestHead: string): string {
  const script = resolveRequestScript();
  if (!script.includes('!["head", "pr", "pr-head"].includes(rawCandidate.toLowerCase())')) {
    throw new Error("Missing shared PR-head candidate aliases");
  }
  const rawCandidate = body.match(candidateOverridePattern())?.[1];
  return rawCandidate && !["head", "pr", "pr-head"].includes(rawCandidate.toLowerCase())
    ? rawCandidate
    : pullRequestHead;
}

describe("Mantis Web UI chat proof workflow", () => {
  it("keeps candidate execution read-only and installs dependencies only in the candidate", () => {
    const job = workflowJob("run_web_ui_chat");
    const setup = job.steps?.find((step) => step.name === "Setup Node environment");

    expect(job.permissions).toEqual({ contents: "read" });
    expect(setup?.with).toMatchObject({
      "install-bun": "false",
      "install-deps": "false",
    });
  });

  it("publishes evidence with plain Node and no dependency setup", () => {
    const job = workflowJob("publish_evidence");
    const publish = job.steps?.find((step) => step.name === "Comment PR with inline QA evidence");

    expect(job.steps?.some((step) => step.name === "Setup Node environment")).toBe(false);
    expect(publish?.run).toContain("node scripts/mantis/publish-pr-evidence.mjs");
    expect(publish?.run).not.toContain("--import tsx");
  });

  it("only treats explicit candidate assignments as PR head overrides", () => {
    const pattern = candidateOverridePattern();

    expect(
      "verify this PR head produces a redacted Control UI chat transcript artifact".match(
        pattern,
      )?.[1],
    ).toBeUndefined();
    expect(
      "@openclaw-mantis web ui chat proof: verify candidate=e63393c publishes evidence".match(
        pattern,
      )?.[1],
    ).toBe("e63393c");
    expect(
      "@openclaw-mantis web ui chat proof: verify head: e63393c publishes evidence".match(
        pattern,
      )?.[1],
    ).toBe("e63393c");
    expect(
      "@openclaw-mantis web ui chat proof: verify candidate=`e63393c` publishes evidence".match(
        pattern,
      )?.[1],
    ).toBe("e63393c");

    const pullRequestHead = "f00ba4";
    expect(resolveCandidateRef("verify this PR head produces evidence", pullRequestHead)).toBe(
      pullRequestHead,
    );
    expect(resolveCandidateRef("candidate: head", pullRequestHead)).toBe(pullRequestHead);
    expect(resolveCandidateRef("candidate=pr", pullRequestHead)).toBe(pullRequestHead);
    expect(resolveCandidateRef("head: pr-head", pullRequestHead)).toBe(pullRequestHead);
  });
});
