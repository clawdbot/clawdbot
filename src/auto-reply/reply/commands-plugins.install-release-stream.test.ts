// Chat plugin installs must follow the release stream the gateway runs.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withTempHome } from "../../config/home-env.test-harness.js";
import { createCommandWorkspaceHarness } from "./commands-filesystem.test-support.js";
import { handlePluginsCommand } from "./commands-plugins.js";
import { buildPluginsCommandParams } from "./commands.test-harness.js";

const { installPluginFromNpmSpecMock, persistPluginInstallMock } = vi.hoisted(() => ({
  installPluginFromNpmSpecMock: vi.fn(),
  persistPluginInstallMock: vi.fn(),
}));

vi.mock("../../plugins/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/install.js")>()),
  installPluginFromNpmSpec: installPluginFromNpmSpecMock,
}));

vi.mock("../../plugins/install-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/install-persistence.js")>()),
  persistPluginInstall: persistPluginInstallMock,
}));

const workspaceHarness = createCommandWorkspaceHarness("openclaw-command-plugins-channel-");

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
