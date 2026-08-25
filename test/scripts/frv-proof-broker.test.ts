import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  runProofBroker,
  validateBrokerRequest,
  validateFixtureRun,
  type GitHubApi,
} from "../../scripts/frv-proof-broker.mjs";

const workflowSha = "a".repeat(40);
const headSha = "b".repeat(40);
const repository = "openclaw/openclaw";

type BrokerWorkflow = {
  concurrency: { "cancel-in-progress": boolean; group: string };
  jobs: {
    prove: {
      permissions: Record<string, string>;
      steps: Array<{ name?: string; with?: Record<string, unknown> }>;
    };
  };
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
};

type FixtureWorkflow = {
  jobs: { fixture: { permissions: Record<string, string> } };
  on: {
    workflow_dispatch: {
      inputs: { operation: { default: string; options: string[]; type: string } };
    };
  };
  permissions: Record<string, string>;
};

function brokerEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTOR: "maintainer",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: repository,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "12345",
    GITHUB_SHA: workflowSha,
    GITHUB_TRIGGERING_ACTOR: "maintainer",
    GITHUB_WORKFLOW_REF: "openclaw/openclaw/.github/workflows/frv-proof-broker.yml@refs/heads/main",
    GITHUB_WORKFLOW_SHA: workflowSha,
    ...overrides,
  };
}

function brokerEvent(overrides: Record<string, unknown> = {}) {
  return {
    inputs: {
      head_sha: headSha,
      pr_number: "128141",
      ...overrides,
    },
  };
}

function fixtureRun(overrides: Record<string, unknown> = {}) {
  return {
    conclusion: "failure",
    display_title: "FRV Proof Fixture [noop] frv-proof-12345-1",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: workflowSha,
    id: 777,
    path: ".github/workflows/frv-proof-fixture.yml",
    repository: { full_name: repository },
    run_attempt: 1,
    status: "completed",
    ...overrides,
  };
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    base: { ref: "main", repo: { full_name: repository } },
    head: { sha: headSha, repo: { full_name: repository } },
    number: 128141,
    state: "open",
    ...overrides,
  };
}

function successfulApi(
  options: {
    initialRun?: Record<string, unknown>;
    mainShas?: string[];
    permissions?: string[];
    pulls?: Array<Record<string, unknown>>;
    rerun?: Record<string, unknown>;
    rerunError?: Error;
  } = {},
) {
  const calls: Array<{ body?: unknown; method: string; path: string }> = [];
  let permissionRead = 0;
  let pullRead = 0;
  let mainRead = 0;
  const initialRun = options.initialRun ?? fixtureRun();
  const rerun =
    options.rerun ??
    fixtureRun({
      conclusion: "success",
      run_attempt: 2,
    });
  const api: GitHubApi = {
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ body, method, path });
      if (method === "GET" && path === "/collaborators/maintainer/permission") {
        const permission = options.permissions?.[permissionRead] ?? "maintain";
        permissionRead += 1;
        return { permission };
      }
      if (method === "GET" && path === "/pulls/128141") {
        const pull = options.pulls?.[pullRead] ?? pullRequest();
        pullRead += 1;
        return pull;
      }
      if (method === "GET" && path === "/actions/workflows/frv-proof-fixture.yml") {
        return {
          id: 99,
          name: "FRV Proof Fixture",
          path: ".github/workflows/frv-proof-fixture.yml",
          state: "active",
        };
      }
      if (method === "GET" && path === "/git/ref/heads/main") {
        const sha = options.mainShas?.[mainRead] ?? workflowSha;
        mainRead += 1;
        return { object: { sha }, ref: "refs/heads/main" };
      }
      if (method === "POST" && path === "/actions/workflows/frv-proof-fixture.yml/dispatches") {
        return null;
      }
      if (method === "GET" && path.startsWith("/actions/workflows/frv-proof-fixture.yml/runs?")) {
        return { workflow_runs: [initialRun] };
      }
      if (method === "POST" && path === "/actions/runs/777/rerun-failed-jobs") {
        if (options.rerunError) {
          throw options.rerunError;
        }
        return null;
      }
      if (method === "GET" && path === "/actions/runs/777") {
        return rerun;
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    }),
  };
  return { api, calls };
}

