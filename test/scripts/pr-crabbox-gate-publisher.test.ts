import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  buildCrabboxGateCommand,
  createJsonApi,
  runPublisher,
  validateBrokerProof,
  validatePublisherRequest,
} from "../../scripts/pr-crabbox-gate-publisher.mjs";

const repository = "openclaw/openclaw";
const workflowSha = "a".repeat(40);
const headSha = "b".repeat(40);
const bootstrapSha256 = createHash("sha256")
  .update(readFileSync("scripts/crabbox-untrusted-bootstrap.sh"))
  .digest("hex");
const runId = "run_abc123";
const leaseId = "cbx_def456";

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTOR: "maintainer",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: repository,
    GITHUB_RUN_ID: "1234",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_SHA: workflowSha,
    GITHUB_TRIGGERING_ACTOR: "maintainer",
    GITHUB_WORKFLOW_REF:
      "openclaw/openclaw/.github/workflows/pr-crabbox-gate-publisher.yml@refs/heads/main",
    GITHUB_WORKFLOW_SHA: workflowSha,
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    inputs: {
      bootstrap_sha256: bootstrapSha256,
      crabbox_lease_id: leaseId,
      crabbox_run_id: runId,
      head_sha: headSha,
      pr_number: "130481",
      ...overrides,
    },
  };
}

function context() {
  return validatePublisherRequest(event(), env());
}

function command() {
  return [
    "--script",
    ".local/crabbox-untrusted-bootstrap.sh",
    headSha,
    "/bin/bash",
    "-lc",
    buildCrabboxGateCommand(headSha, bootstrapSha256),
  ];
}

function retainedLog() {
  return [
    "OPENCLAW_CRABBOX_GATE_VERSION=1",
    "OPENCLAW_CRABBOX_GATE_MODE=remote_crabbox_aws",
    `OPENCLAW_CRABBOX_GATE_HEAD=${headSha}`,
    `OPENCLAW_CRABBOX_BOOTSTRAP_SHA256=${bootstrapSha256}`,
    "OPENCLAW_CRABBOX_GATE_STAGE=build:ok",
    "OPENCLAW_CRABBOX_GATE_STAGE=check:ok",
    "OPENCLAW_CRABBOX_GATE_STAGE=check_changed:ok",
    "OPENCLAW_CRABBOX_GATE_RESULT=success",
  ].join("\n");
}

function brokerRun(overrides: Record<string, unknown> = {}) {
  return {
    command: command(),
    endedAt: "2026-08-27T01:30:00Z",
    eventCount: 6,
    exitCode: 0,
    id: runId,
    label: `openclaw-pr-gate:130481:${headSha}`,
    leaseID: leaseId,
    logTruncated: false,
    org: "openclaw",
    owner: "github:42",
    phase: "released",
    provider: "aws",
    startedAt: "2026-08-27T01:00:00Z",
    state: "succeeded",
    target: "linux",
    ...overrides,
  };
}

function brokerEvents(overrides: Record<number, Record<string, unknown>> = {}) {
  const values = [
    { type: "run.started" },
    { leaseID: leaseId, provider: "aws", target: "linux", type: "lease.created" },
    {
      message: `.crabbox/scripts/${bootstrapSha256.slice(0, 12)}-crabbox-untrusted-bootstrap.sh`,
      type: "script.uploaded",
    },
    { type: "command.started" },
    { exitCode: 0, type: "command.finished" },
    { type: "lease.released" },
  ];
  return values.map((value, index) => ({
    ...value,
    ...overrides[index],
    runID: runId,
    seq: index + 1,
  }));
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    base: { ref: "main", repo: { full_name: repository } },
    draft: false,
    head: { repo: { full_name: repository }, sha: headSha },
    number: 130481,
    state: "open",
    ...overrides,
  };
}

describe("Crabbox gate request validation", () => {
  it("accepts only the exact protected-main inputs", () => {
    expect(context()).toMatchObject({
      bootstrapSha256,
      headSha,
      leaseId,
      prNumber: 130481,
      runId,
    });
    expect(() => validatePublisherRequest(event({ extra: "no" }), env())).toThrow(
      /keys must be exactly/u,
    );
  });

  it.each([
    ["fork repository", env({ GITHUB_REPOSITORY: "attacker/fork" })],
    ["pull request ref", env({ GITHUB_REF: "refs/pull/130481/merge" })],
    ["moved workflow", env({ GITHUB_SHA: "c".repeat(40) })],
    ["different actor", env({ GITHUB_TRIGGERING_ACTOR: "other" })],
  ])("rejects %s", (_label, inputEnv) => {
    expect(() => validatePublisherRequest(event(), inputEnv)).toThrow();
  });
});

