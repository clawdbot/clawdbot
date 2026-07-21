// Channels CLI tests cover channel command registration and option parsing.
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { PluginPackageChannel } from "../plugins/manifest.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
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

    process.argv = ["node", "openclaw", "channels", "add", "--help"];
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
    process.argv = ["node", "openclaw", "channels", "add", "--help"];
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

    await registerChannelsCli(program, ["node", "openclaw", "channels", "add", "--help"]);

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
    await registerChannelsCli(program, ["node", "openclaw", "channels", "add", "--help"]);

    const flags = getChannelAddOptionFlags(program);
    expect(flags).toContain("--url <url>");
    expect(flags).not.toContain("--url <server>");
    expect(flags).toContain("--token <token>");
    expect(flags).not.toContain("--token <payload>");
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

  it("uses caller argv instead of raw process argv for channel-specific add options", async () => {
    process.argv = ["node", "openclaw", "channels"];

    await registerChannelsCli(new Command().name("openclaw"), [
      "node",
      "openclaw",
      "channels",
      "add",
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
