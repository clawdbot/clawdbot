import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSetupCommand } from "./register.setup.js";

const mocks = vi.hoisted(() => ({
  setupCommandMock: vi.fn(),
  setupWizardCommandMock: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const setupCommandMock = mocks.setupCommandMock;
const setupWizardCommandMock = mocks.setupWizardCommandMock;
const runtime = mocks.runtime;

function lastSetupOptions(): Record<string, unknown> | undefined {
  const calls = setupCommandMock.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
}

function lastWizardOptions(): Record<string, unknown> | undefined {
  const calls = setupWizardCommandMock.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
}

vi.mock("../../commands/setup.js", () => ({
  setupCommand: mocks.setupCommandMock,
}));

vi.mock("../../commands/onboard.js", () => ({
  setupWizardCommand: mocks.setupWizardCommandMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerSetupCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerSetupCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setupCommandMock.mockResolvedValue(undefined);
    setupWizardCommandMock.mockResolvedValue(undefined);
  });

  it("runs setup command by default", async () => {
    await runCli(["setup", "--workspace", "/tmp/ws"]);

    expect(setupCommandMock).toHaveBeenCalledWith(lastSetupOptions(), runtime);
    expect(lastSetupOptions()?.workspace).toBe("/tmp/ws");
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it("runs setup wizard command when --wizard is set", async () => {
    await runCli(["setup", "--wizard", "--mode", "remote", "--remote-url", "wss://example"]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
    expect(lastWizardOptions()?.mode).toBe("remote");
    expect(lastWizardOptions()?.remoteUrl).toBe("wss://example");
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("runs setup wizard command when wizard-only flags are passed explicitly", async () => {
    await runCli(["setup", "--mode", "remote", "--non-interactive"]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
    expect(lastWizardOptions()?.mode).toBe("remote");
    expect(lastWizardOptions()?.nonInteractive).toBe(true);
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("runs setup wizard command for migration import flags", async () => {
    await runCli([
      "setup",
      "--import-from",
      "hermes",
      "--import-source",
      "/tmp/hermes",
      "--import-secrets",
    ]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
    expect(lastWizardOptions()?.importFrom).toBe("hermes");
    expect(lastWizardOptions()?.importSource).toBe("/tmp/hermes");
    expect(lastWizardOptions()?.importSecrets).toBe(true);
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("reports setup errors through runtime", async () => {
    setupCommandMock.mockRejectedValueOnce(new Error("setup failed"));

    await runCli(["setup"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: setup failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
