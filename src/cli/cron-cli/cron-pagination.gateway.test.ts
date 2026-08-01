// Cron CLI pagination exercises real Gateway handlers and canonical cron snapshots.
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockCronStateForJobs } from "../../cron/service.test-harness.js";
import { listPage } from "../../cron/service/ops-read.js";
import type { CronJob } from "../../cron/types.js";
import { cronHandlers } from "../../gateway/server-methods/cron.js";

const mocks = vi.hoisted(() => {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
  };
  return { runtime, callGatewayFromCli: vi.fn() };
});

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      mocks.callGatewayFromCli(...args),
  };
});

vi.mock("../../runtime.js", () => ({ defaultRuntime: mocks.runtime }));

const { registerCronCli } = await import("../cron-cli.js");

function createJob(index: number, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: `job-${String(index).padStart(3, "0")}`,
    name: `Job ${String(index).padStart(3, "0")}`,
    enabled: true,
    createdAtMs: index,
    updatedAtMs: index,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "scheduled check" },
    state: { nextRunAtMs: index + 1 },
    ...overrides,
  };
}

function installRealCronGateway(
  jobs: CronJob[],
  options: {
    beforeList?: (params: Record<string, unknown>, listCall: number, jobs: CronJob[]) => void;
    transformListPage?: (page: unknown, listCall: number) => unknown;
  } = {},
) {
  const state = createMockCronStateForJobs({ jobs });
  let listCalls = 0;
  const cron = {
    listPage: async (params: Parameters<typeof listPage>[1]) => {
      listCalls += 1;
      options.beforeList?.(
        params ?? {},
        listCalls,
        expectDefined(state.store, "expected loaded canonical cron test store").jobs,
      );
      return await listPage(state, params);
    },
    readJob: async (id: string) =>
      expectDefined(state.store, "expected loaded canonical cron test store").jobs.find(
        (job) => job.id === id,
      ),
    getDefaultAgentId: () => "main",
  };

  mocks.callGatewayFromCli.mockImplementation(
    async (method: string, _options: unknown, params: Record<string, unknown> = {}) => {
      const handler = expectDefined(cronHandlers[method], `missing real Gateway method ${method}`);
      let response:
        | { ok: boolean; payload?: unknown; error?: { code?: string; message?: string } }
        | undefined;
      await handler({
        req: {} as never,
        params,
        respond: (ok: boolean, payload?: unknown, error?: { code?: string; message?: string }) => {
          response = { ok, payload, error };
        },
        context: {
          cron,
          getRuntimeConfig: () => ({}),
        } as never,
      } as never);
      const result = expectDefined(response, `${method} returned no Gateway response`);
      if (!result.ok) {
        throw Object.assign(new Error(result.error?.message ?? `${method} failed`), {
          name: "GatewayClientRequestError",
          gatewayCode: result.error?.code,
        });
      }
      if (method === "cron.list" && options.transformListPage) {
        return options.transformListPage(result.payload, listCalls);
      }
      return result.payload;
    },
  );
  return state;
}

function disableCronGetForProtocolV4Gateway(): void {
  const invokeGateway = expectDefined(
    mocks.callGatewayFromCli.getMockImplementation(),
    "expected installed real cron Gateway",
  );
  mocks.callGatewayFromCli.mockImplementation(async (...args: unknown[]) => {
    if (args[0] === "cron.get") {
      throw Object.assign(new Error("unknown method: cron.get"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
      });
    }
    return await invokeGateway(...args);
  });
}

