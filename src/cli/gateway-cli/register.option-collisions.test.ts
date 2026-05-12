import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerGatewayCli } from "./register.js";

const mocks = vi.hoisted(() => ({
  callGatewayCli: vi.fn(async (_method: string, _opts: unknown, _params?: unknown) => ({
    ok: true,
  })),
  gatewayStatusCommand: vi.fn(async (_opts: unknown, _runtime: unknown) => {}),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

const { callGatewayCli, gatewayStatusCommand, defaultRuntime } = mocks;

vi.mock("../cli-utils.js", () => ({
  runCommandWithRuntime: async (
    _runtime: unknown,
    action: () => Promise<void>,
    onError: (err: unknown) => void,
  ) => {
    try {
      await action();
    } catch (err) {
      onError(err);
    }
  },
}));

vi.mock("../../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../../runtime.js")>("../../runtime.js")),
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../../commands/gateway-status.js", () => ({
  gatewayStatusCommand: (opts: unknown, runtime: unknown) =>
    mocks.gatewayStatusCommand(opts, runtime),
}));

vi.mock("./call.js", () => ({
  gatewayCallOpts: (cmd: Command) =>
    cmd
      .option("--url <url>", "Gateway WebSocket URL")
      .option("--token <token>", "Gateway token")
      .option("--password <password>", "Gateway password")
      .option("--timeout <ms>", "Timeout in ms", "10000")
      .option("--expect-final", "Wait for final response (agent)", false)
      .option("--json", "Output JSON", false),
  callGatewayCli: (method: string, opts: unknown, params?: unknown) =>
    mocks.callGatewayCli(method, opts, params),
}));

vi.mock("./run.js", () => ({
  addGatewayRunCommand: (cmd: Command) =>
    cmd
      .option("--token <token>", "Gateway token")
      .option("--password <password>", "Gateway password"),
}));

vi.mock("../daemon-cli/register-service-commands.js", () => ({
  addGatewayServiceCommands: () => undefined,
}));

vi.mock("../../commands/health.js", () => ({
  formatHealthChannelLines: () => [],
}));

vi.mock("../../config/read-best-effort-config.runtime.js", () => ({
  readBestEffortConfig: async () => ({}),
  readSourceConfigBestEffort: async () => ({}),
}));

vi.mock("../../infra/bonjour-discovery.js", () => ({
  discoverGatewayBeacons: async () => [],
}));

vi.mock("../../infra/widearea-dns.js", () => ({
  resolveWideAreaDiscoveryDomain: () => undefined,
}));

vi.mock("../../terminal/health-style.js", () => ({
  styleHealthChannelLine: (line: string) => line,
}));

vi.mock("../../terminal/links.js", () => ({
  formatDocsLink: () => "docs.openclaw.ai/cli/gateway",
}));

vi.mock("../../terminal/theme.js", () => ({
  colorize: (_rich: boolean, _fn: (value: string) => string, value: string) => value,
  isRich: () => false,
  theme: {
    heading: (value: string) => value,
    muted: (value: string) => value,
    success: (value: string) => value,
  },
}));

vi.mock("../../utils/usage-format.js", () => ({
  formatTokenCount: () => "0",
  formatUsd: () => "$0.00",
}));

vi.mock("../help-format.js", () => ({
  formatHelpExamples: () => "",
}));

vi.mock("../progress.js", () => ({
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));

vi.mock("./discover.js", () => ({
  dedupeBeacons: (beacons: unknown[]) => beacons,
  parseDiscoverTimeoutMs: () => 2000,
  pickBeaconHost: () => null,
  pickGatewayPort: () => 18789,
  renderBeaconLines: () => [],
}));

describe("gateway register option collisions", () => {
  let sharedProgram: Command = new Command();

  if (sharedProgram.commands.length === 0) {
    sharedProgram.exitOverride();
    registerGatewayCli(sharedProgram);
  }

  beforeEach(() => {
    callGatewayCli.mockClear();
    gatewayStatusCommand.mockClear();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it.each([
    {
      name: "forwards --token to gateway call when parent and child option names collide",
      argv: ["gateway", "call", "health", "--token", "tok_call", "--json"],
      assert: () => {
        expect(callGatewayCli).toHaveBeenCalledTimes(1);
        const [method, opts, params] = callGatewayCli.mock.calls.at(0) ?? [];
        expect(method).toBe("health");
        expect((opts as { token?: string } | undefined)?.token).toBe("tok_call");
        expect(params).toEqual({});
      },
    },
    {
      name: "forwards --token to gateway probe when parent and child option names collide",
      argv: ["gateway", "probe", "--token", "tok_probe", "--json"],
      assert: () => {
        expect(gatewayStatusCommand).toHaveBeenCalledTimes(1);
        const [opts, runtime] = gatewayStatusCommand.mock.calls.at(0) ?? [];
        expect((opts as { token?: string } | undefined)?.token).toBe("tok_probe");
        expect(runtime).toBe(defaultRuntime);
      },
    },
  ])("$name", async ({ argv, assert }) => {
    await sharedProgram.parseAsync(argv, { from: "user" });
    assert();
  });
});