describe("Crabbox immutable broker proof", () => {
  it("accepts exact AWS/Linux released proof and retained markers", () => {
    expect(() =>
      validateBrokerProof({
        bootstrapSha256,
        context: context(),
        events: brokerEvents(),
        log: retainedLog(),
        now: Date.parse("2026-08-27T02:00:00Z"),
        run: brokerRun(),
        userId: 42,
      }),
    ).not.toThrow();
  });

  it.each([
    ["provider", { provider: "blacksmith-testbox" }, brokerEvents(), retainedLog()],
    ["owner", { owner: "github:7" }, brokerEvents(), retainedLog()],
    ["truncation", { logTruncated: true }, brokerEvents(), retainedLog()],
    ["malformed command", { command: ["pnpm", "test"] }, brokerEvents(), retainedLog()],
    [
      "bootstrap upload",
      {},
      brokerEvents({ 2: { message: ".crabbox/scripts/attacker-bootstrap.sh" } }),
      retainedLog(),
    ],
    [
      "failed event",
      {},
      brokerEvents({ 4: { exitCode: 1, type: "command.failed" } }),
      retainedLog(),
    ],
    ["malformed event type", {}, brokerEvents({ 3: { type: 7 } }), retainedLog()],
    ["nonzero command result", {}, brokerEvents({ 4: { exitCode: 1 } }), retainedLog()],
    ["retained marker", {}, brokerEvents(), retainedLog().replace("check_changed:ok", "missing")],
  ])("rejects mismatched %s", (_label, runOverrides, events, log) => {
    expect(() =>
      validateBrokerProof({
        bootstrapSha256,
        context: context(),
        events,
        log,
        now: Date.parse("2026-08-27T02:00:00Z"),
        run: brokerRun(runOverrides),
        userId: 42,
      }),
    ).toThrow();
  });

  it("accepts an empty retained log when exact command and events prove the run", () => {
    expect(() =>
      validateBrokerProof({
        bootstrapSha256,
        context: context(),
        events: brokerEvents(),
        log: "",
        now: Date.parse("2026-08-27T02:00:00Z"),
        run: brokerRun(),
        userId: 42,
      }),
    ).not.toThrow();
  });

  it("accepts bounded output preview truncation with a complete retained log", () => {
    const events = brokerEvents();
    events.splice(events.length - 1, 0, {
      message: "stdout/stderr event capture capped at 65536 bytes",
      runID: runId,
      seq: events.length,
      type: "output.truncated",
    });
    events.forEach((value, index) => {
      value.seq = index + 1;
    });
    expect(() =>
      validateBrokerProof({
        bootstrapSha256,
        context: context(),
        events,
        log: retainedLog(),
        now: Date.parse("2026-08-27T02:00:00Z"),
        run: brokerRun({ eventCount: events.length }),
        userId: 42,
      }),
    ).not.toThrow();
  });

  it("rejects out-of-order complete broker events", () => {
    const events = brokerEvents();
    const uploaded = events[2];
    const started = events[3];
    if (uploaded === undefined || started === undefined) {
      throw new Error("broker event fixture is incomplete");
    }
    events.splice(2, 2, started, uploaded);
    events.forEach((value, index) => {
      value.seq = index + 1;
    });
    expect(() =>
      validateBrokerProof({
        bootstrapSha256,
        context: context(),
        events,
        log: "",
        now: Date.parse("2026-08-27T02:00:00Z"),
        run: brokerRun(),
        userId: 42,
      }),
    ).toThrow(/event order/u);
  });
});

