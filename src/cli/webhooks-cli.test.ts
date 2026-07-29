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
    mocks.runtimeErrors.length = 0;
    mocks.defaultRuntime.error.mockClear();
    mocks.defaultRuntime.exit.mockClear();
    mocks.runGmailSetup.mockClear();
    mocks.runGmailService.mockClear();
  });

  it.each([
    ["setup", "--port", "8080x"],
    ["setup", "--max-bytes", "10mb"],
    ["setup", "--renew-minutes", "30m"],
    ["run", "--port", "8080x"],
    ["run", "--max-bytes", "10mb"],
    ["run", "--renew-minutes", "30m"],
  ])("rejects partial gmail %s %s", async (command, flag, value) => {
    const program = createProgram();
    const args =
      command === "setup"
        ? ["webhooks", "gmail", command, "--account", "default", flag, value]
        : ["webhooks", "gmail", command, flag, value];

    await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow("__exit__:1");

    expect(runtimeErrors().join("\n")).toContain(`${flag} must be a positive integer.`);
    expect(mocks.runGmailSetup).not.toHaveBeenCalled();
    expect(mocks.runGmailService).not.toHaveBeenCalled();
  });
});
