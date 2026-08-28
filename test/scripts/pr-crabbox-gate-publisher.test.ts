import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  appendCrabboxOutputTail,
  buildCrabboxGateCommand,
  createJsonApi,
  runPublisher,
  validateBrokerProof,
  validatePublisherRequest,
} from "../../scripts/pr-crabbox-gate-publisher.mjs";
import {
  crabboxGatePlanDigest,
  formatCrabboxGateCheckSummary,
} from "../../scripts/pr-lib/crabbox-gate-contract.mjs";

const repository = "openclaw/openclaw";
const workflowSha = "a".repeat(40);
const baseSha = "c".repeat(40);
const headSha = "b".repeat(40);
const bootstrapSha256 = createHash("sha256")
  .update(readFileSync("scripts/crabbox-untrusted-bootstrap.sh"))
  .digest("hex");
const runId = "run_abc123";
const leaseId = "cbx_def456";
const serviceOwner = "github-actions:crabbox-gate";
const proofEndedAt = Date.parse("2026-08-28T01:30:00Z");

type PublisherWorkflow = {
  jobs: {
    publish: {
      environment: string;
      permissions: Record<string, string>;
      steps: Array<{
        env?: Record<string, string>;
        run?: string;
        with?: Record<string, unknown>;
      }>;
      "timeout-minutes": number;
    };
  };
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
  permissions: Record<string, unknown>;
};

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CRABBOX_BIN: "/opt/crabbox",
    CRABBOX_COORDINATOR: "https://crabbox.example",
    CRABBOX_COORDINATOR_TOKEN: "broker-token",
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
    PATH: "/usr/bin:/bin",
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    inputs: {
      base_sha: baseSha,
      head_sha: headSha,
      pr_number: "130481",
      ...overrides,
    },
  };
}

function gatePlan() {
  return {
    baseSha,
    changedPaths: [{ path: "scripts/pr", status: "M" as const }],
    headSha,
    targets: ["test/scripts/pr-merge.test.ts"],
    version: 1 as const,
  };
}

function context() {
  return {
    ...validatePublisherRequest(event(), env()),
    leaseId,
    plan: gatePlan(),
    runId,
  };
}

function command() {
  return [
    "--script",
    "scripts/crabbox-untrusted-bootstrap.sh",
    headSha,
    "/bin/bash",
    "-lc",
    buildCrabboxGateCommand(gatePlan(), bootstrapSha256),
  ];
}

function retainedLog() {
  return [
    "OPENCLAW_CRABBOX_GATE_VERSION=1",
    "OPENCLAW_CRABBOX_GATE_MODE=remote_crabbox_aws",
    `OPENCLAW_CRABBOX_GATE_BASE=${baseSha}`,
    `OPENCLAW_CRABBOX_GATE_HEAD=${headSha}`,
    `OPENCLAW_CRABBOX_GATE_PLAN_SHA256=${crabboxGatePlanDigest(gatePlan())}`,
    "OPENCLAW_CRABBOX_GATE_TARGET_COUNT=1",
    `OPENCLAW_CRABBOX_BOOTSTRAP_SHA256=${bootstrapSha256}`,
    "OPENCLAW_CRABBOX_GATE_STAGE=build:ok",
    "OPENCLAW_CRABBOX_GATE_STAGE=check:ok",
    "OPENCLAW_CRABBOX_GATE_STAGE=test:ok",
    "OPENCLAW_CRABBOX_GATE_RESULT=success",
  ].join("\n");
}

function brokerRun(overrides: Record<string, unknown> = {}) {
  return {
    command: command(),
    endedAt: "2026-08-28T01:30:00Z",
    eventCount: 6,
    exitCode: 0,
    id: runId,
    label: `openclaw-pr-gate:130481:${baseSha}:${headSha}`,
    leaseID: leaseId,
    logTruncated: false,
    org: "openclaw",
    owner: serviceOwner,
    phase: "released",
    provider: "aws",
    startedAt: "2026-08-28T01:00:00Z",
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
  return values.map((value, index) =>
    Object.assign(value, overrides[index], { runID: runId, seq: index + 1 }),
  );
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    base: { ref: "main", repo: { full_name: repository }, sha: baseSha },
    draft: true,
    head: { repo: { full_name: repository }, sha: headSha },
    number: 130481,
    state: "open",
    ...overrides,
  };
}

