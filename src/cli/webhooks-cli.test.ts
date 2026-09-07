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

    if (json) {
      await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow(
        `${flag} must be a positive integer.`,
      );
      expect(mocks.defaultRuntime.writeJson).not.toHaveBeenCalled();
      expect(mocks.defaultRuntime.error).not.toHaveBeenCalled();
      expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
    } else {
      await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow("__exit__:1");
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

    if (json) {
      await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow(
        "Gmail failed: Authorization: Bearer",
      );
      expect(mocks.defaultRuntime.writeJson).not.toHaveBeenCalled();
      expect(mocks.defaultRuntime.error).not.toHaveBeenCalled();
      expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
    } else {
      await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow("__exit__:1");
      expect(runtimeErrors()).toEqual([
        expect.stringContaining("Gmail failed: Authorization: Bearer"),
      ]);
      expect(mocks.defaultRuntime.writeJson).not.toHaveBeenCalled();
      expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
    }
    expect(runner).toHaveBeenCalledOnce();
    expect([...mocks.runtimeLogs, ...runtimeErrors()].join("\n")).not.toContain(error.name);
    expect([...mocks.runtimeLogs, ...runtimeErrors()].join("\n")).not.toContain(secret);
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

  const omittedCommonOptions = {
    topic: undefined,
    subscription: undefined,
    label: undefined,
    hookUrl: undefined,
    hookToken: undefined,
    pushToken: undefined,
    bind: undefined,
    port: undefined,
    path: undefined,
    includeBody: undefined,
    maxBytes: undefined,
    renewEveryMinutes: undefined,
    tailscale: undefined,
    tailscalePath: undefined,
    tailscaleTarget: undefined,
  };
  const explicitCommonArgs = [
    "--topic",
    " projects/fixture/topics/custom ",
    "--subscription",
    " custom-subscription ",
    "--label",
    " CUSTOM ",
    "--hook-url",
    " https://fixture.invalid/hooks/gmail ",
    "--hook-token",
    " fixture-hook ",
    "--push-token",
    " fixture-push ",
    "--bind",
    " 127.0.0.2 ",
    "--port",
    "9807",
    "--path",
    " /custom-push ",
    "--include-body",
    "--max-bytes",
    "54321",
    "--renew-minutes",
    "29",
    "--tailscale",
    " serve ",
    "--tailscale-path",
    " /public-gmail ",
    "--tailscale-target",
    " http://127.0.0.3:8789 ",
  ];
  const explicitCommonOptions = {
    topic: "projects/fixture/topics/custom",
    subscription: "custom-subscription",
    label: "CUSTOM",
    hookUrl: "https://fixture.invalid/hooks/gmail",
    hookToken: "fixture-hook",
    pushToken: "fixture-push",
    bind: "127.0.0.2",
    port: 9807,
    path: "/custom-push",
    includeBody: true,
    maxBytes: 54321,
    renewEveryMinutes: 29,
    tailscale: "serve",
    tailscalePath: "/public-gmail",
    tailscaleTarget: "http://127.0.0.3:8789",
  };

  it.each([
    {
      name: "setup defaults",
      command: "setup",
      args: ["--account", "fixture@example.invalid"],
      expected: {
        ...omittedCommonOptions,
        account: "fixture@example.invalid",
        project: undefined,
        topic: "gog-gmail-watch",
        subscription: "gog-gmail-watch-push",
        label: "INBOX",
        bind: "127.0.0.1",
        port: 8788,
        path: "/gmail-pubsub",
        includeBody: true,
        maxBytes: 20_000,
        renewEveryMinutes: 720,
        tailscale: "funnel",
        pushEndpoint: undefined,
        json: false,
      },
    },
    {
      name: "run omissions",
      command: "run",
      args: [],
      expected: { account: undefined, ...omittedCommonOptions },
    },
    {
      name: "setup explicit options",
      command: "setup",
      args: [
        "--account",
        " fixture@example.invalid ",
        "--project",
        " fixture-project ",
        "--push-endpoint",
        " https://fixture.invalid/push ",
        "--json",
        ...explicitCommonArgs,
      ],
      expected: {
        account: "fixture@example.invalid",
        project: "fixture-project",
        ...explicitCommonOptions,
        pushEndpoint: "https://fixture.invalid/push",
        json: true,
      },
    },
    {
      name: "run explicit options",
      command: "run",
      args: ["--account", " fixture@example.invalid ", ...explicitCommonArgs],
      expected: { account: "fixture@example.invalid", ...explicitCommonOptions },
    },
  ])("passes $name to the Gmail command owner", async ({ command, args, expected }) => {
    const program = createProgram();

    await program.parseAsync(["webhooks", "gmail", command, ...args], { from: "user" });

    const runner = command === "setup" ? mocks.runGmailSetup : mocks.runGmailService;
    expect(runner).toHaveBeenCalledOnce();
    const actual = runner.mock.calls[0]?.[0];
    for (const key of Object.keys(expected)) {
      expect(Object.hasOwn(actual, key), key).toBe(true);
    }
    expect(actual).toStrictEqual(expected);
  });
});