describe("Crabbox gate publisher mutation boundary", () => {
  it("rejects a non-active admin before reading broker evidence", async () => {
    const broker = { request: vi.fn() };
    const github = { request: vi.fn() };
    const organization = {
      request: vi.fn(async () => ({
        role: "admin",
        state: "pending",
        user: { login: "maintainer" },
      })),
    };

    await expect(
      runPublisher({
        broker,
        env: env(),
        event: event(),
        github,
        now: Date.parse("2026-08-27T02:00:00Z"),
        organization,
      }),
    ).rejects.toThrow(/not an active openclaw organization admin/u);
    expect(broker.request).not.toHaveBeenCalled();
    expect(github.request).not.toHaveBeenCalled();
  });

  it("revalidates admin, PR, and protected main before publishing the exact check", async () => {
    const calls: Array<{ body?: unknown; method: string; path: string }> = [];
    const orderedCalls: string[] = [];
    const github = {
      request: vi.fn(async (method: string, path: string, body?: unknown) => {
        orderedCalls.push(`github:${method}:${path}`);
        calls.push({ body, method, path });
        if (path === "/repos/openclaw/openclaw/pulls/130481") {
          return pullRequest();
        }
        if (path === "/repos/openclaw/openclaw/git/ref/heads/main") {
          return { object: { sha: workflowSha }, ref: "refs/heads/main" };
        }
        if (path === "/users/maintainer") {
          return { id: 42, login: "maintainer" };
        }
        if (method === "POST" && path === "/repos/openclaw/openclaw/check-runs") {
          return {
            app: { id: 15368 },
            conclusion: "success",
            head_sha: headSha,
            id: 88,
            name: "openclaw/ci-gate",
          };
        }
        throw new Error(`unexpected GitHub call: ${method} ${path}`);
      }),
    };
    const organization = {
      request: vi.fn(async (method: string, path: string) => {
        orderedCalls.push(`organization:${method}:${path}`);
        expect(method).toBe("GET");
        expect(path).toBe("/orgs/openclaw/memberships/maintainer");
        return {
          role: "admin",
          state: "active",
          user: { login: "maintainer" },
        };
      }),
    };
    const broker = {
      request: vi.fn(async (path: string, options?: { text?: boolean }) => {
        orderedCalls.push(`broker:GET:${path}`);
        if (path.endsWith("/logs") && options?.text) {
          return retainedLog();
        }
        if (path.endsWith("/events?limit=500")) {
          return { events: brokerEvents() };
        }
        if (path === `/v1/runs/${runId}`) {
          return { run: brokerRun() };
        }
        throw new Error(`unexpected broker call: ${path}`);
      }),
    };

    await expect(
      runPublisher({
        broker,
        env: env(),
        event: event(),
        github,
        now: Date.parse("2026-08-27T02:00:00Z"),
        organization,
      }),
    ).resolves.toMatchObject({ checkId: 88 });
    expect(organization.request).toHaveBeenCalledTimes(2);
    expect(calls.filter((call) => call.path.includes("/pulls/"))).toHaveLength(2);
    expect(calls.filter((call) => call.path.endsWith("/git/ref/heads/main"))).toHaveLength(2);
    expect(orderedCalls[0]).toBe("organization:GET:/orgs/openclaw/memberships/maintainer");
    expect(orderedCalls.slice(-3)).toEqual([
      "organization:GET:/orgs/openclaw/memberships/maintainer",
      "github:GET:/repos/openclaw/openclaw/git/ref/heads/main",
      "github:POST:/repos/openclaw/openclaw/check-runs",
    ]);
    const checkCall = calls.at(-1);
    expect(checkCall).toMatchObject({
      body: {
        conclusion: "success",
        head_sha: headSha,
        name: "openclaw/ci-gate",
        status: "completed",
      },
      method: "POST",
      path: "/repos/openclaw/openclaw/check-runs",
    });
  });

  it("rejects protected main moving after broker validation", async () => {
    let mainReads = 0;
    const github = {
      request: vi.fn(async (method: string, path: string) => {
        if (path === "/repos/openclaw/openclaw/pulls/130481") {
          return pullRequest();
        }
        if (path === "/repos/openclaw/openclaw/git/ref/heads/main") {
          mainReads += 1;
          return {
            object: { sha: mainReads === 1 ? workflowSha : "c".repeat(40) },
            ref: "refs/heads/main",
          };
        }
        if (path === "/users/maintainer") {
          return { id: 42, login: "maintainer" };
        }
        if (method === "POST" && path === "/repos/openclaw/openclaw/check-runs") {
          throw new Error("check publication must not run after protected main moves");
        }
        throw new Error(`unexpected GitHub call: ${method} ${path}`);
      }),
    };
    const organization = {
      request: vi.fn(async () => ({
        role: "admin",
        state: "active",
        user: { login: "maintainer" },
      })),
    };
    const broker = {
      request: vi.fn(async (path: string, options?: { text?: boolean }) => {
        if (path.endsWith("/logs") && options?.text) {
          return retainedLog();
        }
        if (path.endsWith("/events?limit=500")) {
          return { events: brokerEvents() };
        }
        if (path === `/v1/runs/${runId}`) {
          return { run: brokerRun() };
        }
        throw new Error(`unexpected broker call: ${path}`);
      }),
    };

    await expect(
      runPublisher({
        broker,
        env: env(),
        event: event(),
        github,
        now: Date.parse("2026-08-27T02:00:00Z"),
        organization,
      }),
    ).rejects.toThrow(/trusted main moved/u);
    expect(mainReads).toBe(2);
    expect(github.request).not.toHaveBeenCalledWith(
      "POST",
      "/repos/openclaw/openclaw/check-runs",
      expect.anything(),
    );
  });

  it("rejects a malformed published check ID", async () => {
    const github = {
      request: vi.fn(async (method: string, path: string) => {
        if (path === "/repos/openclaw/openclaw/pulls/130481") {
          return pullRequest();
        }
        if (path === "/repos/openclaw/openclaw/git/ref/heads/main") {
          return { object: { sha: workflowSha }, ref: "refs/heads/main" };
        }
        if (path === "/users/maintainer") {
          return { id: 42, login: "maintainer" };
        }
        if (method === "POST" && path === "/repos/openclaw/openclaw/check-runs") {
          return {
            app: { id: 15368 },
            conclusion: "success",
            head_sha: headSha,
            id: "not-a-check-id",
            name: "openclaw/ci-gate",
          };
        }
        throw new Error(`unexpected GitHub call: ${method} ${path}`);
      }),
    };
    const organization = {
      request: vi.fn(async () => ({
        role: "admin",
        state: "active",
        user: { login: "maintainer" },
      })),
    };
    const broker = {
      request: vi.fn(async (path: string, options?: { text?: boolean }) => {
        if (path.endsWith("/logs") && options?.text) {
          return retainedLog();
        }
        if (path.endsWith("/events?limit=500")) {
          return { events: brokerEvents() };
        }
        if (path === `/v1/runs/${runId}`) {
          return { run: brokerRun() };
        }
        throw new Error(`unexpected broker call: ${path}`);
      }),
    };

    await expect(
      runPublisher({
        broker,
        env: env(),
        event: event(),
        github,
        now: Date.parse("2026-08-27T02:00:00Z"),
        organization,
      }),
    ).rejects.toThrow(/published check ID must be a positive integer/u);
  });
});

