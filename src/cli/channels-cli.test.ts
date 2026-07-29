// Channels CLI tests cover channel command registration and option parsing.
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { PluginPackageChannel } from "../plugins/manifest.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  resolveChannelsAddChannelFromArgv,
  resolveChannelsAddOptions,
} from "./channels-cli-add-args.js";
import { registerChannelsCli } from "./channels-cli.js";

const listBundledPackageChannelMetadataMock = vi.hoisted(() =>
  vi.fn<() => readonly PluginPackageChannel[]>(() => []),
);
const listRawChannelPluginCatalogEntriesMock = vi.hoisted(() =>
  vi.fn<() => ChannelPluginCatalogEntry[]>(() => []),
);
const channelsAddCommandMock = vi.hoisted(() => vi.fn(async () => undefined));
const runtimeMock = vi.hoisted(() => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
}));

vi.mock("../plugins/bundled-package-channel-metadata.js", () => ({
  listBundledPackageChannelMetadata: listBundledPackageChannelMetadataMock,
}));

vi.mock("../channels/plugins/catalog.js", () => ({
  listRawChannelPluginCatalogEntries: listRawChannelPluginCatalogEntriesMock,
}));

vi.mock("../commands/channels.js", () => ({
  channelsAddCommand: channelsAddCommandMock,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtimeMock,
}));

function getChannelAddOptionFlags(program: Command): string[] {
  const channels = program.commands.find((command) => command.name() === "channels");
  const add = channels?.commands.find((command) => command.name() === "add");
  return add?.options.map((option) => option.flags) ?? [];
}

function getChannelSubcommandNames(program: Command, parentName: string): string[] {
  const channels = program.commands.find((command) => command.name() === "channels");
  const parent = channels?.commands.find((command) => command.name() === parentName);
  return parent?.commands.map((command) => command.name()) ?? [];
}

async function runChannelsAddCli(args: string[]) {
  const program = new Command().name("openclaw");
  await registerChannelsCli(program, ["node", "openclaw", ...args]);
  await program.parseAsync(args, { from: "user" });
  return program;
}