describe("FRV proof broker request validation", () => {
  it("accepts only the exact two operator inputs", () => {
    const parsed = validateBrokerRequest(brokerEvent(), brokerEnv());
    expect(parsed).toMatchObject({
      correlation: "frv-proof-12345-1",
      headSha,
      prNumber: 128141,
      workflowSha,
    });
    expect(() =>
      validateBrokerRequest(brokerEvent({ correlation: "operator-value" }), brokerEnv()),
    ).toThrow(/keys must be exactly/u);
  });

  it.each([
    ["repository", brokerEnv({ GITHUB_REPOSITORY: "attacker/fork" })],
    ["workflow", brokerEnv({ GITHUB_WORKFLOW_REF: "openclaw/openclaw/other.yml@main" })],
    ["ref", brokerEnv({ GITHUB_REF: "refs/pull/128141/merge" })],
    ["workflow SHA", brokerEnv({ GITHUB_WORKFLOW_SHA: "c".repeat(40) })],
    ["actor", brokerEnv({ GITHUB_TRIGGERING_ACTOR: "different-user" })],
  ])("rejects the wrong %s before API access", (_label, env) => {
    expect(() => validateBrokerRequest(brokerEvent(), env)).toThrow();
  });

  it("rejects malformed PR and SHA inputs", () => {
    expect(() => validateBrokerRequest(brokerEvent({ pr_number: "0" }), brokerEnv())).toThrow();
    expect(() => validateBrokerRequest(brokerEvent({ head_sha: "ABC" }), brokerEnv())).toThrow();
    expect(() =>
      validateBrokerRequest(brokerEvent(), brokerEnv({ GITHUB_RUN_ATTEMPT: "0" })),
    ).toThrow(/GITHUB_RUN_ATTEMPT/u);
  });
});

describe("FRV proof fixture identity", () => {
  const expected = {
    attempt: 1,
    branch: "main",
    conclusion: "failure" as const,
    correlation: "frv-proof-12345-1",
    headSha: workflowSha,
    repository,
    runId: 777,
  };

  it("accepts the exact failed first attempt", () => {
    expect(validateFixtureRun(fixtureRun(), expected).id).toBe(777);
  });

  it.each([
    ["repository", { repository: { full_name: "attacker/fork" } }],
    ["SHA", { head_sha: headSha }],
    ["workflow", { path: ".github/workflows/full-release-validation.yml" }],
    ["run", { id: 778 }],
    ["attempt", { run_attempt: 2 }],
    ["operation", { display_title: "FRV Proof Fixture [publish] frv-proof-12345-1" }],
  ])("rejects the wrong %s identity", (_label, overrides) => {
    expect(() => validateFixtureRun(fixtureRun(overrides), expected)).toThrow();
  });
});