function baseAncestry(overrides: Record<string, unknown> = {}) {
  return {
    ahead_by: 4,
    base_commit: { sha: baseSha },
    behind_by: 0,
    merge_base_commit: { sha: baseSha },
    status: "ahead",
    ...overrides,
  };
}

function activeMembership() {
  return { role: "admin", state: "active", user: { login: "maintainer" } };
}

function servicePrincipal(overrides: Record<string, unknown> = {}) {
  return {
    admin: false,
    auth: "bearer",
    org: "openclaw",
    owner: serviceOwner,
    ...overrides,
  };
}

function crabboxRunner() {
  return vi.fn(
    async ({
      args,
      env: childEnv,
      stream,
    }: {
      args: string[];
      env: NodeJS.ProcessEnv;
      stream?: boolean;
    }) => {
      if (args[0] === "config") {
        expect(stream).toBeUndefined();
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            aws: { instanceProfile: "" },
            coordinator: "https://crabbox.example",
          }),
        };
      }
      expect(stream).toBe(true);
      expect(args).toEqual(
        expect.arrayContaining([
          "--provider",
          "aws",
          "--network",
          "public",
          "--tailscale=false",
          "--no-hydrate",
          "--idle-timeout",
          "90m",
          "--ttl",
          "240m",
          "--stop-after",
          "always",
          "--script",
          "scripts/crabbox-untrusted-bootstrap.sh",
          headSha,
        ]),
      );
      expect(childEnv).toMatchObject({
        CI: "1",
        CRABBOX_COORDINATOR: "https://crabbox.example",
        CRABBOX_COORDINATOR_TOKEN: "broker-token",
        CRABBOX_ENV_ALLOW: "CI",
        NO_COLOR: "1",
      });
      expect(childEnv).not.toHaveProperty("AWS_PROFILE");
      return {
        exitCode: 0,
        stdout: "",
        stderr: `${JSON.stringify({
          exitCode: 0,
          label: `openclaw-pr-gate:130481:${baseSha}:${headSha}`,
          leaseId,
          leaseStopped: true,
          provider: "aws",
          runId,
          runStatus: "succeeded",
        })}\n`,
      };
    },
  );
}

