import { beforeEach, describe, expect, it, vi } from "vitest";

const messageCommand = vi.fn();
const statusCommand = vi.fn();
const configureCommand = vi.fn();
const configureCommandWithSections = vi.fn();
const setupCommand = vi.fn();
const onboardCommand = vi.fn();
const callGateway = vi.fn();
const runChannelLogin = vi.fn();
const runChannelLogout = vi.fn();
const runTui = vi.fn();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

vi.mock("../commands/message.js", () => ({ messageCommand }));
vi.mock("../commands/status.js", () => ({ statusCommand }));
vi.mock("../commands/configure.js", () => ({
  CONFIGURE_WIZARD_SECTIONS: [
    "workspace",
    "model",
    "web",
    "gateway",
    "daemon",
    "channels",
    "skills",
    "health",
  ],
  configureCommand,
  configureCommandWithSections,
}));
vi.mock("../commands/setup.js", () => ({ setupCommand }));
vi.mock("../commands/onboard.js", () => ({ onboardCommand }));
vi.mock("../runtime.js", () => ({ defaultRuntime: runtime }));
vi.mock("./channel-auth.js", () => ({ runChannelLogin, runChannelLogout }));
vi.mock("../tui/tui.js", () => ({ runTui }));
vi.mock("../gateway/call.js", () => ({
  callGateway,
  randomIdempotencyKey: () => "idem-test",
}));
vi.mock("./deps.js", () => ({ createDefaultDeps: () => ({}) }));

const { buildProgram } = await import("./program.js");

describe("cli program (smoke)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runTui.mockResolvedValue(undefined);
  });

  it("runs message with required options", async () => {
    const program = buildProgram();
    await program.parseAsync(["message", "send", "--to", "+1", "--message", "hi"], {
      from: "user",
    });
    expect(messageCommand).toHaveBeenCalled();
  });

  it("runs status command", async () => {
    const program = buildProgram();
    await program.parseAsync(["status"], { from: "user" });
    expect(statusCommand).toHaveBeenCalled();
  });

  it("runs tui without overriding timeout", async () => {
    const program = buildProgram();
    await program.parseAsync(["tui"], { from: "user" });
    expect(runTui).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: undefined }));
  });

  it("runs tui with explicit timeout override", async () => {
    const program = buildProgram();
    await program.parseAsync(["tui", "--timeout-ms", "45000"], {
      from: "user",
    });
    expect(runTui).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 45000 }));
  });

  it("warns and ignores invalid tui timeout override", async () => {
    const program = buildProgram();
    await program.parseAsync(["tui", "--timeout-ms", "nope"], { from: "user" });
    expect(runtime.error).toHaveBeenCalledWith('warning: invalid --timeout-ms "nope"; ignoring');
    expect(runTui).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: undefined }));
  });

  it("runs config alias as configure", async () => {
    const program = buildProgram();
    await program.parseAsync(["config"], { from: "user" });
    expect(configureCommand).toHaveBeenCalled();
  });

  it("runs setup without wizard flags", async () => {
    const program = buildProgram();
    await program.parseAsync(["setup"], { from: "user" });
    expect(setupCommand).toHaveBeenCalled();
    expect(onboardCommand).not.toHaveBeenCalled();
  });

  it("runs setup wizard when wizard flags are present", async () => {
    const program = buildProgram();
    await program.parseAsync(["setup", "--remote-url", "ws://example"], {
      from: "user",
    });
    expect(onboardCommand).toHaveBeenCalled();
    expect(setupCommand).not.toHaveBeenCalled();
  });

  it("passes opencode-zen api key to onboard", async () => {
    const program = buildProgram();
    await program.parseAsync(
      [
        "onboard",
        "--non-interactive",
        "--auth-choice",
        "opencode-zen",
        "--opencode-zen-api-key",
        "sk-opencode-zen-test",
      ],
      { from: "user" },
    );
    expect(onboardCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        nonInteractive: true,
        authChoice: "opencode-zen",
        opencodeZenApiKey: "sk-opencode-zen-test",
      }),
      runtime,
    );
  });

  it("passes openrouter api key to onboard", async () => {
    const program = buildProgram();
    await program.parseAsync(
      [
        "onboard",
        "--non-interactive",
        "--auth-choice",
        "openrouter-api-key",
        "--openrouter-api-key",
        "sk-openrouter-test",
      ],
      { from: "user" },
    );
    expect(onboardCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        nonInteractive: true,
        authChoice: "openrouter-api-key",
        openrouterApiKey: "sk-openrouter-test",
      }),
      runtime,
    );
  });

  it("passes moonshot api key to onboard", async () => {
    const program = buildProgram();
    await program.parseAsync(
      [
        "onboard",
        "--non-interactive",
        "--auth-choice",
        "moonshot-api-key",
        "--moonshot-api-key",
        "sk-moonshot-test",
      ],
      { from: "user" },
    );
    expect(onboardCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        nonInteractive: true,
        authChoice: "moonshot-api-key",
        moonshotApiKey: "sk-moonshot-test",
      }),
      runtime,
    );
  });

  it("passes synthetic api key to onboard", async () => {
    const program = buildProgram();
    await program.parseAsync(
      [
        "onboard",
        "--non-interactive",
        "--auth-choice",
        "synthetic-api-key",
        "--synthetic-api-key",
        "sk-synthetic-test",
      ],
      { from: "user" },
    );
    expect(onboardCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        nonInteractive: true,
        authChoice: "synthetic-api-key",
        syntheticApiKey: "sk-synthetic-test",
      }),
      runtime,
    );
  });

  it("passes zai api key to onboard", async () => {
    const program = buildProgram();
    await program.parseAsync(
      [
        "onboard",
        "--non-interactive",
        "--auth-choice",
        "zai-api-key",
        "--zai-api-key",
        "sk-zai-test",
      ],
      { from: "user" },
    );
    expect(onboardCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        nonInteractive: true,
        authChoice: "zai-api-key",
        zaiApiKey: "sk-zai-test",
      }),
      runtime,
    );
  });

  it("runs channels login", async () => {
    const program = buildProgram();
    await program.parseAsync(["channels", "login", "--account", "work"], {
      from: "user",
    });
    expect(runChannelLogin).toHaveBeenCalledWith(
      { channel: undefined, account: "work", verbose: false },
      runtime,
    );
  });

  it("runs channels logout", async () => {
    const program = buildProgram();
    await program.parseAsync(["channels", "logout", "--account", "work"], {
      from: "user",
    });
    expect(runChannelLogout).toHaveBeenCalledWith({ channel: undefined, account: "work" }, runtime);
  });
});
