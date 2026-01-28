import { Command } from "commander";
import { describe, expect, it, vi, beforeEach } from "vitest";

const setConfigOverride = vi.fn();
const loadConfig = vi.fn(() => ({ gateway: { mode: "local" } }));
const startGatewayServer = vi.fn(async () => ({
  close: vi.fn(async () => {}),
}));

const defaultRuntime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: (code: number) => {
    throw new Error(`__exit__:${code}`);
  },
};

vi.mock("../../config/config.js", () => ({
  CONFIG_PATH: "/tmp/moltbot.json",
  STATE_DIR: "/tmp/.clawdbot",
  loadConfig: () => loadConfig(),
  readConfigFileSnapshot: async () => ({ exists: true, valid: true, config: loadConfig() }),
  resolveGatewayPort: () => 18789,
}));

vi.mock("../../config/runtime-overrides.js", () => ({
  setConfigOverride: (path: string, value: unknown) => setConfigOverride(path, value),
}));

vi.mock("../../gateway/server.js", () => ({
  startGatewayServer: (port: number, opts?: unknown) => startGatewayServer(port, opts),
}));

vi.mock("./run-loop.js", () => ({
  runGatewayLoop: async (params: { start: () => Promise<unknown> }) => {
    await params.start();
  },
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

// Mock other dependencies to avoid side effects
vi.mock("../../globals.js", () => ({
  setVerbose: vi.fn(),
}));
vi.mock("../../gateway/ws-logging.js", () => ({
  setGatewayWsLogStyle: vi.fn(),
}));
vi.mock("../../logging/console.js", () => ({
  setConsoleTimestampPrefix: vi.fn(),
}));

describe("gateway-cli --local-only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies hardening overrides when --local-only is passed", async () => {
    const { registerGatewayCli } = await import("../gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    // We expect it to try to start the server and fail because we don't mock the loop
    // or just check if setConfigOverride was called.
    try {
      await program.parseAsync(["gateway", "--local-only", "--token", "test-token"], {
        from: "user",
      });
    } catch (err) {
      // ignore exit
    }

    expect(setConfigOverride).toHaveBeenCalledWith("update.checkOnStart", false);
    expect(setConfigOverride).toHaveBeenCalledWith("diagnostics.enabled", false);
    expect(setConfigOverride).toHaveBeenCalledWith("agents.defaults.model.fallbacks", []);
    expect(setConfigOverride).toHaveBeenCalledWith("tools.deny", ["group:web", "browser", "skills-install"]);
    expect(setConfigOverride).toHaveBeenCalledWith("agents.defaults.sandbox.mode", "non-main");
  });

  it("does not apply hardening overrides by default", async () => {
    const { registerGatewayCli } = await import("../gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    try {
      await program.parseAsync(["gateway", "--token", "test-token"], {
        from: "user",
      });
    } catch (err) {
      // ignore exit
    }

    expect(setConfigOverride).not.toHaveBeenCalled();
  });
});