describe("FRV proof broker mutation boundary", () => {
  it("validates every read-only prerequisite before the first mutation", async () => {
    const { api, calls } = successfulApi();
    await runProofBroker({
      api,
      env: brokerEnv(),
      event: brokerEvent(),
      sleep: async () => {},
    });
    const firstMutation = calls.findIndex((call) => call.method !== "GET");
    expect(calls.slice(0, firstMutation).map((call) => call.path)).toEqual([
      "/actions/workflows/frv-proof-fixture.yml",
      "/collaborators/maintainer/permission",
      "/pulls/128141",
      "/git/ref/heads/main",
    ]);
  });

  it("uses only the fixed ref, fixture, operation, and exact failed run", async () => {
    const { api, calls } = successfulApi();
    const receipt = await runProofBroker({
      api,
      env: brokerEnv(),
      event: brokerEvent(),
      sleep: async () => {},
    });
    expect(receipt).toMatchObject({
      fixtureRunAttempt: 2,
      fixtureRunId: 777,
      operation: "noop",
      sourceRef: "refs/heads/main",
    });
    expect(calls.filter((call) => call.method !== "GET")).toEqual([
      {
        body: {
          inputs: { correlation: "frv-proof-12345-1", operation: "noop" },
          ref: "main",
        },
        method: "POST",
        path: "/actions/workflows/frv-proof-fixture.yml/dispatches",
      },
      {
        body: undefined,
        method: "POST",
        path: "/actions/runs/777/rerun-failed-jobs",
      },
    ]);
  });

  it("rejects a mismatched PR head before any mutation", async () => {
    const { api, calls } = successfulApi({
      pulls: [
        pullRequest({
          head: { sha: "c".repeat(40), repo: { full_name: repository } },
        }),
      ],
    });
    await expect(
      runProofBroker({
        api,
        env: brokerEnv(),
        event: brokerEvent(),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/head SHA/u);
    expect(calls.some((call) => call.method !== "GET")).toBe(false);
  });

  it("rejects a moved main immediately before dispatch", async () => {
    const { api, calls } = successfulApi({ mainShas: ["c".repeat(40)] });
    await expect(
      runProofBroker({
        api,
        env: brokerEnv(),
        event: brokerEvent(),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/trusted main moved/u);
    expect(calls.some((call) => call.method !== "GET")).toBe(false);
  });

  it("does not adopt a fixture from a prior broker attempt", async () => {
    const { api, calls } = successfulApi();
    await expect(
      runProofBroker({
        api,
        env: brokerEnv({ GITHUB_RUN_ATTEMPT: "2" }),
        event: brokerEvent(),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/timed out waiting/u);
    expect(calls.filter((call) => call.method !== "GET")).toEqual([
      {
        body: {
          inputs: { correlation: "frv-proof-12345-2", operation: "noop" },
          ref: "main",
        },
        method: "POST",
        path: "/actions/workflows/frv-proof-fixture.yml/dispatches",
      },
    ]);
  });

  it("rejects revoked actor authority before rerunning", async () => {
    const { api, calls } = successfulApi({ permissions: ["maintain", "read"] });
    await expect(
      runProofBroker({
        api,
        env: brokerEnv(),
        event: brokerEvent(),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/lacks repository write permission/u);
    expect(calls.filter((call) => call.method !== "GET")).toEqual([
      {
        body: {
          inputs: { correlation: "frv-proof-12345-1", operation: "noop" },
          ref: "main",
        },
        method: "POST",
        path: "/actions/workflows/frv-proof-fixture.yml/dispatches",
      },
    ]);
  });

  it("rejects a replaced PR head before rerunning", async () => {
    const { api, calls } = successfulApi({
      pulls: [
        pullRequest(),
        pullRequest({
          head: { sha: "c".repeat(40), repo: { full_name: repository } },
        }),
      ],
    });
    await expect(
      runProofBroker({
        api,
        env: brokerEnv(),
        event: brokerEvent(),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/head SHA/u);
    expect(calls.some((call) => call.path.endsWith("/rerun-failed-jobs"))).toBe(false);
  });

  it("does not mutate refs after a rerun failure", async () => {
    const { api, calls } = successfulApi({ rerunError: new Error("rerun rejected") });
    await expect(
      runProofBroker({
        api,
        env: brokerEnv(),
        event: brokerEvent(),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/rerun rejected/u);
    expect(calls.some((call) => call.path.startsWith("/git/refs"))).toBe(false);
  });

  it("does not rerun a fixture with the wrong workflow identity", async () => {
    const { api, calls } = successfulApi({
      initialRun: fixtureRun({ path: ".github/workflows/other.yml" }),
    });
    await expect(
      runProofBroker({
        api,
        env: brokerEnv(),
        event: brokerEvent(),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/workflow does not match/u);
    expect(calls.some((call) => call.path.endsWith("/rerun-failed-jobs"))).toBe(false);
  });

  it("rejects a main replacement race without creating or deleting refs", async () => {
    const { api, calls } = successfulApi({
      initialRun: fixtureRun({
        head_sha: "c".repeat(40),
      }),
    });
    await expect(
      runProofBroker({
        api,
        env: brokerEnv(),
        event: brokerEvent(),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/trusted main workflow SHA/u);
    expect(calls.some((call) => call.path.startsWith("/git/refs"))).toBe(false);
    expect(calls.some((call) => call.path.endsWith("/rerun-failed-jobs"))).toBe(false);
  });
});

describe("FRV proof workflows", () => {
  const brokerSource = readFileSync(".github/workflows/frv-proof-broker.yml", "utf8");
  const fixtureSource = readFileSync(".github/workflows/frv-proof-fixture.yml", "utf8");
  const broker = parseYaml(brokerSource) as BrokerWorkflow;
  const fixture = parseYaml(fixtureSource) as FixtureWorkflow;

  it("exposes only PR number and exact head as broker inputs", () => {
    expect(Object.keys(broker.on.workflow_dispatch.inputs).toSorted()).toEqual([
      "head_sha",
      "pr_number",
    ]);
    expect(broker.concurrency).toEqual({
      "cancel-in-progress": false,
      group: "frv-proof-broker",
    });
  });

  it("never checks out PR code with the write-capable broker token", () => {
    const job = broker.jobs.prove;
    expect(job.permissions).toEqual({
      actions: "write",
      contents: "read",
      "pull-requests": "read",
    });
    const checkout = job.steps.find((step) => step.name === "Checkout trusted main broker");
    expect(checkout).toBeDefined();
    expect(checkout?.with).toEqual({
      "fetch-depth": 1,
      "persist-credentials": false,
      ref: "${{ github.workflow_sha }}",
    });
    expect(brokerSource).not.toContain("inputs.head_sha }}");
    expect(brokerSource).not.toContain("pull/");
    expect(brokerSource).not.toContain("contents: write");
  });

  it("keeps the fixture tokenless and fixes its behavior to noop", () => {
    expect(fixture.permissions).toEqual({});
    expect(fixture.jobs.fixture.permissions).toEqual({});
    expect(fixture.on.workflow_dispatch.inputs.operation).toMatchObject({
      default: "noop",
      options: ["noop"],
      type: "choice",
    });
    expect(fixtureSource).not.toContain("actions/checkout");
  });
});