async function runCron(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerCronCli(program);
  await program.parseAsync(["cron", ...args], { from: "user" });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("cron CLI with the real Gateway pagination contract", () => {
  it("lists all 201 jobs returned across actual bounded Gateway pages", async () => {
    installRealCronGateway(Array.from({ length: 201 }, (_, index) => createJob(index)));

    await runCron(["list", "--json"]);

    const result = mocks.runtime.writeJson.mock.calls.at(-1)?.[0] as { jobs: CronJob[] };
    expect(result.jobs).toHaveLength(201);
    expect(result.jobs.some((job) => job.id === "job-200")).toBe(true);
    expect(
      (result as { deliveryPreviews?: Record<string, unknown> }).deliveryPreviews?.["job-200"],
    ).toEqual(expect.objectContaining({ label: "not requested" }));
    expect(
      mocks.callGatewayFromCli.mock.calls.filter(([method]) => method === "cron.list"),
    ).toHaveLength(2);
  });

  it("never combines Gateway pages from different cron snapshots", async () => {
    const original = Array.from({ length: 201 }, (_, index) => createJob(index));
    installRealCronGateway(original, {
      beforeList(_params, call, jobs) {
        if (call === 2) {
          jobs[0] = createJob(900, { name: "Replacement after snapshot change" });
        }
      },
    });

    await runCron(["list", "--json"]);

    const result = mocks.runtime.writeJson.mock.calls.at(-1)?.[0] as { jobs: CronJob[] };
    expect(result.jobs).toHaveLength(201);
    expect(result.jobs.some((job) => job.id === "job-900")).toBe(true);
    expect(result.jobs.some((job) => job.id === "job-000")).toBe(false);
    expect(
      mocks.callGatewayFromCli.mock.calls
        .filter(([method]) => method === "cron.list")
        .map((call) => (call[2] as { offset?: number }).offset),
    ).toEqual([0, 200, 0, 200]);
  });

  it("restarts when a shrinking Gateway snapshot clamps the requested page offset", async () => {
    installRealCronGateway(
      Array.from({ length: 201 }, (_, index) => createJob(index)),
      {
        beforeList(_params, call, jobs) {
          if (call === 2) {
            jobs.splice(0, 2);
          }
        },
      },
    );

    await runCron(["list", "--json"]);

    const result = mocks.runtime.writeJson.mock.calls.at(-1)?.[0] as { jobs: CronJob[] };
    expect(result.jobs).toHaveLength(199);
    expect(result.jobs.some((job) => job.id === "job-000")).toBe(false);
    expect(result.jobs.some((job) => job.id === "job-001")).toBe(false);
    expect(
      mocks.callGatewayFromCli.mock.calls
        .filter(([method]) => method === "cron.list")
        .map((call) => (call[2] as { offset?: number }).offset),
    ).toEqual([0, 200, 0]);
  });

  it("detects and lists every job from a paginated protocol-v4 Gateway", async () => {
    installRealCronGateway(
      Array.from({ length: 201 }, (_, index) => createJob(index)),
      {
        transformListPage(page) {
          const response = page as Record<string, unknown>;
          return {
            jobs: response.jobs,
            hasMore: response.hasMore,
            nextOffset: response.nextOffset,
            deliveryPreviews: response.deliveryPreviews,
          };
        },
      },
    );
    disableCronGetForProtocolV4Gateway();

    await runCron(["list", "--json"]);

    const result = mocks.runtime.writeJson.mock.calls.at(-1)?.[0] as { jobs: CronJob[] };
    expect(result.jobs).toHaveLength(201);
    expect(result.jobs.some((job) => job.id === "job-200")).toBe(true);
    expect(mocks.callGatewayFromCli).toHaveBeenCalledWith("cron.get", expect.anything(), {
      id: "job-000",
    });
    expect(
      mocks.callGatewayFromCli.mock.calls.filter(([method]) => method === "cron.list"),
    ).toHaveLength(2);
  });

  it.each([
    { label: "empty", jobs: [] as CronJob[] },
    { label: "single-job", jobs: [createJob(0)] },
  ])("detects a $label terminal protocol-v4 inventory", async ({ jobs }) => {
    installRealCronGateway(jobs, {
      transformListPage(page) {
        const response = page as Record<string, unknown>;
        return {
          jobs: response.jobs,
          hasMore: response.hasMore,
          nextOffset: response.nextOffset,
          deliveryPreviews: response.deliveryPreviews,
        };
      },
    });
    disableCronGetForProtocolV4Gateway();

    await runCron(["list", "--json"]);

    const result = mocks.runtime.writeJson.mock.calls.at(-1)?.[0] as { jobs: CronJob[] };
    expect(result.jobs).toHaveLength(jobs.length);
    expect(mocks.callGatewayFromCli).toHaveBeenCalledWith(
      "cron.get",
      expect.anything(),
      expect.objectContaining({ id: expect.any(String) }),
    );
  });

  it("never combines protocol-v4 and canonical Gateway inventory pages", async () => {
    installRealCronGateway(
      Array.from({ length: 201 }, (_, index) => createJob(index)),
      {
        transformListPage(page, call) {
          if (call % 2 === 0) {
            return page;
          }
          const response = page as Record<string, unknown>;
          return {
            jobs: response.jobs,
            hasMore: response.hasMore,
            nextOffset: response.nextOffset,
            deliveryPreviews: response.deliveryPreviews,
          };
        },
      },
    );
    disableCronGetForProtocolV4Gateway();

    await expect(runCron(["list", "--json"])).rejects.toThrow("exit 1");

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("inventory changed repeatedly"),
    );
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    expect(
      mocks.callGatewayFromCli.mock.calls.filter(([method]) => method === "cron.list"),
    ).toHaveLength(8);
  });

  it("renders cron jobs beyond the first Gateway page in normal table output", async () => {
    installRealCronGateway(Array.from({ length: 201 }, (_, index) => createJob(index)));

    await runCron(["list"]);

    expect(mocks.runtime.log.mock.calls.some(([line]) => line.includes("Job 200"))).toBe(true);
    expect(mocks.runtime.log).toHaveBeenCalledTimes(202);
  });

  it("fails closed when every cron inventory snapshot changes", async () => {
    installRealCronGateway(
      Array.from({ length: 201 }, (_, index) => createJob(index)),
      {
        beforeList(params, _call, jobs) {
          if (params.offset === 200) {
            const first = expectDefined(jobs[0], "expected first cron snapshot job");
            jobs[0] = { ...first, updatedAtMs: first.updatedAtMs + 1 };
          }
        },
      },
    );

    await expect(runCron(["list", "--json"])).rejects.toThrow("exit 1");

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("inventory changed repeatedly"),
    );
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    expect(
      mocks.callGatewayFromCli.mock.calls.filter(([method]) => method === "cron.list"),
    ).toHaveLength(8);
  });

  it.each([
    {
      label: "missing job rows",
      corrupt: (page: Record<string, unknown>) => ({ ...page, jobs: undefined }),
      error: "invalid inventory page",
    },
    {
      label: "missing snapshot revision",
      corrupt: (page: Record<string, unknown>) => ({ ...page, snapshotRevision: undefined }),
      error: "invalid inventory page",
    },
    {
      label: "a missing terminal cursor",
      corrupt: (page: Record<string, unknown>) => ({ ...page, nextOffset: undefined }),
      error: "invalid inventory page",
    },
    {
      label: "a terminal page exceeding its declared job limit",
      corrupt: (page: Record<string, unknown>) => ({
        ...page,
        jobs: Array.from({ length: 10_001 }, (_, index) => createJob(index)),
        total: 10_001,
        limit: 200,
        hasMore: false,
        nextOffset: null,
      }),
      error: "invalid inventory page",
    },
    {
      label: "a truncated terminal page",
      corrupt: (page: Record<string, unknown>) => ({ ...page, total: 2 }),
      error: "inconsistent terminal inventory page",
    },
  ])("fails closed for $label", async ({ corrupt, error }) => {
    installRealCronGateway([createJob(0)], {
      transformListPage(page) {
        return corrupt(page as Record<string, unknown>);
      },
    });

    await expect(runCron(["list", "--json"])).rejects.toThrow("exit 1");

    expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining(error));
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it("rejects unversioned multi-page responses from current Gateways", async () => {
    installRealCronGateway(
      Array.from({ length: 201 }, (_, index) => createJob(index)),
      {
        transformListPage(page) {
          const response = page as Record<string, unknown>;
          return {
            jobs: response.jobs,
            hasMore: response.hasMore,
            nextOffset: response.nextOffset,
          };
        },
      },
    );

    await expect(runCron(["list", "--json"])).rejects.toThrow("exit 1");

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("invalid inventory page"),
    );
    expect(
      mocks.callGatewayFromCli.mock.calls.filter(([method]) => method === "cron.list"),
    ).toHaveLength(1);
    expect(mocks.callGatewayFromCli).toHaveBeenCalledWith("cron.get", expect.anything(), {
      id: "job-000",
    });
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it.each([
    { label: "empty", jobs: [] as CronJob[] },
    { label: "single-job", jobs: [createJob(0)] },
  ])("rejects a $label unversioned terminal page from a current Gateway", async ({ jobs }) => {
    installRealCronGateway(jobs, {
      transformListPage(page) {
        const response = page as Record<string, unknown>;
        return {
          jobs: response.jobs,
          hasMore: response.hasMore,
          nextOffset: response.nextOffset,
        };
      },
    });

    await expect(runCron(["list", "--json"])).rejects.toThrow("exit 1");

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("invalid inventory page"),
    );
    expect(mocks.callGatewayFromCli).toHaveBeenCalledWith(
      "cron.get",
      expect.anything(),
      expect.objectContaining({ id: expect.any(String) }),
    );
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it("stops a stable oversized cron inventory after the canonical page bound", async () => {
    const jobs = Array.from({ length: 200 }, (_, index) => createJob(index));
    mocks.callGatewayFromCli.mockImplementation(
      async (method: string, _options: unknown, params: { offset?: number } = {}) => {
        if (method !== "cron.list") {
          throw new Error(`unexpected cron method: ${method}`);
        }
        const offset = params.offset ?? 0;
        return {
          jobs,
          snapshotRevision: "stable-oversized-cron-inventory",
          total: 10_001,
          offset,
          limit: 200,
          hasMore: true,
          nextOffset: offset + 200,
        };
      },
    );

    await expect(runCron(["list", "--json"])).rejects.toThrow("exit 1");

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("pagination exceeded maximum pages"),
    );
    expect(mocks.callGatewayFromCli).toHaveBeenCalledTimes(50);
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it("prefers a canonical cron.get ID over another job's identical name", async () => {
    const nameCollision = createJob(0, { id: "name-owner", name: "job-200" });
    const actualId = createJob(200, { id: "job-200", name: "Actual ID owner" });
    installRealCronGateway([nameCollision, actualId]);

    await runCron(["show", "job-200", "--json"]);

    const result = mocks.runtime.writeJson.mock.calls.at(-1)?.[0] as CronJob;
    expect(result.id).toBe("job-200");
    expect(result.name).toBe("Actual ID owner");
    expect(mocks.callGatewayFromCli).toHaveBeenCalledWith("cron.get", expect.anything(), {
      id: "job-200",
    });
    expect(mocks.callGatewayFromCli.mock.calls.some(([method]) => method === "cron.list")).toBe(
      false,
    );
  });

  it("finds an exact cron job name beyond the first real Gateway page", async () => {
    const jobs = Array.from({ length: 201 }, (_, index) => createJob(index));
    jobs[200] = createJob(200, { name: "Last page exact job" });
    installRealCronGateway(jobs);

    await runCron(["show", "Last page exact job", "--json"]);

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-200", name: "Last page exact job" }),
    );
  });

  it("never hides Gateway transport errors behind a name-based cron scan", async () => {
    installRealCronGateway([createJob(0)]);
    const invokeGateway = expectDefined(
      mocks.callGatewayFromCli.getMockImplementation(),
      "expected installed real cron Gateway",
    );
    mocks.callGatewayFromCli.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "cron.get") {
        throw new Error("Gateway transport is unavailable");
      }
      return await invokeGateway(...args);
    });

    await expect(runCron(["show", "job-000", "--json"])).rejects.toThrow("exit 1");

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Gateway transport is unavailable"),
    );
    expect(mocks.callGatewayFromCli.mock.calls.some(([method]) => method === "cron.list")).toBe(
      false,
    );
  });
});