describe("registerChannelsCli", () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.argv = [...originalArgv];
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("loads channel-specific add options only for channels add invocations", async () => {
    process.argv = ["node", "openclaw", "channels"];
    await registerChannelsCli(new Command().name("openclaw"));

    expect(listBundledPackageChannelMetadataMock).not.toHaveBeenCalled();
    expect(listRawChannelPluginCatalogEntriesMock).not.toHaveBeenCalled();

    process.argv = ["node", "openclaw", "channels", "add", "clickclack", "--help"];
    await registerChannelsCli(new Command().name("openclaw"));

    expect(listBundledPackageChannelMetadataMock).toHaveBeenCalledTimes(1);
    expect(listRawChannelPluginCatalogEntriesMock).toHaveBeenCalledTimes(1);
  });

  it("registers dead-letter inspection and resubmission commands", async () => {
    const program = new Command().name("openclaw");

    await registerChannelsCli(program);

    expect(getChannelSubcommandNames(program, "dead-letters")).toEqual(["list", "resubmit"]);
  });

  it("registers ClickClack setup options before an external channel plugin is installed", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "clickclack",
        cliAddOptions: [
          {
            flags: "--code <code>",
            description: "ClickClack one-time setup code or setup URL",
          },
          {
            flags: "--workspace <workspace>",
            description: "ClickClack workspace id, slug, or name",
          },
        ],
      },
    ]);
    process.argv = ["node", "openclaw", "channels", "add", "clickclack", "--help"];
    const program = new Command().name("openclaw");

    await registerChannelsCli(program);

    expect(getChannelAddOptionFlags(program)).toContain("--code <code>");
    expect(getChannelAddOptionFlags(program)).toContain("--workspace <workspace>");
  });

  it("registers setup options from a non-bundled catalog channel", async () => {
    listRawChannelPluginCatalogEntriesMock.mockReturnValueOnce([
      {
        id: "installed-chat",
        pluginId: "installed-chat",
        origin: "global",
        channel: {
          id: "installed-chat",
          label: "Installed Chat",
          cliAddOptions: [{ flags: "--installed-key <key>", description: "Installed chat key" }],
        },
        meta: {
          id: "installed-chat",
          label: "Installed Chat",
          selectionLabel: "Installed Chat",
          docsPath: "/channels/installed-chat",
          blurb: "Installed test channel.",
        },
        install: { npmSpec: "@openclaw/installed-chat" },
      },
    ]);
    const program = new Command().name("openclaw");

    await registerChannelsCli(program, [
      "node",
      "openclaw",
      "channels",
      "add",
      "--channel",
      "installed-chat",
      "--help",
    ]);

    expect(getChannelAddOptionFlags(program)).toContain("--installed-key <key>");
  });

  it("dedupes options by switch identity across differing value placeholders", async () => {
    listRawChannelPluginCatalogEntriesMock.mockReturnValueOnce([
      {
        id: "chat-a",
        pluginId: "chat-a",
        origin: "global",
        channel: {
          id: "chat-a",
          label: "Chat A",
          cliAddOptions: [
            { flags: "--url <url>", description: "Chat A URL" },
            { flags: "--token <payload>", description: "Chat A token" },
          ],
        },
        meta: {
          id: "chat-a",
          label: "Chat A",
          selectionLabel: "Chat A",
          docsPath: "/channels/chat-a",
          blurb: "Chat A test channel.",
        },
        install: { npmSpec: "@openclaw/chat-a" },
      },
      {
        id: "chat-b",
        pluginId: "chat-b",
        origin: "global",
        channel: {
          id: "chat-b",
          label: "Chat B",
          cliAddOptions: [{ flags: "--url <server>", description: "Chat B server URL" }],
        },
        meta: {
          id: "chat-b",
          label: "Chat B",
          selectionLabel: "Chat B",
          docsPath: "/channels/chat-b",
          blurb: "Chat B test channel.",
        },
        install: { npmSpec: "@openclaw/chat-b" },
      },
    ]);
    const program = new Command().name("openclaw");

    // Commander throws on conflicting switches; registration must survive a
    // plugin redeclaring `--url` with a different placeholder or the static
    // `--token` with a different value name.
    await registerChannelsCli(program, [
      "node",
      "openclaw",
      "channels",
      "add",
      "--channel",
      "chat-a",
      "--help",
    ]);

    const flags = getChannelAddOptionFlags(program);
    expect(flags).toContain("--url <url>");
    expect(flags).not.toContain("--url <server>");
    expect(flags).toContain("--token <payload>");
    expect(flags).not.toContain("--token <token>");
  });

  it("prefers the selected channel's declaration for a shared switch", async () => {
    listRawChannelPluginCatalogEntriesMock.mockReturnValueOnce([
      {
        id: "chat-a",
        pluginId: "chat-a",
        origin: "global",
        channel: {
          id: "chat-a",
          label: "Chat A",
          cliAddOptions: [{ flags: "--url <url>", description: "Chat A URL" }],
        },
        meta: {
          id: "chat-a",
          label: "Chat A",
          selectionLabel: "Chat A",
          docsPath: "/channels/chat-a",
          blurb: "Chat A test channel.",
        },
        install: { npmSpec: "@openclaw/chat-a" },
      },
      {
        id: "chat-b",
        pluginId: "chat-b",
        origin: "global",
        channel: {
          id: "chat-b",
          label: "Chat B",
          cliAddOptions: [{ flags: "--url <server>", description: "Chat B server URL" }],
        },
        meta: {
          id: "chat-b",
          label: "Chat B",
          selectionLabel: "Chat B",
          docsPath: "/channels/chat-b",
          blurb: "Chat B test channel.",
        },
        install: { npmSpec: "@openclaw/chat-b" },
      },
    ]);
    const program = new Command().name("openclaw");

    await registerChannelsCli(program, [
      "node",
      "openclaw",
      "channels",
      "add",
      "--channel",
      "chat-b",
    ]);

    const flags = getChannelAddOptionFlags(program);
    expect(flags).toContain("--url <server>");
    expect(flags).not.toContain("--url <url>");
  });

  it("projects channel-owned setup fields into Commander options", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "signal",
        setup: {
          fields: [
            {
              key: "signalTransport",
              kind: "choice",
              choices: ["external-native", "container"],
              cli: {
                flags: "--signal-transport <kind>",
                description: "Signal transport kind",
              },
            },
            {
              key: "autoDiscover",
              kind: "boolean",
              cli: {
                flags: "--auto-discover",
                negatedFlags: "--no-auto-discover",
                description: "Discover channels automatically",
              },
            },
          ],
        },
      },
    ]);
    process.argv = ["node", "openclaw", "channels", "add", "--channel", "signal", "--help"];
    const program = new Command().name("openclaw");

    await registerChannelsCli(program);

    expect(getChannelAddOptionFlags(program)).toContain("--signal-transport <kind>");
    expect(getChannelAddOptionFlags(program)).toContain("--no-auto-discover");
  });

  it("registers only the positional channel setup options", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "telegram",
        setup: {
          fields: [
            {
              key: "token",
              kind: "string",
              cli: { flags: "--telegram-token <token>", description: "Telegram bot token" },
            },
          ],
        },
      },
      {
        id: "signal",
        setup: {
          fields: [
            {
              key: "signalNumber",
              kind: "string",
              cli: { flags: "--signal-number <e164>", description: "Signal account number" },
            },
          ],
        },
      },
    ]);
    const program = new Command().name("openclaw");

    await registerChannelsCli(program, [
      "node",
      "openclaw",
      "channels",
      "add",
      "telegram",
      "--help",
    ]);

    expect(getChannelAddOptionFlags(program)).toEqual(
      expect.arrayContaining(["--telegram-token <token>"]),
    );
    expect(getChannelAddOptionFlags(program)).not.toEqual(
      expect.arrayContaining(["--signal-number <e164>"]),
    );
  });

  it.each(["--help", "-h"])(
    "keeps generic add help via %s limited to the shared control envelope",
    async (helpFlag) => {
      const program = new Command().name("openclaw");

      await registerChannelsCli(program, ["node", "openclaw", "channels", "add", helpFlag]);

      expect(getChannelAddOptionFlags(program)).toEqual([
        "--channel <name>",
        "--account <id>",
        "--name <name>",
      ]);
      expect(listBundledPackageChannelMetadataMock).not.toHaveBeenCalled();
    },
  );

  it("registers add help when channels reuse a long flag with different placeholders", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "example",
        setup: {
          fields: [
            {
              key: "apiKey",
              kind: "string",
              cli: { flags: "--api-key <token>", description: "Example API key" },
            },
            {
              key: "apiKeyJson",
              kind: "string",
              cli: { flags: "--api-key <json>", description: "Example API key JSON" },
            },
          ],
        },
      },
    ]);
    process.argv = ["node", "openclaw", "channels", "add", "example", "--help"];
    const program = new Command().name("openclaw");

    await registerChannelsCli(program);

    expect(
      getChannelAddOptionFlags(program).filter((flags) => flags.startsWith("--api-key ")),
    ).toHaveLength(1);
  });

  it("forwards only explicitly supplied setup options", () => {
    const sources = new Map<string, "cli" | "default">([
      ["channel", "cli"],
      ["signalTransport", "cli"],
      ["useEnv", "default"],
    ]);

    expect(
      resolveChannelsAddOptions(
        undefined,
        { channel: "signal", signalTransport: "container", useEnv: false },
        {
          getOptionValueSource: (key) => sources.get(key),
        } as Pick<Command, "getOptionValueSource">,
      ),
    ).toEqual({ channel: "signal", signalTransport: "container" });
  });

  it("preserves selected legacy channel defaults", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "legacy-chat",
        cliAddOptions: [
          {
            flags: "--legacy-mode <mode>",
            description: "Legacy transport mode",
            defaultValue: "socket",
          },
        ],
      },
    ]);

    const program = await runChannelsAddCli([
      "channels",
      "add",
      "--channel",
      "legacy-chat",
      "--token",
      "test-token",
    ]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "legacy-chat",
        legacyMode: "socket",
        token: "test-token",
        useEnv: false,
      }),
      runtimeMock,
      { hasFlags: true },
    );
    expect(getChannelAddOptionFlags(program)).not.toContain("--secret-file <path>");
    expect(getChannelAddOptionFlags(program)).not.toContain("--workspace <workspace>");
  });

  it("uses caller argv instead of raw process argv for channel-specific add options", async () => {
    process.argv = ["node", "openclaw", "channels"];

    await registerChannelsCli(new Command().name("openclaw"), [
      "node",
      "openclaw",
      "channels",
      "add",
      "telegram",
      "--help",
    ]);

    expect(listBundledPackageChannelMetadataMock).toHaveBeenCalledTimes(1);
  });

  it("can force channel-specific add options for completion generation", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "matrix",
        cliAddOptions: [{ flags: "--homeserver <url>", description: "Matrix homeserver URL" }],
      },
    ]);
    process.argv = ["node", "openclaw", "completion", "--write-state"];
    const program = new Command().name("openclaw");

    await registerChannelsCli(program, process.argv, { includeSetupOptions: true });

    expect(listBundledPackageChannelMetadataMock).toHaveBeenCalledTimes(1);
    expect(getChannelAddOptionFlags(program)).toContain("--homeserver <url>");
  });

  it("normalizes Windows launcher argv before channel-specific add option gating", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "matrix",
        cliAddOptions: [{ flags: "--homeserver <url>", description: "Matrix homeserver URL" }],
      },
    ]);
    mockProcessPlatform("win32");
    process.argv = [
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\repo\\openclaw.js",
      "C:\\Program Files\\nodejs\\node.exe",
      "channels",
      "add",
      "--channel",
      "matrix",
      "--homeserver",
      "https://matrix.example.org",
    ];
    const program = new Command().name("openclaw");

    await registerChannelsCli(program);

    expect(listBundledPackageChannelMetadataMock).toHaveBeenCalledTimes(1);
    expect(getChannelAddOptionFlags(program)).toContain("--homeserver <url>");
  });

  it.each([
    ["positional", ["channels", "add", "telegram"]],
    ["--channel", ["channels", "add", "--channel", "telegram"]],
  ])("keeps selection-only %s channel adds on the guided path", async (_label, args) => {
    await runChannelsAddCli(args);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram" }),
      runtimeMock,
      { hasFlags: false },
    );
  });

  it.each([
    ["token", ["--token", "test-token"]],
    ["token file", ["--token-file", "/tmp/test-token"]],
    ["environment", ["--use-env"]],
    ["account", ["--account", "work"]],
  ])("keeps explicit %s inputs on the direct path", async (_label, extraArgs) => {
    await runChannelsAddCli(["channels", "add", "--channel", "telegram", ...extraArgs]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram" }),
      runtimeMock,
      { hasFlags: true },
    );
  });

  it("registers selected-channel options before Commander parses option-first argv", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "telegram",
        setup: {
          fields: [
            {
              key: "token",
              kind: "string",
              cli: { flags: "--token <token>", description: "Telegram bot token" },
            },
          ],
        },
      },
    ]);

    await runChannelsAddCli(["channels", "add", "--token", "test-token", "--channel", "telegram"]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", token: "test-token" }),
      runtimeMock,
      { hasFlags: true },
    );
  });

  it("prefers modern contract options when a channel also publishes cliAddOptions", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValue([
      {
        id: "telegram",
        setup: {
          fields: [
            {
              key: "token",
              kind: "string",
              cli: { flags: "--token <token>", description: "Telegram bot token" },
            },
          ],
        },
        cliAddOptions: [{ flags: "--legacy-token <token>", description: "Retained legacy switch" }],
      },
    ]);

    const program = new Command().name("openclaw");
    const argv = ["channels", "add", "telegram", "--token", "test-token"];
    await registerChannelsCli(program, ["node", "openclaw", ...argv]);
    const flags = getChannelAddOptionFlags(program);
    expect(flags).toContain("--token <token>");
    expect(flags).not.toContain("--legacy-token <token>");

    await program.parseAsync(argv, { from: "user" });
    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", token: "test-token" }),
      runtimeMock,
      { hasFlags: true },
    );
  });

  it("resolves a positional channel after a value-taking channel option", async () => {
    const metadata: PluginPackageChannel[] = [
      {
        id: "telegram",
        setup: {
          fields: [
            {
              key: "token",
              kind: "string",
              cli: { flags: "--token <token>", description: "Telegram bot token" },
            },
          ],
        },
      },
    ];
    listBundledPackageChannelMetadataMock
      .mockReturnValueOnce(metadata)
      .mockReturnValueOnce(metadata);

    await runChannelsAddCli(["channels", "add", "--token", "tok", "telegram"]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", token: "tok" }),
      runtimeMock,
      { hasFlags: true },
    );
  });

  it("resolves a positional channel after a boolean channel option", async () => {
    const metadata: PluginPackageChannel[] = [
      {
        id: "telegram",
        setup: {
          fields: [
            {
              key: "useEnv",
              kind: "boolean",
              cli: { flags: "--use-env", description: "Use Telegram environment credentials" },
            },
          ],
        },
      },
    ];
    listBundledPackageChannelMetadataMock
      .mockReturnValueOnce(metadata)
      .mockReturnValueOnce(metadata);

    await runChannelsAddCli(["channels", "add", "--use-env", "telegram"]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", useEnv: true }),
      runtimeMock,
      { hasFlags: true },
    );
  });

  it("keeps an all-channel-unknown flag before a positional channel ambiguous", async () => {
    await expect(
      resolveChannelsAddChannelFromArgv([
        "node",
        "openclaw",
        "channels",
        "add",
        "--unknown-option",
        "value",
        "telegram",
      ]),
    ).resolves.toBeUndefined();
  });

  it("keeps conflicting all-channel flag arities before a positional channel ambiguous", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "chat-a",
        setup: {
          fields: [
            {
              key: "mode",
              kind: "string",
              cli: { flags: "--mode <mode>", description: "Chat A mode" },
            },
          ],
        },
      },
      {
        id: "chat-b",
        setup: {
          fields: [
            {
              key: "mode",
              kind: "boolean",
              cli: { flags: "--mode", description: "Enable Chat B mode" },
            },
          ],
        },
      },
    ]);

    await expect(
      resolveChannelsAddChannelFromArgv([
        "node",
        "openclaw",
        "channels",
        "add",
        "--mode",
        "telegram",
      ]),
    ).resolves.toBeUndefined();
  });

  it("finds a positional channel after shared option-value pairs", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "telegram",
        setup: {
          fields: [
            {
              key: "token",
              kind: "string",
              cli: { flags: "--token <token>", description: "Telegram bot token" },
            },
          ],
        },
      },
    ]);

    await runChannelsAddCli(["channels", "add", "--account", "work", "telegram", "--token", "tok"]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", account: "work", token: "tok" }),
      runtimeMock,
      { hasFlags: true },
    );
  });

  it("lets an explicit channel override the positional channel during option registration", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "telegram",
        setup: {
          fields: [
            {
              key: "token",
              kind: "string",
              cli: { flags: "--token <token>", description: "Telegram bot token" },
            },
          ],
        },
      },
      {
        id: "signal",
        setup: {
          fields: [
            {
              key: "signalNumber",
              kind: "string",
              cli: { flags: "--signal-number <e164>", description: "Signal account number" },
            },
          ],
        },
      },
    ]);

    await runChannelsAddCli([
      "channels",
      "add",
      "telegram",
      "--channel",
      "signal",
      "--signal-number",
      "+15555550123",
    ]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "signal", signalNumber: "+15555550123" }),
      runtimeMock,
      { hasFlags: true },
    );
  });

  it("treats plugin-provided config flags as direct automation inputs", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "matrix",
        cliAddOptions: [{ flags: "--homeserver <url>", description: "Matrix homeserver URL" }],
      },
    ]);

    await runChannelsAddCli([
      "channels",
      "add",
      "--channel",
      "matrix",
      "--homeserver",
      "https://matrix.example.org",
    ]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "matrix", homeserver: "https://matrix.example.org" }),
      runtimeMock,
      { hasFlags: true },
    );
  });
});
