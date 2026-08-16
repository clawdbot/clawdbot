// Webhooks CLI tests cover webhook command registration and option parsing.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerWebhooksCli } from "./webhooks-cli.js";

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return {
    ...createCliRuntimeMock(vi),
    runGmailSetup: vi.fn(),
    runGmailService: vi.fn(),
  };
});

vi.mock("../hooks/gmail-ops.js", () => ({
  runGmailSetup: mocks.runGmailSetup,
  runGmailService: mocks.runGmailService,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerWebhooksCli(program);
  return program;
}

function runtimeErrors(): string[] {
  return mocks.defaultRuntime.error.mock.calls.map(([message]) => String(message));
}

describe("webhooks cli", () => {
  beforeEach(() => {
    mocks.runtimeLogs.length = 0;
    mocks.runtimeErrors.length = 0;
    mocks.defaultRuntime.error.mockClear();
    mocks.defaultRuntime.writeJson.mockClear();
    mocks.defaultRuntime.exit.mockClear();
    mocks.runGmailSetup.mockClear();
    mocks.runGmailService.mockClear();
  });

  it.each([
    ["setup", "--port", "8080x", true],
    ["setup", "--max-bytes", "10mb"],
    ["setup", "--renew-minutes", "30m"],
    ["run", "--port", "8080x"],
    ["run", "--max-bytes", "10mb"],
    ["run", "--renew-minutes", "30m"],
  ])("rejects partial gmail %s %s", async (command, flag, value, json = false) => {
    const program = createProgram();
    const args =
      command === "setup"
        ? ["webhooks", "gmail", command, "--account", "default", flag, value]
        : ["webhooks", "gmail", command, flag, value];
    if (json) {
      args.push("--json");
    }

    await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow("__exit__:1");

    if (json) {
      expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith({
        error: `${flag} must be a positive integer.`,
      });
      expect(mocks.defaultRuntime.error).not.toHaveBeenCalled();
    } else {
      expect(runtimeErrors().join("\n")).toContain(`${flag} must be a positive integer.`);
    }
    expect(mocks.runGmailSetup).not.toHaveBeenCalled();
    expect(mocks.runGmailService).not.toHaveBeenCalled();
  });

  it.each([
    { command: "setup", mode: "human", json: false },
    { command: "setup", mode: "JSON", json: true },
    { command: "run", mode: "human", json: false },
  ])("renders named gmail $command errors safely in $mode mode", async ({ command, json }) => {
    const secret = "sk-abcdefghijklmnopqrstuv";
    const error = new Error(`Gmail failed: Authorization: Bearer ${secret}`);
    error.name = "GmailCredentialError";
    const runner = command === "setup" ? mocks.runGmailSetup : mocks.runGmailService;
    runner.mockRejectedValueOnce(error);
    const program = createProgram();
    const args =
      command === "setup"
        ? ["webhooks", "gmail", "setup", "--account", "default"]
        : ["webhooks", "gmail", "run"];
    if (json) {
      args.push("--json");
    }

    await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow("__exit__:1");

    expect(runner).toHaveBeenCalledOnce();
    if (json) {
      const payload = JSON.parse(mocks.runtimeLogs.at(-1) ?? "");
      expect(payload).toEqual({
        error: expect.stringContaining("Gmail failed: Authorization: Bearer"),
      });
      expect(mocks.defaultRuntime.error).not.toHaveBeenCalled();
    } else {
      expect(runtimeErrors()).toEqual([
        expect.stringContaining("Gmail failed: Authorization: Bearer"),
      ]);
      expect(mocks.defaultRuntime.writeJson).not.toHaveBeenCalled();
    }
    expect([...mocks.runtimeLogs, ...runtimeErrors()].join("\n")).not.toContain(error.name);
    expect([...mocks.runtimeLogs, ...runtimeErrors()].join("\n")).not.toContain(secret);
    expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    ["setup", "offf"],
    ["setup", ""],
    ["setup", " "],
    ["run", "offf"],
    ["run", ""],
    ["run", " "],
  ])("rejects invalid gmail %s --tailscale mode %j", async (command, mode) => {
    const program = createProgram();
    const args =
      command === "setup"
        ? ["webhooks", "gmail", command, "--account", "default", "--tailscale", mode]
        : ["webhooks", "gmail", command, "--tailscale", mode];

    await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow("__exit__:1");

    expect(runtimeErrors().join("\n")).toContain(
      "Invalid --tailscale (must be funnel, serve, or off).",
    );
    expect(mocks.runGmailSetup).not.toHaveBeenCalled();
    expect(mocks.runGmailService).not.toHaveBeenCalled();
  });

  it.each([
    ["setup", "funnel"],
    ["setup", "serve"],
    ["setup", "off"],
    ["run", "funnel"],
    ["run", "serve"],
    ["run", "off"],
  ])("accepts valid gmail %s --tailscale %s", async (command, mode) => {
    const program = createProgram();
    const args =
      command === "setup"
        ? ["webhooks", "gmail", command, "--account", "default", "--tailscale", mode]
        : ["webhooks", "gmail", command, "--tailscale", mode];

    await program.parseAsync(args, { from: "user" });

    const runner = command === "setup" ? mocks.runGmailSetup : mocks.runGmailService;
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ tailscale: mode }));
  });

  it("preserves an omitted gmail run --tailscale mode", async () => {
    const program = createProgram();

    await program.parseAsync(["webhooks", "gmail", "run"], { from: "user" });

    expect(mocks.runGmailService).toHaveBeenCalledWith(
      expect.objectContaining({ tailscale: undefined }),
    );
  });
});
