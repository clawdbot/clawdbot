// Invalid plugin install requests must fail before persistent state or source execution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installHooksFromNpmSpecMock,
  installHooksFromPathMock,
  installPluginFromClawHubMock,
  installPluginFromGitSpecMock,
  installPluginFromMarketplaceMock,
  installPluginFromNpmPackArchiveMock,
  installPluginFromNpmSpecMock,
  installPluginFromPathMock,
  parseClawHubPluginSpecMock,
  promptYesNoMock,
  readConfigFileSnapshotForWriteMock,
  resetPluginsCliTestState,
  resolveMarketplaceInstallShortcutMock,
  runPluginsCommand,
  runtimeErrors,
  configWriteMock,
} from "./plugins-cli-test-helpers.js";
import { resolvePluginInstallPreflight } from "./plugins-install-preflight.js";

const { withPluginLifecycleLeaseMock } = vi.hoisted(() => ({
  withPluginLifecycleLeaseMock: vi.fn(),
}));

vi.mock("../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: withPluginLifecycleLeaseMock,
}));

function expectNoPluginInstallSideEffects(): void {
  expect(withPluginLifecycleLeaseMock).not.toHaveBeenCalled();
  expect(readConfigFileSnapshotForWriteMock).not.toHaveBeenCalled();
  expect(promptYesNoMock).not.toHaveBeenCalled();
  expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
  expect(installPluginFromGitSpecMock).not.toHaveBeenCalled();
  expect(installPluginFromMarketplaceMock).not.toHaveBeenCalled();
  expect(installPluginFromNpmPackArchiveMock).not.toHaveBeenCalled();
  expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
  expect(installPluginFromPathMock).not.toHaveBeenCalled();
  expect(installHooksFromNpmSpecMock).not.toHaveBeenCalled();
  expect(installHooksFromPathMock).not.toHaveBeenCalled();
  expect(configWriteMock).not.toHaveBeenCalled();
}

describe("plugin install mutation-free preflight", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
    withPluginLifecycleLeaseMock.mockReset();
    withPluginLifecycleLeaseMock.mockImplementation(
      async (_options: unknown, run: (lease: unknown) => Promise<unknown>) =>
        await run({ assertOwned: vi.fn() }),
    );
  });

  it("resolves registered marketplace shorthand before ordinary source classification", async () => {
    resolveMarketplaceInstallShortcutMock.mockResolvedValue({
      ok: true,
      plugin: "superpowers",
      marketplaceName: "claude-plugins-official",
      marketplaceSource: "claude-plugins-official",
    });

    await expect(
      resolvePluginInstallPreflight({
        raw: "superpowers@claude-plugins-official",
        opts: { force: true },
      }),
    ).resolves.toMatchObject({
      ok: true,
      raw: "superpowers",
      marketplace: "claude-plugins-official",
      sourcePlan: null,
    });

    expectNoPluginInstallSideEffects();
  });

  it.each([
    "clawhub:",
    "clawhub:demo@",
    "clawhub:@scope/pkg@",
    "CLAWHUB:",
    "ClAwHuB:demo@",
    " clawhub:demo@ ",
  ])("rejects malformed explicit ClawHub source %s before the lifecycle lease", async (raw) => {
    await expect(runPluginsCommand(["plugins", "install", raw, "--force"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain(`Unsupported ClawHub plugin spec: ${raw}`);
    expectNoPluginInstallSideEffects();
  });

  it.each([" ", "\t"])(
    "rejects a whitespace-only install source %j before the lifecycle lease",
    async (raw) => {
      await expect(runPluginsCommand(["plugins", "install", raw, "--force"])).rejects.toThrow(
        "__exit__:1",
      );

      expect(runtimeErrors.at(-1)).toContain("Plugin install source must not be empty.");
      expectNoPluginInstallSideEffects();
    },
  );

  it.each(["", " ", "\t"])(
    "rejects an explicitly empty marketplace %j before the lifecycle lease",
    async (marketplace) => {
      await expect(
        runPluginsCommand(["plugins", "install", "demo", "--marketplace", marketplace, "--force"]),
      ).rejects.toThrow("__exit__:1");

      expect(runtimeErrors.at(-1)).toContain("--marketplace requires a non-empty source.");
      expectNoPluginInstallSideEffects();
    },
  );

  it.each([
    {
      label: "marketplace link",
      args: ["demo", "--marketplace", "local/repo", "--link"],
      error: "--link is not supported with --marketplace.",
    },
    {
      label: "marketplace pin",
      args: ["demo", "--marketplace", "local/repo", "--pin"],
      error: "--pin is not supported with --marketplace.",
    },
    {
      label: "git link",
      args: ["git:github.com/acme/demo", "--link"],
      error: "--link is not supported with git: installs.",
    },
    {
      label: "git pin",
      args: ["git:github.com/acme/demo", "--pin"],
      error: "--pin is not supported with git: installs.",
    },
    {
      label: "ClawHub pin",
      args: ["clawhub:demo", "--pin"],
      error: "--pin is only supported with npm registry installs.",
    },
    {
      label: "npm-pack pin",
      args: ["npm-pack:/tmp/openclaw-plugin-preflight-test.tgz", "--pin"],
      error: "--pin is only supported with npm registry installs.",
    },
    {
      label: "local path pin",
      args: [".", "--pin"],
      error: "--pin is only supported with npm registry installs.",
    },
    {
      label: "registry link",
      args: ["npm:demo", "--link"],
      error: "--link requires a local path.",
    },
    {
      label: "empty npm source",
      args: ["npm:"],
      error: "Unsupported npm plugin spec: missing package.",
    },
    {
      label: "empty npm-pack source",
      args: ["npm-pack:"],
      error: "Unsupported npm-pack plugin spec: missing archive path.",
    },
    {
      label: "empty git source",
      args: ["git:"],
      error: "unsupported git: plugin spec: git:",
    },
    {
      label: "missing local path",
      args: ["./openclaw-missing-plugin-preflight-test.tgz"],
      error: "Plugin path not found:",
    },
  ])("rejects $label before the lifecycle lease", async ({ args, error }) => {
    if (args[0] === "clawhub:demo") {
      parseClawHubPluginSpecMock.mockReturnValue({ name: "demo" });
    }

    await expect(runPluginsCommand(["plugins", "install", ...args, "--force"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain(error);
    expectNoPluginInstallSideEffects();
  });
});
