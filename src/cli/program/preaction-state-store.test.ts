import { Command } from "commander";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliGatewayStateDirOutcome } from "../state-dir-gateway-check.js";

const mocks = vi.hoisted(() => ({
  action: vi.fn(),
  check: vi.fn<() => Promise<CliGatewayStateDirOutcome>>(async () => ({ kind: "allow" })),
  debug: vi.fn(),
  log: vi.fn(),
  ensureBootstrap: vi.fn(async () => {}),
}));

vi.mock("../state-dir-gateway-check.js", () => ({ checkCliGatewayStateDir: mocks.check }));
vi.mock("../../logger.js", () => ({ logDebug: mocks.debug }));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: mocks.log,
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));
vi.mock("../command-execution-startup.js", () => ({
  applyCliExecutionStartupPresentation: vi.fn(async () => {}),
  ensureCliExecutionBootstrap: mocks.ensureBootstrap,
}));

let program: Command;
let originalArgv: string[];

beforeAll(async () => {
  const { registerPreActionHooks } = await import("./preaction.js");
  program = new Command().name("openclaw");
  program.command("configure").action(mocks.action);
  registerPreActionHooks(program, "test");
});

beforeEach(() => {
  originalArgv = [...process.argv];
  vi.clearAllMocks();
  process.argv = ["node", "openclaw", "configure"];
});

afterEach(() => {
  process.argv = originalArgv;
});

describe("state-store preAction guard", () => {
  it("refuses before bootstrap and action", async () => {
    mocks.check.mockResolvedValueOnce({ kind: "refuse", message: "state stores differ" });

    await expect(program.parseAsync(process.argv)).rejects.toThrow("state stores differ");

    expect(mocks.check).toHaveBeenCalledWith({ command: "openclaw configure" });
    expect(mocks.ensureBootstrap).not.toHaveBeenCalled();
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it("allows the action when inspection fails", async () => {
    mocks.check.mockRejectedValueOnce(new Error("inspection failed"));

    await expect(program.parseAsync(process.argv)).resolves.toBe(program);

    expect(mocks.debug).toHaveBeenCalledWith("state-store guard unavailable: inspection failed");
    expect(mocks.action).toHaveBeenCalledOnce();
  });

  it("shows an unknown-path warning while allowing the action", async () => {
    mocks.check.mockResolvedValueOnce({
      kind: "warn",
      message: "Service paths could not be verified.",
    });

    await expect(program.parseAsync(process.argv)).resolves.toBe(program);

    expect(mocks.log).toHaveBeenCalledWith("Service paths could not be verified.");
    expect(mocks.action).toHaveBeenCalledOnce();
  });
});