describe("Crabbox gate request and broker proof", () => {
  it("accepts only the exact protected-main inputs", () => {
    expect(validatePublisherRequest(event(), env())).toMatchObject({
      baseSha,
      headSha,
      prNumber: 130481,
      workflowSha,
    });
    expect(() => validatePublisherRequest(event({ extra: "no" }), env())).toThrow(
      /keys must be exactly/u,
    );
  });

  it.each([
    [env({ GITHUB_REPOSITORY: "attacker/fork" }), event()],
    [env({ GITHUB_REF: "refs/pull/130481/merge" }), event()],
    [env({ GITHUB_SHA: "d".repeat(40) }), event()],
    [env(), event({ base_sha: "not-a-sha" })],
    [env({ GITHUB_TRIGGERING_ACTOR: "other" }), event()],
  ])("rejects untrusted request metadata", (inputEnv, inputEvent) => {
    expect(() => validatePublisherRequest(inputEvent, inputEnv)).toThrow();
  });

  it("accepts exact service-owned AWS/Linux released proof", () => {
    expect(() =>
      validateBrokerProof({
        bootstrapSha256,
        context: context(),
        events: brokerEvents(),
        log: retainedLog(),
        now: Date.parse("2026-08-28T02:00:00Z"),
        principal: servicePrincipal(),
        run: brokerRun(),
      }),
    ).not.toThrow();
  });

  it.each([
    ["at the two-hour limit", proofEndedAt + 2 * 60 * 60 * 1000, false],
    ["one millisecond past the limit", proofEndedAt + 2 * 60 * 60 * 1000 + 1, true],
  ])("%s proof freshness", (_label, now, rejected) => {
    const verify = () =>
      validateBrokerProof({
        bootstrapSha256,
        context: context(),
        events: brokerEvents(),
        log: retainedLog(),
        now,
        principal: servicePrincipal(),
        run: brokerRun(),
      });
    if (rejected) {
      expect(verify).toThrow(/fresh completed proof/u);
    } else {
      expect(verify).not.toThrow();
    }
  });

  it("caps retained output while preserving the final timing line", () => {
    const timing = `${JSON.stringify({
      exitCode: 0,
      leaseId,
      leaseStopped: true,
      provider: "aws",
      runId,
      runStatus: "succeeded",
    })}\n`;
    const oversized = Buffer.from("x".repeat(256 * 1024));
    const retained = appendCrabboxOutputTail(
      appendCrabboxOutputTail(Buffer.alloc(0), oversized),
      timing,
    );
    expect(retained.length).toBeLessThan(oversized.length);
    expect(retained.toString().endsWith(timing)).toBe(true);
  });

  it.each([
    ["owner", { owner: "github:42" }, brokerEvents(), retainedLog()],
    ["provider", { provider: "blacksmith-testbox" }, brokerEvents(), retainedLog()],
    ["truncation", { logTruncated: true }, brokerEvents(), retainedLog()],
    ["command", { command: ["pnpm", "test"] }, brokerEvents(), retainedLog()],
    [
      "bootstrap",
      {},
      brokerEvents({ 2: { message: ".crabbox/scripts/attacker.sh" } }),
      retainedLog(),
    ],
    [
      "failed event",
      {},
      brokerEvents({ 4: { exitCode: 1, type: "command.failed" } }),
      retainedLog(),
    ],
    ["marker", {}, brokerEvents(), retainedLog().replace("test:ok", "missing")],
  ])("rejects mismatched %s", (_label, runOverrides, events, log) => {
    expect(() =>
      validateBrokerProof({
        bootstrapSha256,
        context: context(),
        events,
        log,
        now: Date.parse("2026-08-28T02:00:00Z"),
        principal: servicePrincipal(),
        run: brokerRun(runOverrides),
      }),
    ).toThrow();
  });

  it("accepts empty retained logs when command and events are complete", () => {
    expect(() =>
      validateBrokerProof({
        bootstrapSha256,
        context: context(),
        events: brokerEvents(),
        log: "",
        now: Date.parse("2026-08-28T02:00:00Z"),
        principal: servicePrincipal(),
        run: brokerRun(),
      }),
    ).not.toThrow();
  });
});

