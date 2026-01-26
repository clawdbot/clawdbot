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
  buildGatewayConnectionDetails: () => ({
    url: "ws://127.0.0.1:1234",
    urlSource: "test",
    message: "Gateway target: ws://127.0.0.1:1234",
  }),
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
    await program.parseAsync(["message", "send", "--target", "+1", "--message", "hi"], {
      from: "user",
    });
    expect(messageCommand).toHaveBeenCalled();
  });

  it("runs message react with signal author fields", async () => {
    const program = buildProgram();
    await program.parseAsync(
      [
        "message",
        "react",
        "--channel",
        "signal",
        "--target",
        "signal:group:abc123",
        "--message-id",
        "1737630212345",
        "--emoji",
        "✅",
        "--target-author-uuid",
        "123e4567-e89b-12d3-a456-426614174000",
      ],
      { from: "user" },
    );
    expect(messageCommand).toHaveBeenCalled();
  });

  it("runs status command", async () => {
    const program = buildProgram();
    await program.parseAsync(["status"], { from: "user" });
    expect(statusCommand).toHaveBeenCalled();
  });

  it("registers memory command", () => {
    const program = buildProgram();
    const names = program.commands.map((command) => command.name());
    expect(names).toContain("memory");
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

  it("passes auth api keys to onboard", async () => {
    const cases = [
      {
        authChoice: "opencode-zen",
        flag: "--opencode-zen-api-key",
        key: "sk-opencode-zen-test",
        field: "opencodeZenApiKey",
      },
      {
        authChoice: "openrouter-api-key",
        flag: "--openrouter-api-key",
        key: "sk-openrouter-test",
        field: "openrouterApiKey",
      },
      {
        authChoice: "moonshot-api-key",
        flag: "--moonshot-api-key",
        key: "sk-moonshot-test",
        field: "moonshotApiKey",
      },
      {
        authChoice: "kimi-code-api-key",
        flag: "--kimi-code-api-key",
        key: "sk-kimi-code-test",
        field: "kimiCodeApiKey",
      },
      {
        authChoice: "synthetic-api-key",
        flag: "--synthetic-api-key",
        key: "sk-synthetic-test",
        field: "syntheticApiKey",
      },
      {
        authChoice: "zai-api-key",
        flag: "--zai-api-key",
        key: "sk-zai-test",
        field: "zaiApiKey",
      },
    ] as const;

    for (const entry of cases) {
      const program = buildProgram();
      await program.parseAsync(
        ["onboard", "--non-interactive", "--auth-choice", entry.authChoice, entry.flag, entry.key],
        { from: "user" },
      );
      expect(onboardCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          nonInteractive: true,
          authChoice: entry.authChoice,
          [entry.field]: entry.key,
        }),
        runtime,
      );
      onboardCommand.mockClear();
    }
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