describe("Crabbox broker authentication", () => {
  it("requires and sends coordinator plus Cloudflare Access credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toEqual({
        Authorization: "Bearer coordinator-token",
        "CF-Access-Client-Id": "access-id",
        "CF-Access-Client-Secret": "access-secret",
      });
      return new Response('{"run":{"id":"run_abc123"}}', {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    });
    const api = createJsonApi({
      accessClientId: "access-id",
      accessClientSecret: "access-secret",
      baseUrl: "https://broker.example/",
      fetchImpl,
      token: "coordinator-token",
    });
    await expect(api.request("/v1/runs/run_abc123")).resolves.toEqual({
      run: { id: "run_abc123" },
    });
    expect(() =>
      createJsonApi({
        accessClientId: "",
        accessClientSecret: "access-secret",
        baseUrl: "https://broker.example/",
        fetchImpl,
        token: "coordinator-token",
      }),
    ).toThrow(/Access client id/u);
  });
});

describe("Crabbox gate workflow", () => {
  it("runs only on protected main with the minimal publication permissions", () => {
    const workflow = parseYaml(
      readFileSync(".github/workflows/pr-crabbox-gate-publisher.yml", "utf8"),
    ) as {
      jobs: {
        publish: { permissions: Record<string, string>; steps: Array<Record<string, unknown>> };
      };
      on: { workflow_dispatch: { inputs: Record<string, unknown> } };
      permissions: Record<string, string>;
    };
    expect(Object.keys(workflow.on.workflow_dispatch.inputs).toSorted()).toEqual([
      "bootstrap_sha256",
      "crabbox_lease_id",
      "crabbox_run_id",
      "head_sha",
      "pr_number",
    ]);
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.publish.permissions).toEqual({
      checks: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(workflow.jobs.publish.steps[0]).toMatchObject({
      with: { "persist-credentials": false, ref: "${{ github.workflow_sha }}" },
    });
    expect(workflow.jobs.publish.steps.at(-1)).toMatchObject({
      env: {
        CRABBOX_ACCESS_CLIENT_ID: "${{ secrets.CRABBOX_ACCESS_CLIENT_ID }}",
        CRABBOX_ACCESS_CLIENT_SECRET: "${{ secrets.CRABBOX_ACCESS_CLIENT_SECRET }}",
        CRABBOX_COORDINATOR: "${{ secrets.CRABBOX_COORDINATOR }}",
        CRABBOX_COORDINATOR_TOKEN: "${{ secrets.CRABBOX_COORDINATOR_TOKEN }}",
        GH_APP_TOKEN:
          "${{ steps.app-token.outputs.token || steps.app-token-fallback.outputs.token }}",
        GH_TOKEN: "${{ github.token }}",
      },
    });
    expect(workflow.jobs.publish.steps.slice(2, 4)).toMatchObject([
      {
        id: "app-token",
        uses: "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
        with: { "app-id": "2729701", "permission-members": "read" },
      },
      {
        id: "app-token-fallback",
        uses: "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
        with: { "app-id": "2971289", "permission-members": "read" },
      },
    ]);
  });
});
