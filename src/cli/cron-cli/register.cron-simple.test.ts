// Cron simple register tests cover basic cron command registration and execution.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../../cron/types.js";
import { defaultRuntime } from "../../runtime.js";

const callGatewayFromCli = vi.fn();

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

const { registerCronSimpleCommands } = await import("./register.cron-simple.js");

async function runCronShow(id: string): Promise<void> {
  const cron = new Command();
  registerCronSimpleCommands(cron);
  await cron.parseAsync(["show", id, "--json"], { from: "user" });
}

describe("cron show pagination guard (regression for #83856)", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
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
    await expect(runCronShow("missing")).rejects.toThrow("exit 1");
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("pagination did not advance"),
    );
    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
  });

  it("throws when pagination exceeds the max page count", async () => {
    let nextOffset = 0;
    callGatewayFromCli.mockImplementation(async () => {
      nextOffset += 1;
      return { jobs: [], hasMore: true, nextOffset };
    });
    await expect(runCronShow("missing")).rejects.toThrow("exit 1");
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("pagination exceeded maximum pages"),
    );
    expect(callGatewayFromCli.mock.calls.length).toBeGreaterThan(1);
    expect(callGatewayFromCli.mock.calls.length).toBeLessThanOrEqual(50);
  });

  it("returns the job when found on a later page", async () => {
    const job: CronJob = { id: "abc", name: "wanted" } as unknown as CronJob;
    callGatewayFromCli
      .mockResolvedValueOnce({ jobs: [], hasMore: true, nextOffset: 200 })
      .mockResolvedValueOnce({ jobs: [job], hasMore: false, nextOffset: null });
    await runCronShow("wanted");
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(expect.objectContaining({ id: "abc" }));
    expect(callGatewayFromCli).toHaveBeenCalledTimes(2);
  });

  it("returns empty result when pagination terminates without a match", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      jobs: [],
      hasMore: false,
      nextOffset: null,
    });
    await expect(runCronShow("missing")).rejects.toThrow("exit 1");
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("cron job not found: missing"),
    );
  });
});
