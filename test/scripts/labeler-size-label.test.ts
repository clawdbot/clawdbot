import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/labeler.yml", "utf8")) as {
  jobs: { label: { steps: Array<{ name?: string; with?: { script?: string } }> } };
};
const script = workflow.jobs.label.steps.find((step) => step.name === "Apply PR size label")?.with
  ?.script;
if (!script) {
  throw new Error("missing PR size label script");
}
const executeSizeLabel = compileFunction(`return (async () => {\n${script}\n})();`, [
  "context",
  "core",
  "github",
]) as (context: unknown, core: unknown, github: unknown) => Promise<void>;

function sizeLabelFixture(labelNames: string[], addError?: Error) {
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
      for (const name of added) {
        labels.add(name);
      }
    }),
  };
  const github = {
    rest: { issues, pulls: { listFiles: vi.fn() } },
    paginate: async (endpoint: unknown) =>
      endpoint === issues.listLabelsOnIssue
        ? [...labels].map((name) => ({ name }))
        : [{ filename: "src/example.ts", additions: 60, deletions: 0 }],
  };
  const run = () =>
    executeSizeLabel(
      { repo: { owner: "openclaw", repo: "openclaw" }, payload: { pull_request: { number: 1 } } },
      core,
      github,
    );
  return { run, labels, issues, core };
}

const areaLabels = (count: number) => Array.from({ length: count }, (_, index) => `area: ${index}`);

describe("PR size labeling", () => {
  it("warns and succeeds without adding a label when all 100 slots are occupied", async () => {
    const fixture = sizeLabelFixture(areaLabels(100));
    await fixture.run();
    expect(fixture.issues.addLabels).not.toHaveBeenCalled();
    expect(fixture.labels.size).toBe(100);
    expect(fixture.core.warning).toHaveBeenCalledWith(expect.stringMatching(/size: S.*100/));
  });

  it("warns and succeeds when a concurrent label fills the last slot", async () => {
    const error = Object.assign(
      new Error("Validation Failed: Issues cannot have more than 100 labels"),
      { status: 422 },
    );
    const fixture = sizeLabelFixture(areaLabels(99), error);
    await fixture.run();
    expect(fixture.issues.addLabels).toHaveBeenCalledOnce();
    expect(fixture.core.warning).toHaveBeenCalledWith(expect.stringContaining(error.message));
  });

  it.each([
    { status: 422, message: "Validation Failed: label does not exist" },
    { status: 403, message: "Resource not accessible by integration" },
  ])("propagates unrelated GitHub errors: $status $message", async ({ status, message }) => {
    const error = Object.assign(new Error(message), { status });
    const fixture = sizeLabelFixture([], error);
    await expect(fixture.run()).rejects.toBe(error);
    expect(fixture.core.warning).not.toHaveBeenCalled();
  });

  it.each([undefined, "size: XS", "size: S"])(
    "uses available capacity after removing a stale size label (%s)",
    async (sizeLabel) => {
      const fixture = sizeLabelFixture([...areaLabels(99), ...(sizeLabel ? [sizeLabel] : [])]);
      await fixture.run();
      expect(fixture.labels).toEqual(new Set([...areaLabels(99), "size: S"]));
      expect(fixture.core.warning).not.toHaveBeenCalled();
    },
  );
});