describe("Crabbox gate publisher boundary", () => {
  function harness(
    overrides: {
      ancestry?: Record<string, unknown>;
      membership?: Record<string, unknown>;
      postMainSha?: string;
      principal?: Record<string, unknown>;
      pull?: Record<string, unknown>;
      run?: Record<string, unknown>;
    } = {},
  ) {
    const orderedCalls: string[] = [];
    let mainReads = 0;
    const github = {
      request: vi.fn(async (method: string, requestPath: string, body?: unknown) => {
        orderedCalls.push(`github:${method}:${requestPath}`);
        if (requestPath.endsWith("/pulls/130481")) {
          return pullRequest(overrides.pull);
        }
        if (requestPath.endsWith("/git/ref/heads/main")) {
          mainReads += 1;
          return {
            object: {
              sha: mainReads === 2 && overrides.postMainSha ? overrides.postMainSha : workflowSha,
            },
            ref: "refs/heads/main",
          };
        }
        if (requestPath.includes("/compare/")) {
          return baseAncestry(overrides.ancestry);
        }
        if (method === "POST" && requestPath.endsWith("/check-runs")) {
          expect(body).toMatchObject({
            conclusion: "success",
            head_sha: headSha,
            name: "openclaw/crabbox-gate",
            output: {
              summary: formatCrabboxGateCheckSummary({
                baseSha,
                headSha,
                leaseId,
                planDigest: crabboxGatePlanDigest(gatePlan()),
                runId,
                targetCount: 1,
                workflowSha,
              }),
            },
          });
          return {
            app: { id: 15368 },
            conclusion: "success",
            head_sha: headSha,
            id: 88,
            name: "openclaw/crabbox-gate",
          };
        }
        throw new Error(`unexpected GitHub call: ${method} ${requestPath}`);
      }),
    };
    const organization = {
      request: vi.fn(async (method: string, requestPath: string) => {
        orderedCalls.push(`organization:${method}:${requestPath}`);
        return overrides.membership ?? activeMembership();
      }),
    };
    const broker = {
      request: vi.fn(async (requestPath: string, options?: { text?: boolean }) => {
        orderedCalls.push(`broker:${requestPath}`);
        if (requestPath === "/v1/whoami") {
          return servicePrincipal(overrides.principal);
        }
        if (requestPath.endsWith("/events?limit=500")) {
          return { events: brokerEvents() };
        }
        if (requestPath.endsWith("/logs") && options?.text) {
          return retainedLog();
        }
        if (requestPath === `/v1/runs/${runId}`) {
          return { run: brokerRun(overrides.run) };
        }
        throw new Error(`unexpected broker call: ${requestPath}`);
      }),
    };
    return { broker, github, orderedCalls, organization, runCrabbox: crabboxRunner() };
  }

  it("preflights authority, launches under the service token, and revalidates before publish", async () => {
    const values = harness();
    await expect(
      runPublisher({
        ...values,
        clock: () => Date.parse("2026-08-28T02:00:00Z"),
        env: env({ AWS_PROFILE: "must-not-leak" }),
        event: event(),
        resolvePlan: () => gatePlan(),
      }),
    ).resolves.toMatchObject({
      checkId: 88,
      context: { baseSha, headSha, leaseId, runId, workflowSha },
    });
    expect(values.runCrabbox).toHaveBeenCalledTimes(2);
    expect(values.orderedCalls.slice(0, 4)).toEqual([
      "organization:GET:/orgs/openclaw/memberships/maintainer",
      "github:GET:/repos/openclaw/openclaw/pulls/130481",
      "github:GET:/repos/openclaw/openclaw/git/ref/heads/main",
      `github:GET:/repos/openclaw/openclaw/compare/${baseSha}...${workflowSha}`,
    ]);
    expect(values.orderedCalls.at(-1)).toBe("github:POST:/repos/openclaw/openclaw/check-runs");
  });

  it("evaluates proof freshness after the remote run completes", async () => {
    const values = harness();
    let clockNow = Date.parse("2026-08-28T01:00:00Z");
    const runCrabbox = vi.fn(async (input: Parameters<typeof values.runCrabbox>[0]) => {
      const result = await values.runCrabbox(input);
      if (input.args[0] === "run") {
        clockNow = Date.parse("2026-08-28T02:00:00Z");
      }
      return result;
    });
    await expect(
      runPublisher({
        ...values,
        clock: () => clockNow,
        env: env(),
        event: event(),
        resolvePlan: () => gatePlan(),
        runCrabbox,
      }),
    ).resolves.toMatchObject({ checkId: 88 });
  });

  it("rejects non-admin, closed, or non-ancestor input before provisioning", async () => {
    for (const overrides of [
      { membership: { ...activeMembership(), state: "pending" } },
      { pull: { state: "closed" } },
      { ancestry: { behind_by: 1, status: "diverged" } },
    ]) {
      const values = harness(overrides);
      await expect(
        runPublisher({
          ...values,
          env: env(),
          event: event(),
          resolvePlan: () => gatePlan(),
        }),
      ).rejects.toThrow();
      expect(values.runCrabbox).not.toHaveBeenCalled();
    }
  });

  it("rejects protected main moving before check publication", async () => {
    const values = harness({ postMainSha: "d".repeat(40) });
    await expect(
      runPublisher({
        ...values,
        clock: () => Date.parse("2026-08-28T02:00:00Z"),
        env: env(),
        event: event(),
        resolvePlan: () => gatePlan(),
      }),
    ).rejects.toThrow(/trusted main moved/u);
    expect(values.github.request).not.toHaveBeenCalledWith(
      "POST",
      "/repos/openclaw/openclaw/check-runs",
      expect.anything(),
    );
  });

  it("requires the exact bearer service principal and same-owner broker run", async () => {
    for (const overrides of [{ principal: { auth: "session" } }, { run: { owner: "github:42" } }]) {
      const values = harness(overrides);
      await expect(
        runPublisher({
          ...values,
          clock: () => Date.parse("2026-08-28T02:00:00Z"),
          env: env(),
          event: event(),
          resolvePlan: () => gatePlan(),
        }),
      ).rejects.toThrow(/service principal|ownership/u);
    }
  });
});

