import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { callGatewayFromCli } from "../cli/gateway-rpc.js";
import { registerMeetingPluginCli } from "./plugin-cli.js";
import type { MeetingPluginConfig } from "./plugin-config.js";

function createCli(callGateway: typeof callGatewayFromCli) {
  const program = new Command();
  registerMeetingPluginCli({
    callGateway,
    commandName: "testmeetings",
    config: {} as MeetingPluginConfig,
    descriptions: {
      root: "test meetings",
      join: "join",
      leave: "leave",
      status: "status",
      setup: "setup",
      testSpeech: "test speech",
      testListen: "test listen",
    },
    methodPrefix: "testmeetings",
    program,
    resolveGatewayTimeoutMs: () => 1_000,
  });
  return program;
}

describe("meeting plugin CLI options", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("rejects misspelled setup modes and transports before gateway dispatch", async () => {
    const callGateway = vi.fn();
    const cli = createCli(callGateway as unknown as typeof callGatewayFromCli);

    await expect(
      cli.parseAsync(["testmeetings", "setup", "--mode", "agnt"], { from: "user" }),
    ).rejects.toThrow("mode must be agent, bidi, or transcribe; received agnt");
    await expect(
      cli.parseAsync(["testmeetings", "setup", "--transport", "definitely-not-a-transport"], {
        from: "user",
      }),
    ).rejects.toThrow(
      "transport must be chrome or chrome-node; received definitely-not-a-transport",
    );
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("sets a failing process exit code for unhealthy setup status", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const callGateway = vi.fn(async () => ({ ok: false, checks: [] }));

    await createCli(callGateway as unknown as typeof callGatewayFromCli).parseAsync(
      ["testmeetings", "setup"],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });
});
