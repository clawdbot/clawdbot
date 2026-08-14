// Delivery CLI registration tests cover bounded option forwarding.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  purge: vi.fn(),
  resubmit: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));

vi.mock("../../commands/delivery-failures.js", () => ({
  deliveryFailuresListCommand: mocks.list,
  deliveryFailuresPurgeCommand: mocks.purge,
  deliveryFailuresResubmitCommand: mocks.resubmit,
}));
vi.mock("../../runtime.js", () => ({ defaultRuntime: mocks.runtime }));

const { registerDeliveryCommand } = await import("./register.delivery.js");

describe("registerDeliveryCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.purge.mockResolvedValue(undefined);
    mocks.resubmit.mockResolvedValue(undefined);
  });

  async function run(args: string[]) {
    const program = new Command();
    registerDeliveryCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  it("forwards bounded metadata list options", async () => {
    await run([
      "delivery",
      "failures",
      "list",
      "--queue",
      "session",
      "--limit",
      "500",
      "--exact-ids",
      "--json",
    ]);

    expect(mocks.list).toHaveBeenCalledWith(
      { queue: "session", limit: 500, exactIds: true, json: true },
      mocks.runtime,
    );
  });

  it("forwards explicit purge and resubmit safety flags", async () => {
    await run(["delivery", "failures", "purge", "--apply", "--yes", "--json"]);
    expect(mocks.purge).toHaveBeenCalledWith(
      { queue: undefined, limit: 100, apply: true, yes: true, json: true },
      mocks.runtime,
    );

    await run([
      "delivery",
      "failures",
      "resubmit",
      "failure-id",
      "--queue",
      "session",
      "--url",
      "ws://127.0.0.1:18789",
      "--token",
      "token",
      "--password",
      "password",
      "--timeout",
      "5000",
      "--json",
    ]);
    expect(mocks.resubmit).toHaveBeenCalledWith(
      "failure-id",
      {
        queue: "session",
        url: "ws://127.0.0.1:18789",
        token: "token",
        password: "password",
        timeout: "5000",
        json: true,
        exactIds: false,
      },
      mocks.runtime,
    );
  });
});
