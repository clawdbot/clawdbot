import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type ManualPolicy =
  | { mode: "absent" }
  | { mode: "isolated per-run" | "same-SHA cancels" | "same-ref queues"; group: string };

const WORKFLOWS: {
  file: string;
  prGroup: string;
  manual: ManualPolicy;
  push?: { group: string; cancel: boolean };
  convertToDraft?: true;
}[] = [
  {
    file: ".github/workflows/ci-check-testbox.yml",
    prGroup: "Blacksmith Testbox-pr-v1-123",
    manual: { mode: "isolated per-run", group: "Blacksmith Testbox-manual-v1-201" },
  },
  {
    file: ".github/workflows/ci-check-arm-testbox.yml",
    prGroup: "Blacksmith ARM Testbox-pr-v1-123",
    manual: { mode: "isolated per-run", group: "Blacksmith ARM Testbox-manual-v1-201" },
  },
  {
    file: ".github/workflows/ci-build-artifacts-testbox.yml",
    prGroup: "Blacksmith Build Artifacts Testbox-pr-v1-123",
    manual: { mode: "isolated per-run", group: "Blacksmith Build Artifacts Testbox-manual-v1-201" },
  },
  {
    file: ".github/workflows/ios-periphery.yml",
    prGroup: "ios-periphery-iOS Periphery Dead Code-123",
    convertToDraft: true,
    manual: {
      mode: "same-SHA cancels",
      group: `ios-periphery-iOS Periphery Dead Code-${"a".repeat(40)}`,
    },
  },
  {
    file: ".github/workflows/macos-periphery.yml",
    prGroup: "macos-periphery-macOS Periphery Dead Code-123",
    convertToDraft: true,
    manual: {
      mode: "same-SHA cancels",
      group: `macos-periphery-macOS Periphery Dead Code-${"a".repeat(40)}`,
    },
  },
  {
    file: ".github/workflows/shared-openclawkit-periphery.yml",
    prGroup: "shared-openclawkit-periphery-123",
    convertToDraft: true,
    manual: { mode: "same-SHA cancels", group: `shared-openclawkit-periphery-${"a".repeat(40)}` },
  },
  {
    file: ".github/workflows/opengrep-precise.yml",
    prGroup: "opengrep-pr-diff-OpenGrep — PR Diff-123",
    manual: { mode: "absent" },
  },
  {
    file: ".github/workflows/sandbox-common-smoke.yml",
    prGroup: "Sandbox Common Smoke-123",
    convertToDraft: true,
    manual: { mode: "absent" },
    push: { group: "Sandbox Common Smoke-refs/heads/main", cancel: true },
  },
  {
    file: ".github/workflows/plugin-init-scaffold-validation.yml",
    prGroup: "Plugin Init Scaffold Validation-123",
    manual: { mode: "same-ref queues", group: "Plugin Init Scaffold Validation-refs/heads/main" },
    push: { group: "Plugin Init Scaffold Validation-refs/heads/main", cancel: false },
  },
];

type Job = {
  if?: string | boolean;
  outputs?: Record<string, string>;
  steps: { id?: string; name?: string; if?: string; with?: { script?: string } }[];
};
type Workflow = {
  name: string;
  on: {
    pull_request: { types: string[] };
    workflow_dispatch?: unknown;
    push?: { branches: string[] };
  };
  concurrency: { group: string; "cancel-in-progress": string | boolean };
  jobs: Record<string, Job>;
};
type Github = {
  workflow: string;
  event_name: "pull_request" | "workflow_dispatch" | "push";
  run_id: number;
  sha: string;
  ref: string;
  event: {
    action?: string;
    pull_request?: { number: number; draft: boolean; head: { sha: string } };
  };
};

function pr(
  workflow: Workflow,
  runId: number,
  action: string,
  draft = false,
  head = "a",
  number = 123,
): Github {
  return {
    workflow: workflow.name,
    event_name: "pull_request",
    run_id: runId,
    sha: "e".repeat(40),
    ref: `refs/pull/${number}/merge`,
    event: { action, pull_request: { number, draft, head: { sha: head.repeat(40) } } },
  };
}

