import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../../cron/types.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";

const callGatewayFromCli = vi.fn();

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

const { loadCronJobForShow } = await import("./register.cron-simple.js");

const opts: GatewayRpcOpts = {} as GatewayRpcOpts;

describe("loadCronJobForShow pagination guard (regression for #83856)", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when nextOffset fails to advance", async () => {
    callGatewayFromCli.mockResolvedValue({
      jobs: [],
      hasMore: true,
      nextOffset: 0,
    });
    await expect(loadCronJobForShow(opts, "missing")).rejects.toThrow(/pagination did not advance/);
    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
  });

  it("throws when pagination exceeds the max page count", async () => {
    let nextOffset = 0;
    callGatewayFromCli.mockImplementation(async () => {
      nextOffset += 1;
      return { jobs: [], hasMore: true, nextOffset };
    });
    await expect(loadCronJobForShow(opts, "missing")).rejects.toThrow(
      /pagination exceeded maximum pages/,
    );
    expect(callGatewayFromCli.mock.calls.length).toBeGreaterThan(1);
    expect(callGatewayFromCli.mock.calls.length).toBeLessThanOrEqual(50);
  });

  it("returns the job when found on a later page", async () => {
    const job: CronJob = { id: "abc", name: "wanted" } as unknown as CronJob;
    callGatewayFromCli
      .mockResolvedValueOnce({ jobs: [], hasMore: true, nextOffset: 200 })
      .mockResolvedValueOnce({ jobs: [job], hasMore: false, nextOffset: null });
    const result = await loadCronJobForShow(opts, "wanted");
    expect(result.job?.id).toBe("abc");
    expect(callGatewayFromCli).toHaveBeenCalledTimes(2);
  });

  it("returns empty result when pagination terminates without a match", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      jobs: [],
      hasMore: false,
      nextOffset: null,
    });
    const result = await loadCronJobForShow(opts, "missing");
    expect(result.job).toBeUndefined();
  });
});
