// ClawHub chat installs validate selectors, capability consent, and trust boundaries.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withTempHome } from "../../config/home-env.test-harness.js";
import { invokePluginArtifactInstallMock } from "../../plugins/test-helpers/install-fixtures.js";
import { expectObjectFields, mockFirstObjectArg } from "../../test-utils/mock-call-assertions.js";
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

  it("reports risky ClawHub install failures without persisting install metadata", async () => {
    const warning =
      'ClawHub trust warning for "@openclaw/risky-demo@1.2.3": scan=suspicious; moderation=none; blockedFromDownload=false; pending=false; stale=false; reasons=payload_string. Risk signals: scan status suspicious, payload_string.';
    installPluginFromClawHubMock.mockResolvedValue({
      ok: false,
      code: "clawhub_risk_acknowledgement_required",
      error:
        'ClawHub release "@openclaw/risky-demo@1.2.3" has trust warnings. Review the package and rerun with --acknowledge-clawhub-risk to continue.',
      warning,
    });

    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const result = await handlePluginsCommand(
        buildClawHubPluginsParams(
          "/plugins install clawhub:@openclaw/risky-demo@1.2.3 --force",
          workspaceDir,
        ),
        true,
      );
      if (result === null) {
        throw new Error("expected plugin install result");
      }

      expect(result.reply?.text).toContain("has trust warnings");
      expect(result.reply?.text).toContain("scan=suspicious");
      expect(result.reply?.text).toContain("payload_string");
      expect(result.reply?.text).toContain("--acknowledge-clawhub-risk");
      expect(result.reply?.text).toContain("local openclaw plugins install command");
      expect(result.reply?.text).toContain("trusted shell");
      const installParams = mockFirstObjectArg(installPluginFromClawHubMock);
      expectObjectFields(installParams, {
        spec: "clawhub:@openclaw/risky-demo@1.2.3",
        mode: "update",
      });
      expect(installParams).not.toHaveProperty("acknowledgeClawHubRisk");
      expect(persistPluginInstallMock).not.toHaveBeenCalled();
    });
  });
});

describe("chat plugin install release stream", () => {
  afterEach(async () => {
    installPluginFromNpmSpecMock.mockReset();
    persistPluginInstallMock.mockReset();
    await workspaceHarness.cleanupWorkspaces();
  });

  it.each([false, true])(
    "keeps beta artifact selection with capability acceptance %s",
    async (acceptCapabilities) => {
      const cfg: OpenClawConfig = {
        commands: { text: true, plugins: true },
        plugins: { enabled: true },
        update: { channel: "beta" },
      };
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
          commandBodyNormalized: `/plugins install npm:@openclaw/brave-plugin${acceptCapabilities ? " --accept-capabilities" : ""}`,
          cfg,
          workspaceDir,
          gatewayClientScopes: ["operator.admin", "operator.write", "operator.pairing"],
        });

        const result = await handlePluginsCommand(params, true);

        expect(mockFirstObjectArg(installPluginFromNpmSpecMock).spec).toBe(
          "@openclaw/brave-plugin@beta",
        );
        if (acceptCapabilities) {
          expect(persistPluginInstallMock).toHaveBeenCalledWith(
            expect.objectContaining({
              install: expect.objectContaining({ acceptedSurfaceHash: expect.any(String) }),
            }),
          );
        } else {
          expect(result?.reply?.text).toContain("Plugin capabilities require approval");
          expect(persistPluginInstallMock).not.toHaveBeenCalled();
        }
      });
    },
  );
});
