import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayFromCli = vi.fn();

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

const { registerCronAddCommand } = await import("./register.cron-add.js");

describe("cron add --wake-only", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
    callGatewayFromCli.mockResolvedValue({ ok: true });
  });

  it("creates a client-owned main-session wake payload", async () => {
    const program = new Command().exitOverride();
    registerCronAddCommand(program);

    await program.parseAsync(["add", "--name", "host wake", "--every", "5m", "--wake-only"], {
      from: "user",
    });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.objectContaining({ wakeOnly: true }),
      expect.objectContaining({
        name: "host wake",
        sessionTarget: "main",
        payload: { kind: "wake" },
      }),
    );
  });
});