function refEvent(
  workflow: Workflow,
  eventName: "workflow_dispatch" | "push",
  runId: number,
  sha = "a",
  ref = "refs/heads/main",
): Github {
  return {
    workflow: workflow.name,
    event_name: eventName,
    run_id: runId,
    sha: sha.repeat(40),
    ref,
    event: {},
  };
}

function subscribes(workflow: Workflow, github: Github): boolean {
  if (github.event_name === "pull_request") {
    return workflow.on.pull_request.types.includes(github.event.action!);
  }
  if (github.event_name === "push") {
    return workflow.on.push?.branches.includes(github.ref.replace(/^refs\/heads\//u, "")) ?? false;
  }
  return Object.hasOwn(workflow.on, "workflow_dispatch");
}

// Like ci-workflow-guards, this uses VM evaluation, not a general Actions parser.
// Supported here: typed primitive ==/!=/!/&&/||, parentheses, property lookup,
// format's numbered placeholders, always(), and embedded interpolation. Missing
// properties are empty strings; hyphenated property names are single lookups.
// Expression fixtures avoid coercion/case-folding and escaped strings, where JS
// differs. Admission separately normalizes concurrency group names to lowercase.
function expression(source: string, context: Record<string, unknown>): unknown {
  return runInNewContext(
    source.replace(
      /\b(?:github|needs|steps)(?:\.[A-Za-z_][\w-]*)+/gu,
      (reference) => `lookup(${JSON.stringify(reference)})`,
    ),
    {
      lookup: (reference: string) =>
        reference
          .split(".")
          .reduce<unknown>(
            (value, key) =>
              value !== null && typeof value === "object"
                ? ((value as Record<string, unknown>)[key] ?? "")
                : "",
            context,
          ),
      format: (template: string, ...values: unknown[]) =>
        template.replace(/\{(\d+)\}/gu, (_match, index: string) => String(values[Number(index)])),
      always: () => true,
    },
  );
}

function evaluate(
  value: string | boolean,
  context: Record<string, unknown>,
  implicitIf = false,
): unknown {
  if (typeof value === "boolean") {
    return value;
  }
  const part = /\$\{\{([\s\S]*?)\}\}/u.exec(value);
  if (!part) {
    return implicitIf ? expression(value, context) : value;
  }
  const source = part[1];
  if (part[0] === value.trim() && source !== undefined) {
    return expression(source, context);
  }
  return value.replace(/\$\{\{([\s\S]*?)\}\}/gu, (_match, body: string) =>
    String(expression(body, context)),
  );
}

async function eligibleJobs(workflow: Workflow, github: Github) {
  const jobs: Record<string, boolean> = {};
  const needs: Record<string, { outputs: Record<string, unknown>; result: string }> = {};
  let diffCalls = 0;
  let checkouts = 0;
  const scope = workflow.jobs.scope;
  if (scope) {
    const context = { github, needs };
    jobs.scope = Boolean(evaluate(scope.if ?? true, context, true));
    const outputs: Record<string, string> = {};
    if (jobs.scope) {
      for (const step of scope.steps) {
        if (!evaluate(step.if ?? true, context, true)) {
          continue;
        }
        if (step.name === "Checkout") {
          checkouts++;
        }
        if (!step.with?.script) {
          continue;
        }
        await runInNewContext(`(async () => {\n${step.with.script}\n})()`, {
          context: { eventName: github.event_name, payload: github.event },
          core: {
            setOutput: (key: string, value: string) => {
              outputs[key] = value;
            },
          },
          exec: {
            getExecOutput: async (command: string, args: string[]) => {
              expect(command).toBe("git");
              expect(args.slice(0, 5)).toEqual(["diff", "--quiet", "HEAD^1", "HEAD", "--"]);
              diffCalls++;
              return { exitCode: 1 }; // A scoped change; path selection has its own suite.
            },
          },
        });
      }
    }
    needs.scope = {
      outputs: Object.fromEntries(
        Object.entries(scope.outputs ?? {}).map(([key, value]) => [
          key,
          evaluate(value, { steps: { scope: { outputs } } }),
        ]),
      ),
      result: jobs.scope ? "success" : "skipped",
    };
  }
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (id === "scope") {
      continue;
    }
    jobs[id] = Boolean(evaluate(job.if ?? true, { github, needs }, true));
    needs[id] = { outputs: {}, result: jobs[id] ? "success" : "skipped" };
  }
  return { jobs, diffCalls, checkouts };
}

type Run = {
  workflow: Workflow;
  github: Github;
  group: string;
  state: "pending" | "running" | "skipped" | "cancelled" | "completed";
  cancelRequested: boolean;
  eligibility?: Awaited<ReturnType<typeof eligibleJobs>>;
};

// Synthetic ordering witness: one running + one replaceable pending slot per
// group, admission BEFORE eligibility, cancellation held until explicit release.
// This models no webhook attribution, runner timing, fairness, or automatic retry.
class Admission {
  groups = new Map<string, { running?: Run; pending?: Run }>();

  async admit(workflow: Workflow, github: Github, control?: { group: string; cancel: false }) {
    expect(subscribes(workflow, github), `${workflow.name}: ${github.event_name}`).toBe(true);
    const group = control?.group ?? String(evaluate(workflow.concurrency.group, { github }));
    const cancel =
      control?.cancel ?? Boolean(evaluate(workflow.concurrency["cancel-in-progress"], { github }));
    const run: Run = { workflow, github, group, state: "pending", cancelRequested: false };
    const slots = this.groups.get(group.toLowerCase()) ?? {};
    this.groups.set(group.toLowerCase(), slots);
    if (slots.pending) {
      slots.pending.state = "cancelled";
    }
    if (slots.running) {
      if (cancel) {
        slots.running.cancelRequested = true;
      }
      slots.pending = run;
    } else {
      slots.running = run;
      await this.start(run);
    }
    return run;
  }

  private async start(run: Run) {
    run.eligibility = await eligibleJobs(run.workflow, run.github);
    const useful = Object.entries(run.eligibility.jobs).some(
      ([id, eligible]) => id !== "scope" && eligible,
    );
    run.state = useful ? "running" : "skipped";
    if (!useful) {
      this.groups.get(run.group.toLowerCase())!.running = undefined;
    }
  }

  async release(run: Run) {
    const slots = this.groups.get(run.group.toLowerCase())!;
    expect(slots.running).toBe(run);
    run.state = run.cancelRequested ? "cancelled" : "completed";
    slots.running = slots.pending;
    slots.pending = undefined;
    if (slots.running) {
      await this.start(slots.running);
    }
  }

  userCancel(run: Run) {
    const slots = this.groups.get(run.group.toLowerCase())!;
    if (slots.pending === run) {
      slots.pending = undefined;
      run.state = "cancelled";
    } else {
      expect(slots.running).toBe(run);
      run.cancelRequested = true;
    }
  }
}

function expectDraftSkipped(run: Run) {
  expect(run.state).toBe("skipped");
  expect(run.eligibility).toBeDefined();
  for (const [id, eligible] of Object.entries(run.eligibility!.jobs)) {
    expect(eligible, id).toBe(id === "scope");
  }
  expect(run.eligibility!.diffCalls).toBe(0);
  expect(run.eligibility!.checkouts).toBe(0);
}

const DELAYED = ["opened", "reopened", "synchronize"].flatMap((passive) =>
  ["ready_for_review", "synchronize"].map((useful) => ({
    passive,
    useful,
    head: useful === "synchronize" ? "b" : "a",
  })),
);

describe.each(WORKFLOWS)("ancillary admission: $file", (policy) => {
  const { file, prGroup, manual, push, convertToDraft } = policy;
  const workflow = parse(readFileSync(file, "utf8")) as Workflow;

  it.each(DELAYED)(
    "preserves running $useful after delayed draft $passive",
    async ({ passive, useful, head }) => {
      const queue = new Admission();
      const ready = await queue.admit(workflow, pr(workflow, 101, useful, false, head));
      const delayed = await queue.admit(workflow, pr(workflow, 102, passive, true));
      expect(ready.state).toBe("running");
      expect(ready.cancelRequested).toBe(false);
      expectDraftSkipped(delayed);
      expect(delayed.group).not.toBe(ready.group);
      expect(Object.values(ready.eligibility!.jobs).every(Boolean)).toBe(true);
    },
  );

  it.each(DELAYED)(
    "preserves pending $useful after delayed draft $passive",
    async ({ passive, useful, head }) => {
      const queue = new Admission();
      const older = await queue.admit(workflow, pr(workflow, 100, "synchronize"));
      const ready = await queue.admit(workflow, pr(workflow, 101, useful, false, head));
      expect(ready.state).toBe("pending");
      expect(ready.eligibility).toBeUndefined();
      expect(older.cancelRequested).toBe(true);
      const delayed = await queue.admit(workflow, pr(workflow, 102, passive, true));
      expect(ready.state).toBe("pending");
      expectDraftSkipped(delayed);
      await queue.release(older);
      expect(older.state).toBe("cancelled");
      expect(ready.state).toBe("running");
      expect(ready.cancelRequested).toBe(false);
    },
  );

  it("demonstrates old-group pending replacement even with active cancellation disabled", async () => {
    const queue = new Admission();
    const control = {
      group: String(
        evaluate(workflow.concurrency.group, { github: pr(workflow, 100, "synchronize") }),
      ),
      cancel: false,
    } as const;
    const running = await queue.admit(workflow, pr(workflow, 100, "synchronize"), control);
    const pending = await queue.admit(workflow, pr(workflow, 101, "ready_for_review"), control);
    const delayed = await queue.admit(workflow, pr(workflow, 102, "opened", true), control);
    expect(running.cancelRequested).toBe(false);
    expect(pending.state).toBe("cancelled");
    expect(delayed.state).toBe("pending");
    expect(delayed.eligibility).toBeUndefined();
    await queue.release(running);
    expectDraftSkipped(delayed);
  });

  it("keeps the exact useful PR group and supersedes old heads, including pending work", async () => {
    const queue = new Admission();
    const old = await queue.admit(workflow, pr(workflow, 100, "ready_for_review"));
    const pending = await queue.admit(workflow, pr(workflow, 101, "synchronize", false, "b"));
    const latest = await queue.admit(workflow, pr(workflow, 102, "synchronize", false, "c"));
    expect([old.group, pending.group, latest.group]).toEqual([prGroup, prGroup, prGroup]);
    expect(old.cancelRequested).toBe(true);
    expect(pending.state).toBe("cancelled");
    await queue.release(old);
    expect(latest.state).toBe("running");
  });

  it("isolates different PRs even at the same SHA", async () => {
    const queue = new Admission();
    const firstPr = await queue.admit(workflow, pr(workflow, 100, "ready_for_review"));
    const otherPr = await queue.admit(workflow, pr(workflow, 101, "opened", false, "a", 124));
    expect(firstPr.group).not.toBe(otherPr.group);
    expect([firstPr.state, otherPr.state]).toEqual(["running", "running"]);
    expect(firstPr.cancelRequested).toBe(false);
    expect(otherPr.cancelRequested).toBe(false);
  });

  it(`retains the manual contract: ${manual.mode}`, async () => {
    expect(Object.hasOwn(workflow.on, "workflow_dispatch")).toBe(manual.mode !== "absent");
    if (manual.mode === "absent") {
      return;
    }
    const queue = new Admission();
    const ready = await queue.admit(workflow, pr(workflow, 100, "ready_for_review"));
    const first = await queue.admit(workflow, refEvent(workflow, "workflow_dispatch", 201));
    const sameSha = await queue.admit(workflow, refEvent(workflow, "workflow_dispatch", 202));
    const otherSha = await queue.admit(workflow, refEvent(workflow, "workflow_dispatch", 203, "b"));
    expect(first.group).toBe(manual.group);
    expect(ready.group).not.toBe(first.group);
    expect(ready.cancelRequested).toBe(false);
    const cancels = manual.mode === "same-SHA cancels";
    for (const run of [first, sameSha, otherSha]) {
      expect(evaluate(workflow.concurrency["cancel-in-progress"], { github: run.github })).toBe(
        cancels,
      );
    }
    expect(first.cancelRequested).toBe(cancels);
    if (manual.mode === "same-ref queues") {
      expect([sameSha.group, otherSha.group]).toEqual([manual.group, manual.group]);
      expect([sameSha.state, otherSha.state]).toEqual(["cancelled", "pending"]);
      const otherRef = await queue.admit(
        workflow,
        refEvent(workflow, "workflow_dispatch", 204, "a", "refs/heads/release"),
      );
      expect(otherRef.group).toBe("Plugin Init Scaffold Validation-refs/heads/release");
      expect(otherRef.state).toBe("running");
    } else {
      expect(sameSha.group === first.group).toBe(cancels);
      expect(new Set([ready.group, first.group, otherSha.group]).size).toBe(3);
      expect(sameSha.state).toBe(cancels ? "pending" : "running");
      expect(otherSha.state).toBe("running");
    }
    await queue.release(first);
    expect(first.state).toBe(cancels ? "cancelled" : "completed");
    expect(sameSha.state).toBe(manual.mode === "same-ref queues" ? "cancelled" : "running");
    expect(otherSha.state).toBe("running");
  });

  if (push) {
    const sequences: ["push" | "workflow_dispatch", "push" | "workflow_dispatch"][] = [
      ["push", "push"],
    ];
    if (manual.mode === "same-ref queues") {
      sequences.push(["push", "workflow_dispatch"], ["workflow_dispatch", "push"]);
    }
    it.each(sequences)(
      "retains ref-group policy for %s → %s → newer first event, isolated from PRs",
      async (firstEvent, otherEvent) => {
        const queue = new Admission();
        const ready = await queue.admit(workflow, pr(workflow, 100, "ready_for_review"));
        const active = await queue.admit(workflow, refEvent(workflow, firstEvent, 201));
        const pending = await queue.admit(workflow, refEvent(workflow, otherEvent, 202, "b"));
        const latest = await queue.admit(workflow, refEvent(workflow, firstEvent, 203, "c"));
        expect([active.group, pending.group, latest.group]).toEqual([
          push.group,
          push.group,
          push.group,
        ]);
        expect(ready.group).not.toBe(active.group);
        expect(ready.cancelRequested).toBe(false);
        expect(active.cancelRequested).toBe(push.cancel);
        expect(pending.state).toBe("cancelled");
        expect(latest.state).toBe("pending");
        await queue.release(active);
        expect(active.state).toBe(push.cancel ? "cancelled" : "completed");
        expect(latest.state).toBe("running");
      },
    );
  }

  it("keeps passive runs unique and never resurrects user-cancelled work", async () => {
    const queue = new Admission();
    const active = await queue.admit(workflow, pr(workflow, 100, "ready_for_review"));
    const pending = await queue.admit(workflow, pr(workflow, 101, "synchronize", false, "b"));
    queue.userCancel(pending);
    queue.userCancel(active);
    await queue.release(active);
    const draft1 = await queue.admit(workflow, pr(workflow, 102, "opened", true));
    const draft2 = await queue.admit(workflow, pr(workflow, 103, "opened", true));
    expect(draft1.group).not.toBe(draft2.group);
    expectDraftSkipped(draft1);
    expectDraftSkipped(draft2);
    expect([active.state, pending.state]).toEqual(["cancelled", "cancelled"]);
    expect([...queue.groups.values()].every((slot) => !slot.running && !slot.pending)).toBe(true);
  });

  if (convertToDraft) {
    it("retains converted_to_draft cancellation before skipping scans", async () => {
      const queue = new Admission();
      const active = await queue.admit(workflow, pr(workflow, 100, "ready_for_review"));
      const pending = await queue.admit(workflow, pr(workflow, 101, "synchronize", false, "b"));
      const converted = await queue.admit(workflow, pr(workflow, 102, "converted_to_draft", true));
      expect(converted.group).toBe(prGroup);
      expect(active.cancelRequested).toBe(true);
      expect(pending.state).toBe("cancelled");
      await queue.release(active);
      expectDraftSkipped(converted);
    });
  }
});

it("isolates supported useful, passive, manual and push events across all nine workflows", () => {
  for (const event of ["ready_for_review", "opened", "workflow_dispatch", "push"] as const) {
    const groups = WORKFLOWS.flatMap(({ file }) => {
      const workflow = parse(readFileSync(file, "utf8")) as Workflow;
      const github =
        event === "workflow_dispatch" || event === "push"
          ? refEvent(workflow, event, 201)
          : pr(workflow, 101, event, event === "opened");
      return subscribes(workflow, github)
        ? [String(evaluate(workflow.concurrency.group, { github })).toLowerCase()]
        : [];
    });
    expect(new Set(groups).size).toBe(groups.length);
  }
});
