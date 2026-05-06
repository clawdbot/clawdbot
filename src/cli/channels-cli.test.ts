import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginPackageChannel } from "../plugins/manifest.js";
import { registerChannelsCli } from "./channels-cli.js";

const listBundledPackageChannelMetadataMock = vi.hoisted(() =>
  vi.fn<() => readonly PluginPackageChannel[]>(() => []),
);

vi.mock("../plugins/bundled-package-channel-metadata.js", () => ({
  listBundledPackageChannelMetadata: listBundledPackageChannelMetadataMock,
}));

function getChannelAddOptionFlags(program: Command): string[] {
  const channels = program.commands.find((command) => command.name() === "channels");
  const add = channels?.commands.find((command) => command.name() === "add");
  return add?.options.map((option) => option.flags) ?? [];
}

describe("registerChannelsCli", () => {
  const originalArgv = [...process.argv];
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  afterEach(() => {
    process.argv = [...originalArgv];
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    vi.clearAllMocks();
  });

  it("loads channel-specific add options only for channels add invocations", async () => {
    process.argv = ["node", "openclaw", "channels"];
    await registerChannelsCli(new Command().name("openclaw"));

    expect(listBundledPackageChannelMetadataMock).not.toHaveBeenCalled();

    process.argv = ["node", "openclaw", "channels", "add", "--help"];
    await registerChannelsCli(new Command().name("openclaw"));

    expect(listBundledPackageChannelMetadataMock).toHaveBeenCalledTimes(1);
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
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
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
});
