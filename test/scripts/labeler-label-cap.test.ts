import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { compileFunction, constants } from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { addLabelsWithinCap } from "../../scripts/github/labeler-label-cap.mjs";

type WorkflowJob = { steps: Array<{ name?: string; with?: { script?: string } }> };

const workflow = parse(readFileSync(".github/workflows/labeler.yml", "utf8")) as {
  jobs: Record<string, WorkflowJob> & { label: WorkflowJob };
};
const require = createRequire(import.meta.url);
let previousWorkspace: string | undefined;
beforeAll(() => {
  previousWorkspace = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = process.cwd();
});
afterAll(() => {
  if (previousWorkspace === undefined) {
    delete process.env.GITHUB_WORKSPACE;
  } else {
    process.env.GITHUB_WORKSPACE = previousWorkspace;
  }
});

function compileStep(name: string) {
  const script = workflow.jobs.label.steps.find((step) => step.name === name)?.with?.script;
  if (!script) {
    throw new Error(`missing workflow script: ${name}`);
  }
  return compileFunction(
    `return (async () => {\n${script}\n})();`,
    ["context", "core", "github", "require"],
    { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
  ) as (context: unknown, core: unknown, github: unknown, require: NodeJS.Require) => Promise<void>;
}
const executeSizeLabel = compileStep("Apply PR size label");
const executeMaintainerLabel = compileStep("Apply maintainer or trusted-contributor label");

function labelFixture(labelNames: string[], addError?: Error, execute = executeSizeLabel) {
  const labels = new Set(labelNames);
  const core = { warning: vi.fn() };
  const issues = {
    getLabel: vi.fn(),
    listLabelsOnIssue: vi.fn(),
    removeLabel: vi.fn(async ({ name }: { name: string }) => {
      labels.delete(name);
    }),
    addLabels: vi.fn(async ({ labels: added }: { labels: string[] }) => {
      if (addError) {
        throw addError;
      }
      if (new Set([...labels, ...added]).size > 100) {
        throw Object.assign(
          new Error("Validation Failed: Issues cannot have more than 100 labels"),
          { status: 422 },
        );
      }
      for (const name of added) {
        labels.add(name);
      }
    }),
  };
  const teams = {
    getMembershipForUserInOrg: vi.fn().mockResolvedValue({ data: { state: "active" } }),
  };
  const github = {
    rest: { issues, teams, pulls: { listFiles: vi.fn() } },
    paginate: async (endpoint: unknown) =>
      endpoint === issues.listLabelsOnIssue
        ? [...labels].map((name) => ({ name }))
        : [{ filename: "src/example.ts", additions: 60, deletions: 0 }],
  };
  const run = () =>
    execute(
      {
        repo: { owner: "openclaw", repo: "openclaw" },
        payload: { pull_request: { number: 1, user: { login: "contributor" } } },
      },
      core,
      github,
      require,
    );
  return { run, labels, issues, teams, core };
}

const areaLabels = (count: number) => Array.from({ length: count }, (_, index) => `area: ${index}`);

describe("PR size labeling", () => {
  it("warns and succeeds without adding a label when all 100 slots are occupied", async () => {
    const fixture = labelFixture(areaLabels(100));
    await expect(fixture.run()).resolves.toBeUndefined();
    expect(fixture.issues.addLabels).toHaveBeenCalledOnce();
    expect(fixture.labels.size).toBe(100);
    expect(fixture.core.warning).toHaveBeenCalledWith(expect.stringMatching(/size: S.*100/));
  });

  it.each([undefined, "size: XS", "size: S"])(
    "uses available capacity after removing a stale size label (%s)",
    async (sizeLabel) => {
      const fixture = labelFixture([...areaLabels(99), ...(sizeLabel ? [sizeLabel] : [])]);
      await fixture.run();
      expect(fixture.labels).toEqual(new Set([...areaLabels(99), "size: S"]));
      expect(fixture.core.warning).not.toHaveBeenCalled();
    },
  );
});

describe("PR maintainer labeling", () => {
  it("warns and succeeds when all 100 slots are occupied", async () => {
    const fixture = labelFixture(areaLabels(100), undefined, executeMaintainerLabel);
    await expect(fixture.run()).resolves.toBeUndefined();
    expect(fixture.issues.addLabels).toHaveBeenCalledOnce();
    expect(fixture.labels).toEqual(new Set(areaLabels(100)));
    expect(fixture.core.warning).toHaveBeenCalledWith(
      expect.stringMatching(/maintainer.*on #1.*100/),
    );
  });

  it("adds the maintainer label when one slot remains", async () => {
    const fixture = labelFixture(areaLabels(99), undefined, executeMaintainerLabel);
    await fixture.run();
    expect(fixture.labels).toEqual(new Set([...areaLabels(99), "maintainer"]));
    expect(fixture.core.warning).not.toHaveBeenCalled();
  });

  it("does not label a non-member", async () => {
    const fixture = labelFixture([], undefined, executeMaintainerLabel);
    fixture.teams.getMembershipForUserInOrg.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    await fixture.run();
    expect(fixture.issues.addLabels).not.toHaveBeenCalled();
    expect(fixture.core.warning).not.toHaveBeenCalled();
  });
});

describe("label cap tolerance", () => {
  it.each(
    [
      { step: "size", execute: executeSizeLabel },
      { step: "maintainer", execute: executeMaintainerLabel },
    ].flatMap(({ step, execute }) =>
      [
        { status: 422, message: "Validation Failed: label does not exist" },
        { status: 403, message: "Resource not accessible by integration" },
      ].map(({ status, message }) => ({ step, execute, status, message })),
    ),
  )(
    "propagates unrelated GitHub errors: $step $status $message",
    async ({ execute, status, message }) => {
      const error = Object.assign(new Error(message), { status });
      const fixture = labelFixture([], error, execute);
      await expect(fixture.run()).rejects.toBe(error);
      expect(fixture.core.warning).not.toHaveBeenCalled();
    },
  );

  it("reports whether the label landed so callers keep their bookkeeping accurate", async () => {
    const capError = Object.assign(
      new Error("Validation Failed: Issues cannot have more than 100 labels"),
      { status: 422 },
    );
    const core = { warning: vi.fn() };
    const addLabels = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(capError);
    const github = { rest: { issues: { addLabels } } };
    const request = { github, core, owner: "openclaw", repo: "openclaw", issueNumber: 7 };

    await expect(addLabelsWithinCap({ ...request, labels: ["maintainer"] })).resolves.toBe(true);
    expect(core.warning).not.toHaveBeenCalled();
    await expect(addLabelsWithinCap({ ...request, labels: ["beta-blocker"] })).resolves.toBe(false);
    expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/"beta-blocker" on #7/));
  });

  it("every label-adding site routes through addLabelsWithinCap", () => {
    // The helper owns the 100-label cap; a new raw call would restore the red check from PR #137506.
    const scriptLines = Object.values(workflow.jobs)
      .flatMap((job) => job.steps)
      .flatMap((step) => (step.with?.script ?? "").split("\n"))
      .filter((line) => !line.trim().startsWith("//"));
    expect(scriptLines.filter((line) => line.includes("issues.addLabels("))).toEqual([]);
  });
});
