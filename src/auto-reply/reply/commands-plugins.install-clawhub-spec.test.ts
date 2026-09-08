// ClawHub chat installs validate selectors, capability consent, and trust boundaries.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withTempHome } from "../../config/home-env.test-harness.js";
import { invokePluginArtifactInstallMock } from "../../plugins/test-helpers/install-fixtures.js";
import { mockFirstObjectArg } from "../../test-utils/mock-call-assertions.js";
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
  resolveNpmSpecMetadataMock,
} = vi.hoisted(() => ({
  installPluginFromNpmPackArchiveMock: vi.fn(),
  installPluginFromNpmSpecMock: vi.fn(),
  installPluginFromPathMock: vi.fn(),
  installPluginFromClawHubMock: vi.fn(),
  installPluginFromGitSpecMock: vi.fn(),
  persistPluginInstallMock: vi.fn(),
  resolveNpmSpecMetadataMock: vi.fn(),
}));

vi.mock("../../infra/install-source-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/install-source-utils.js")>()),
  resolveNpmSpecMetadata: resolveNpmSpecMetadataMock,
}));

vi.mock("../../plugins/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/install.js")>()),
  installPluginFromNpmPackArchive: installPluginFromNpmPackArchiveMock,
  installPluginFromNpmSpec: invokePluginArtifactInstallMock.bind(
    null,
    installPluginFromNpmSpecMock,
  ),
  installPluginFromPath: installPluginFromPathMock,
}));

vi.mock("../../plugins/clawhub.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/clawhub.js")>()),
  installPluginFromClawHub: invokePluginArtifactInstallMock.bind(
    null,
    installPluginFromClawHubMock,
  ),
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

function buildClawHubPluginsParams(commandBodyNormalized: string, workspaceDir: string) {
  return buildPluginsCommandParams({
    commandBodyNormalized,
    workspaceDir,
    gatewayClientScopes: ["operator.admin", "operator.write", "operator.pairing"],
  });
}

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
        const params = buildClawHubPluginsParams(`/plugins install ${raw} --force`, workspaceDir);

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

  it("requires capability consent and names the declared capabilities before installing", async () => {
    installPluginFromClawHubMock.mockResolvedValue({
      ok: true,
      pluginId: "clawhub-demo",
      targetDir: "/tmp/clawhub-demo",
      version: "1.2.3",
      extensions: ["index.js"],
      packageName: "@openclaw/clawhub-demo",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "@openclaw/clawhub-demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        version: "1.2.3",
        integrity: "sha512-demo",
        resolvedAt: "2026-03-22T12:00:00.000Z",
      },
    });

    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const result = await handlePluginsCommand(
        buildClawHubPluginsParams(
          "/plugins install clawhub:@openclaw/clawhub-demo@1.2.3",
          workspaceDir,
        ),
        true,
      );

      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toBe(
        [
          "⚠️ Plugin capabilities require approval: Cold Control Plane (clawhub-demo) @ 1.2.3",
          "Source: clawhub: clawhub:@openclaw/clawhub-demo@1.2.3",
          "Channels: cold-channel",
          "Providers: cold-model-provider",
          "Prompt injection: allowed",
          "Conversation access: denied",
          "Review these capabilities, then rerun /plugins install clawhub:@openclaw/clawhub-demo@1.2.3 --accept-capabilities to continue.",
        ].join("\n"),
      );
      expect(persistPluginInstallMock).not.toHaveBeenCalled();
    });
  });
});

describe("chat plugin install release stream", () => {
  afterEach(async () => {
    installPluginFromNpmSpecMock.mockReset();
    persistPluginInstallMock.mockReset();
    resolveNpmSpecMetadataMock.mockReset();
    await workspaceHarness.cleanupWorkspaces();
  });

  it.each(
    [
      { beta: "2026.9.1-beta.1", selected: "2026.9.2" },
      { beta: "2026.9.3-beta.1", selected: "2026.9.3-beta.1" },
    ].flatMap((release) =>
      [false, true].map((acceptCapabilities) => ({
        beta: release.beta,
        selected: release.selected,
        acceptCapabilities,
      })),
    ),
  )(
    "selects $selected with capability acceptance $acceptCapabilities (beta=$beta)",
    async ({ beta, selected, acceptCapabilities }) => {
      const cfg: OpenClawConfig = {
        commands: { text: true, plugins: true },
        plugins: { enabled: true },
        update: { channel: "beta" },
      };
      for (const version of [beta, "2026.9.2"]) {
        resolveNpmSpecMetadataMock.mockResolvedValueOnce({
          ok: true,
          metadata: {
            name: "@openclaw/brave-plugin",
            version,
            resolvedSpec: `@openclaw/brave-plugin@${version}`,
          },
        });
      }
      installPluginFromNpmSpecMock.mockResolvedValue({
        ok: true,
        pluginId: "brave",
        targetDir: "/tmp/brave",
        version: selected,
        extensions: ["index.js"],
        npmResolution: {
          name: "@openclaw/brave-plugin",
          version: selected,
          resolvedSpec: `@openclaw/brave-plugin@${selected}`,
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
          commandBodyNormalized: `/plugins install npm:@openclaw/brave-plugin${acceptCapabilities ? " --accept-capabilities" : ""}`,
          cfg,
          workspaceDir,
          gatewayClientScopes: ["operator.admin", "operator.write", "operator.pairing"],
        });

        const result = await handlePluginsCommand(params, true);

        expect(mockFirstObjectArg(installPluginFromNpmSpecMock).spec).toBe(
          `@openclaw/brave-plugin@${selected}`,
        );
        expect(installPluginFromNpmSpecMock).toHaveBeenCalledOnce();
        if (acceptCapabilities) {
          expect(persistPluginInstallMock).toHaveBeenCalledWith(
            expect.objectContaining({
              install: expect.objectContaining({
                spec: "@openclaw/brave-plugin",
                version: selected,
                acceptedSurfaceHash: expect.any(String),
              }),
            }),
          );
        } else {
          expect(result?.reply?.text).toContain("Plugin capabilities require approval");
          expect(result?.reply?.text).toContain(`@openclaw/brave-plugin@${selected}`);
          expect(persistPluginInstallMock).not.toHaveBeenCalled();
        }
      });
    },
  );
});