describe("Crabbox broker authentication", () => {
  it.each([
    ["with Access", "access-id", "access-secret"],
    ["without Access", "", ""],
  ])("sends bearer authentication %s", async (_label, accessClientId, accessClientSecret) => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toEqual({
        Authorization: "Bearer coordinator-token",
        ...(accessClientId
          ? {
              "CF-Access-Client-Id": accessClientId,
              "CF-Access-Client-Secret": accessClientSecret,
            }
          : {}),
      });
      return new Response('{"owner":"service"}', { status: 200 });
    });
    const api = createJsonApi({
      accessClientId,
      accessClientSecret,
      baseUrl: "https://broker.example/",
      fetchImpl,
      token: "coordinator-token",
    });
    await expect(api.request("/v1/whoami")).resolves.toEqual({ owner: "service" });
  });

  it("rejects a Cloudflare Access half-pair", () => {
    expect(() =>
      createJsonApi({
        accessClientId: "id",
        baseUrl: "https://broker.example/",
        token: "coordinator-token",
      }),
    ).toThrow(/provided together/u);
  });
});

describe("Crabbox gate workflow", () => {
  it("pins the publisher-owned run to protected main", () => {
    const workflow = parseYaml(
      readFileSync(".github/workflows/pr-crabbox-gate-publisher.yml", "utf8"),
    ) as PublisherWorkflow;
    const job = workflow.jobs.publish;
    expect(Object.keys(workflow.on.workflow_dispatch.inputs).toSorted()).toEqual([
      "base_sha",
      "head_sha",
      "pr_number",
    ]);
    expect(workflow.permissions).toEqual({});
    expect(job.environment).toBe("qa-live-shared");
    expect(job["timeout-minutes"]).toBe(270);
    expect(job.permissions).toEqual({
      checks: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(job.steps[0]).toMatchObject({
      with: {
        "fetch-depth": 0,
        "persist-credentials": false,
        ref: "${{ github.workflow_sha }}",
      },
    });
    const installCommand = job.steps[2]?.run;
    if (typeof installCommand !== "string") {
      throw new Error("Crabbox install command is missing");
    }
    expect(installCommand).toContain("crabbox_0.46.0_linux_amd64.tar.gz");
    expect(installCommand).toContain(
      "6a9341e810307356361dbed4c4b84be28a036b5cc291af1566d2ccd376570d90",
    );
    expect(job.steps.at(-1)).toMatchObject({
      env: {
        CRABBOX_COORDINATOR:
          "${{ secrets.CRABBOX_COORDINATOR || secrets.OPENCLAW_QA_MANTIS_CRABBOX_COORDINATOR }}",
        CRABBOX_COORDINATOR_TOKEN:
          "${{ secrets.CRABBOX_COORDINATOR_TOKEN || secrets.OPENCLAW_QA_MANTIS_CRABBOX_COORDINATOR_TOKEN }}",
      },
      run: "node scripts/pr-crabbox-gate-publisher.mjs",
    });
  });
});
