// Explicit ClawHub chat selectors must fail closed without invoking another installer.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withTempHome } from "../../config/home-env.test-harness.js";
import { createCommandWorkspaceHarness } from "./commands-filesystem.test-support.js";
import { handlePluginsCommand } from "./commands-plugins.js";
import { buildPluginsCommandParams } from "./commands.test-harness.js";

const {
  installPluginFromNpmPackArchiveMock,
  installPluginFromNpmSpecMock,
  installPluginFromPathMock,
  installPluginFromClawHubMock,
  installPluginFromGitSpecMock,
  persistPluginInstallMock,
} = vi.hoisted(() => ({
  installPluginFromNpmPackArchiveMock: vi.fn(),
  installPluginFromNpmSpecMock: vi.fn(),
  installPluginFromPathMock: vi.fn(),
  installPluginFromClawHubMock: vi.fn(),
  installPluginFromGitSpecMock: vi.fn(),
  persistPluginInstallMock: vi.fn(),
}));

vi.mock("../../plugins/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/install.js")>()),
  installPluginFromNpmPackArchive: installPluginFromNpmPackArchiveMock,
  installPluginFromNpmSpec: installPluginFromNpmSpecMock,
  installPluginFromPath: installPluginFromPathMock,
}));

vi.mock("../../plugins/clawhub.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/clawhub.js")>()),
  installPluginFromClawHub: installPluginFromClawHubMock,
}));

vi.mock("../../plugins/git-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/git-install.js")>()),
  installPluginFromGitSpec: installPluginFromGitSpecMock,
}));

vi.mock("../../plugins/install-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/install-persistence.js")>()),
  persistPluginInstall: persistPluginInstallMock,
}));

const workspaceHarness = createCommandWorkspaceHarness("openclaw-command-plugins-clawhub-");

describe("chat plugin install explicit ClawHub selectors", () => {
  afterEach(async () => {
    installPluginFromNpmPackArchiveMock.mockReset();
    installPluginFromNpmSpecMock.mockReset();
    installPluginFromPathMock.mockReset();
    installPluginFromClawHubMock.mockReset();
    installPluginFromGitSpecMock.mockReset();
    persistPluginInstallMock.mockReset();
    await workspaceHarness.cleanupWorkspaces();
  });

  it.each(["clawhub:", "clawhub:demo@", "clawhub:@scope/pkg@", "CLAWHUB:"])(
    "rejects malformed source %s before installer side effects",
    async (raw) => {
      await withTempHome("openclaw-command-plugins-home-", async () => {
        const workspaceDir = await workspaceHarness.createWorkspace();
        const params = buildPluginsCommandParams({
          commandBodyNormalized: `/plugins install ${raw} --force`,
          workspaceDir,
          gatewayClientScopes: ["operator.admin", "operator.write", "operator.pairing"],
        });

        const result = await handlePluginsCommand(params, true);

        expect(result?.shouldContinue).toBe(false);
        expect(result?.reply?.text).toContain(`Unsupported ClawHub plugin spec: ${raw}`);
        expect(installPluginFromNpmPackArchiveMock).not.toHaveBeenCalled();
        expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
        expect(installPluginFromPathMock).not.toHaveBeenCalled();
        expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
        expect(installPluginFromGitSpecMock).not.toHaveBeenCalled();
        expect(persistPluginInstallMock).not.toHaveBeenCalled();
      });
    },
  );
});

describe("chat plugin install release stream", () => {
  afterEach(async () => {
    installPluginFromNpmSpecMock.mockReset();
    persistPluginInstallMock.mockReset();
    await workspaceHarness.cleanupWorkspaces();
  });

  it("installs the beta artifact for an official plugin on a beta gateway", async () => {
    const cfg = {
      commands: { text: true, plugins: true },
      plugins: { enabled: true },
      update: { channel: "beta" },
    } as OpenClawConfig;
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "brave",
      targetDir: "/tmp/brave",
      version: "1.0.0",
      extensions: ["index.js"],
      npmResolution: {
        name: "@openclaw/brave-plugin",
        version: "1.0.0",
        resolvedSpec: "@openclaw/brave-plugin@1.0.0",
      },
    });
    persistPluginInstallMock.mockResolvedValue({});

    await withTempHome("openclaw-command-plugins-home-", async (home) => {
      await fs.writeFile(
        path.join(home, ".openclaw", "openclaw.json"),
        `${JSON.stringify(cfg, null, 2)}
`,
      );
      const workspaceDir = await workspaceHarness.createWorkspace();
      const params = buildPluginsCommandParams({
        commandBodyNormalized: "/plugins install npm:@openclaw/brave-plugin",
        cfg,
        workspaceDir,
        gatewayClientScopes: ["operator.admin", "operator.write", "operator.pairing"],
      });

      await handlePluginsCommand(params, true);

      const call = installPluginFromNpmSpecMock.mock.calls[0]?.[0] as { spec?: string } | undefined;
      expect(call?.spec).toBe("@openclaw/brave-plugin@beta");
    });
  });
});
