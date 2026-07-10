/** Tests plugin install command handling and config updates. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../config/home-env.test-harness.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { expectObjectFields, mockFirstObjectArg } from "../../test-utils/mock-call-assertions.js";
import { createCommandWorkspaceHarness } from "./commands-filesystem.test-support.js";
import { handlePluginsCommand } from "./commands-plugins.js";
import { buildPluginsCommandParams } from "./commands.test-harness.js";

const {
  installPluginFromNpmSpecMock,
  installPluginFromPathMock,
  installPluginFromClawHubMock,
  installPluginFromGitSpecMock,
  persistPluginInstallMock,
} = vi.hoisted(() => ({
  installPluginFromNpmSpecMock: vi.fn(),
  installPluginFromPathMock: vi.fn(),
  installPluginFromClawHubMock: vi.fn(),
  installPluginFromGitSpecMock: vi.fn(),
  persistPluginInstallMock: vi.fn(),
}));

vi.mock("../../plugins/install.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/install.js")>(
    "../../plugins/install.js",
  );
  return {
    ...actual,
    installPluginFromNpmSpec: installPluginFromNpmSpecMock,
    installPluginFromPath: installPluginFromPathMock,
  };
});

vi.mock("../../plugins/clawhub.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/clawhub.js")>(
    "../../plugins/clawhub.js",
  );
  return {
    ...actual,
    installPluginFromClawHub: installPluginFromClawHubMock,
  };
});

vi.mock("../../plugins/git-install.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/git-install.js")>(
    "../../plugins/git-install.js",
  );
  return {
    ...actual,
    installPluginFromGitSpec: installPluginFromGitSpecMock,
  };
});

vi.mock("../../plugins/install-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/install-persistence.js")>()),
  persistPluginInstall: persistPluginInstallMock,
}));

const workspaceHarness = createCommandWorkspaceHarness("openclaw-command-plugins-install-");

function buildPluginsParams(
  commandBodyNormalized: string,
  workspaceDir: string,
  options: {
    cfg?: OpenClawConfig;
    gatewayClientScopes?: string[];
    omitGatewayClientScopes?: boolean;
    senderIsOwner?: boolean;
  } = {},
) {
  const params = buildPluginsCommandParams({
    commandBodyNormalized,
    workspaceDir,
    ...(options.cfg ? { cfg: options.cfg } : {}),
    gatewayClientScopes: options.gatewayClientScopes ?? [
      "operator.admin",
      "operator.write",
      "operator.pairing",
    ],
  });
  if (options.senderIsOwner !== undefined) {
    params.command.senderIsOwner = options.senderIsOwner;
  }
  if (options.omitGatewayClientScopes) {
    delete params.ctx.GatewayClientScopes;
  }
  return params;
}

function expectPersistedInstall(pluginId: string, expectedInstall: Record<string, unknown>): void {
  const persisted = mockFirstObjectArg(persistPluginInstallMock);
  expect(persisted.pluginId).toBe(pluginId);
  const snapshot = persisted.snapshot as Record<string, unknown>;
  const writeOptions = snapshot.writeOptions as Record<string, unknown>;
  expectObjectFields(persisted.snapshot, {
    writeOptions: expect.objectContaining({
      assertConfigPathForWrite: expect.any(Function),
      expectedConfigPath: expect.stringContaining("openclaw.json"),
      ownedConfigPathForWrite: expect.stringContaining("openclaw.json"),
    }),
  });
  expect(writeOptions).not.toHaveProperty("basePluginMetadataSnapshot");
  expectObjectFields(persisted.install, expectedInstall);
}

describe("handleCommands /plugins install", () => {
  afterEach(async () => {
    installPluginFromNpmSpecMock.mockReset();
    installPluginFromPathMock.mockReset();
    installPluginFromClawHubMock.mockReset();
    installPluginFromGitSpecMock.mockReset();
    persistPluginInstallMock.mockReset();
    await workspaceHarness.cleanupWorkspaces();
  });

  it("passes the active config to npm install policy preflight", async () => {
    const policyConfig: OpenClawConfig = {
      commands: {
        text: true,
        plugins: true,
      },
      plugins: {
        enabled: true,
      },
      security: {
        installPolicy: {
          enabled: true,
          exec: {
            source: "exec",
            command: process.execPath,
            args: ["-e", "process.exit(1)"],
            allowInsecurePath: true,
          },
        },
      },
    };
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "policy-plugin",
      targetDir: "/tmp/policy-plugin",
      version: "1.0.0",
      extensions: ["index.js"],
      npmResolution: {
        name: "@acme/policy-plugin",
        version: "1.0.0",
        resolvedSpec: "@acme/policy-plugin@1.0.0",
      },
    });
    persistPluginInstallMock.mockResolvedValue({});

    await withTempHome("openclaw-command-plugins-home-", async (home) => {
      await fs.writeFile(
        path.join(home, ".openclaw", "openclaw.json"),
        `${JSON.stringify(policyConfig, null, 2)}\n`,
      );
      const workspaceDir = await workspaceHarness.createWorkspace();
      const params = buildPluginsParams(
        "/plugins install @acme/policy-plugin@1.0.0",
        workspaceDir,
        { cfg: policyConfig },
      );

      const result = await handlePluginsCommand(params, true);

      if (result === null) {
        throw new Error("expected plugin install result");
      }
      expect(result.reply?.text).toContain('Installed plugin "policy-plugin"');
      expectObjectFields(mockFirstObjectArg(installPluginFromNpmSpecMock), {
        spec: "@acme/policy-plugin@1.0.0",
        config: policyConfig,
      });
      expectPersistedInstall("policy-plugin", {
        source: "npm",
        spec: "@acme/policy-plugin@1.0.0",
        installPath: "/tmp/policy-plugin",
        version: "1.0.0",
      });
    });
  });

  it("installs a plugin from a local path", async () => {
    installPluginFromPathMock.mockResolvedValue({
      ok: true,
      pluginId: "path-install-plugin",
      targetDir: "/tmp/path-install-plugin",
      version: "0.0.1",
      extensions: ["index.js"],
    });
    persistPluginInstallMock.mockResolvedValue({});

    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const pluginDir = path.join(workspaceDir, "fixtures", "path-install-plugin");
      await fs.mkdir(pluginDir, { recursive: true });

      const params = buildPluginsParams(`/plugins install ${pluginDir}`, workspaceDir);
      const result = await handlePluginsCommand(params, true);
      if (result === null) {
        throw new Error("expected plugin install result");
      }
      expect(result.reply?.text).toContain('Installed plugin "path-install-plugin"');
      expect(mockFirstObjectArg(installPluginFromPathMock).path).toBe(pluginDir);
      expectPersistedInstall("path-install-plugin", {
        source: "path",
        sourcePath: pluginDir,
        installPath: "/tmp/path-install-plugin",
        version: "0.0.1",
      });
    });
  });

  it("blocks channel-authorized non-owner plugin installs before installer side effects", async () => {
    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const pluginDir = path.join(workspaceDir, "fixtures", "channel-installed-plugin");
      await fs.mkdir(pluginDir, { recursive: true });

      const params = buildPluginsParams(`/plugins install ${pluginDir}`, workspaceDir, {
        omitGatewayClientScopes: true,
        senderIsOwner: false,
      });
      params.command.channel = "telegram";
      params.command.channelId = "telegram";
      params.command.surface = "telegram";
      params.command.senderId = "telegram-user-3";
      params.command.isAuthorizedSender = true;
      params.ctx.Provider = "telegram";
      params.ctx.Surface = "telegram";

      const result = await handlePluginsCommand(params, true);

      expect(result?.shouldContinue).toBe(false);
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
      expect(persistPluginInstallMock).not.toHaveBeenCalled();
    });
  });

  it("allows gateway clients with operator.admin to install plugins", async () => {
    installPluginFromPathMock.mockResolvedValue({
      ok: true,
      pluginId: "gateway-admin-plugin",
      targetDir: "/tmp/gateway-admin-plugin",
      version: "0.0.1",
      extensions: ["index.js"],
    });
    persistPluginInstallMock.mockResolvedValue({});

    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const pluginDir = path.join(workspaceDir, "fixtures", "gateway-admin-plugin");
      await fs.mkdir(pluginDir, { recursive: true });

      const params = buildPluginsParams(`/plugins install ${pluginDir}`, workspaceDir, {
        gatewayClientScopes: ["operator.admin", "operator.write"],
        senderIsOwner: false,
      });

      const result = await handlePluginsCommand(params, true);

      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain('Installed plugin "gateway-admin-plugin"');
      expect(mockFirstObjectArg(installPluginFromPathMock).path).toBe(pluginDir);
      expectPersistedInstall("gateway-admin-plugin", {
        source: "path",
        sourcePath: pluginDir,
        installPath: "/tmp/gateway-admin-plugin",
        version: "0.0.1",
      });
    });
  });

  it("installs from an explicit clawhub: spec", async () => {
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
        artifactKind: "npm-pack",
        artifactFormat: "tgz",
        npmIntegrity: "sha512-npm-pack",
        npmShasum: "a".repeat(40),
        npmTarballName: "clawhub-demo-1.2.3.tgz",
        clawhubTrustDisposition: "review-recommended",
        clawhubTrustScanStatus: "pending",
        clawhubTrustReasons: ["scan:pending"],
        clawhubTrustPending: true,
        clawhubTrustCheckedAt: "2026-03-22T11:59:59.000Z",
      },
    });
    persistPluginInstallMock.mockResolvedValue({});

    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const params = buildPluginsParams(
        "/plugins install clawhub:@openclaw/clawhub-demo@1.2.3",
        workspaceDir,
      );
      const result = await handlePluginsCommand(params, true);
      if (result === null) {
        throw new Error("expected plugin install result");
      }
      expect(result.reply?.text).toContain('Installed plugin "clawhub-demo"');
      expect(mockFirstObjectArg(installPluginFromClawHubMock).spec).toBe(
        "clawhub:@openclaw/clawhub-demo@1.2.3",
      );
      expectPersistedInstall("clawhub-demo", {
        source: "clawhub",
        spec: "clawhub:@openclaw/clawhub-demo@1.2.3",
        installPath: "/tmp/clawhub-demo",
        version: "1.2.3",
        integrity: "sha512-demo",
        clawhubPackage: "@openclaw/clawhub-demo",
        clawhubChannel: "official",
        artifactKind: "npm-pack",
        artifactFormat: "tgz",
        npmIntegrity: "sha512-npm-pack",
        npmShasum: "a".repeat(40),
        npmTarballName: "clawhub-demo-1.2.3.tgz",
        clawhubTrustDisposition: "review-recommended",
        clawhubTrustScanStatus: "pending",
        clawhubTrustReasons: ["scan:pending"],
        clawhubTrustPending: true,
        clawhubTrustCheckedAt: "2026-03-22T11:59:59.000Z",
      });
    });
  });

  it("includes non-blocking ClawHub warnings in successful chat install replies", async () => {
    const warning =
      'ClawHub trust warning for "@openclaw/clawhub-demo@1.2.3": scan=pending; reasons=pending.';
    const richWarning = `\u001b[33m${warning}\u001b[39m`;
    installPluginFromClawHubMock.mockImplementation(async (params: unknown) => {
      if (!params || typeof params !== "object" || !("logger" in params)) {
        throw new Error("expected ClawHub install logger");
      }
      const logger = params.logger;
      if (
        !logger ||
        typeof logger !== "object" ||
        !("warn" in logger) ||
        typeof logger.warn !== "function"
      ) {
        throw new Error("expected ClawHub install warn logger");
      }
      logger.warn(richWarning);
      return {
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
      };
    });
    persistPluginInstallMock.mockResolvedValue({});

    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const params = buildPluginsParams(
        "/plugins install clawhub:@openclaw/clawhub-demo@1.2.3",
        workspaceDir,
      );
      const result = await handlePluginsCommand(params, true);
      if (result === null) {
        throw new Error("expected plugin install result");
      }
      expect(result.reply?.text).toContain('Installed plugin "clawhub-demo"');
      expect(result.reply?.text).toContain(warning);
      expect(result.reply?.text).not.toContain("\u001b");
      expect(mockFirstObjectArg(installPluginFromClawHubMock).logger).toEqual(
        expect.objectContaining({ terminalLinks: false }),
      );
      expectPersistedInstall("clawhub-demo", {
        source: "clawhub",
        spec: "clawhub:@openclaw/clawhub-demo@1.2.3",
        installPath: "/tmp/clawhub-demo",
      });
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
      const params = buildPluginsParams(
        "/plugins install clawhub:@openclaw/risky-demo@1.2.3",
        workspaceDir,
      );
      const result = await handlePluginsCommand(params, true);
      if (result === null) {
        throw new Error("expected plugin install result");
      }

      expect(result.reply?.text).toContain("has trust warnings");
      expect(result.reply?.text).toContain("scan=suspicious");
      expect(result.reply?.text).toContain("payload_string");
      expect(result.reply?.text).toContain("--acknowledge-clawhub-risk");
      expect(result.reply?.text).toContain("local openclaw plugins install command");
      expect(result.reply?.text).toContain("trusted shell");
      expect(mockFirstObjectArg(installPluginFromClawHubMock).spec).toBe(
        "clawhub:@openclaw/risky-demo@1.2.3",
      );
      expect(persistPluginInstallMock).not.toHaveBeenCalled();
    });
  });

  it("includes ClawHub trust details for blocked chat install failures", async () => {
    const warning =
      'ClawHub trust warning for "@openclaw/blocked-demo@1.2.3": scan=suspicious; moderation=blocked; blockedFromDownload=true; pending=false; stale=false; reasons=payload_string. Risk signals: blocked from download, scan status suspicious, moderation state blocked, payload_string.';
    installPluginFromClawHubMock.mockResolvedValue({
      ok: false,
      code: "clawhub_download_blocked",
      error: 'ClawHub release "@openclaw/blocked-demo@1.2.3" is blocked from download by ClawHub.',
      warning,
    });

    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const params = buildPluginsParams(
        "/plugins install clawhub:@openclaw/blocked-demo@1.2.3",
        workspaceDir,
      );
      const result = await handlePluginsCommand(params, true);
      if (result === null) {
        throw new Error("expected plugin install result");
      }

      expect(result.reply?.text).toContain("blocked from download");
      expect(result.reply?.text).toContain("scan=suspicious");
      expect(result.reply?.text).toContain("moderation=blocked");
      expect(result.reply?.text).toContain("payload_string");
      expect(persistPluginInstallMock).not.toHaveBeenCalled();
    });
  });

  it("refuses plugin installs in Nix mode before package installer side effects", async () => {
    const previousNixMode = process.env.OPENCLAW_NIX_MODE;
    process.env.OPENCLAW_NIX_MODE = "1";
    try {
      await withTempHome("openclaw-command-plugins-home-", async () => {
        const workspaceDir = await workspaceHarness.createWorkspace();
        const params = buildPluginsParams("/plugins install @acme/demo", workspaceDir);
        const result = await handlePluginsCommand(params, true);
        if (result === null) {
          throw new Error("expected plugin install result");
        }

        expect(result.reply?.text).toContain("OPENCLAW_NIX_MODE=1");
        expect(result.reply?.text).toContain("nix-openclaw#quick-start");
        expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
        expect(installPluginFromPathMock).not.toHaveBeenCalled();
        expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
        expect(installPluginFromGitSpecMock).not.toHaveBeenCalled();
        expect(persistPluginInstallMock).not.toHaveBeenCalled();
      });
    } finally {
      if (previousNixMode === undefined) {
        delete process.env.OPENCLAW_NIX_MODE;
      } else {
        process.env.OPENCLAW_NIX_MODE = previousNixMode;
      }
    }
  });

  it("refuses installs through a root include before package installer side effects", async () => {
    await withTempHome("openclaw-command-plugins-home-", async (home) => {
      const sharedConfigPath = path.join(home, ".openclaw", "shared.json5");
      await fs.writeFile(sharedConfigPath, `${JSON.stringify({ plugins: {} }, null, 2)}\n`);
      await fs.writeFile(
        path.join(home, ".openclaw", "openclaw.json"),
        `${JSON.stringify({ $include: "./shared.json5" }, null, 2)}\n`,
      );
      const workspaceDir = await workspaceHarness.createWorkspace();
      const params = buildPluginsParams("/plugins install @acme/demo", workspaceDir);

      const result = await handlePluginsCommand(params, true);

      if (result === null) {
        throw new Error("expected plugin install result");
      }
      expect(result.reply?.text).toContain("unsupported $include shape at the root");
      expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
      expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
      expect(installPluginFromGitSpecMock).not.toHaveBeenCalled();
      expect(persistPluginInstallMock).not.toHaveBeenCalled();
    });
  });

  it("installs from an explicit git: spec", async () => {
    installPluginFromGitSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "git-demo",
      targetDir: "/tmp/git-demo",
      version: "1.2.3",
      extensions: ["index.js"],
      git: {
        url: "https://github.com/acme/git-demo.git",
        ref: "v1.2.3",
        commit: "abc123",
        resolvedAt: "2026-04-30T12:00:00.000Z",
      },
    });
    persistPluginInstallMock.mockResolvedValue({});

    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const params = buildPluginsParams(
        "/plugins install git:github.com/acme/git-demo@v1.2.3",
        workspaceDir,
      );
      const result = await handlePluginsCommand(params, true);
      if (result === null) {
        throw new Error("expected plugin install result");
      }
      expect(result.reply?.text).toContain('Installed plugin "git-demo"');
      expect(mockFirstObjectArg(installPluginFromGitSpecMock).spec).toBe(
        "git:github.com/acme/git-demo@v1.2.3",
      );
      expectPersistedInstall("git-demo", {
        source: "git",
        spec: "git:github.com/acme/git-demo@v1.2.3",
        installPath: "/tmp/git-demo",
        version: "1.2.3",
        gitUrl: "https://github.com/acme/git-demo.git",
        gitRef: "v1.2.3",
        gitCommit: "abc123",
      });
    });
  });

  it("treats /plugin add as an install alias", async () => {
    installPluginFromClawHubMock.mockResolvedValue({
      ok: true,
      pluginId: "alias-demo",
      targetDir: "/tmp/alias-demo",
      version: "1.0.0",
      extensions: ["index.js"],
      packageName: "@openclaw/alias-demo",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "@openclaw/alias-demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        version: "1.0.0",
        integrity: "sha512-alias",
        resolvedAt: "2026-03-23T12:00:00.000Z",
      },
    });
    persistPluginInstallMock.mockResolvedValue({});

    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const params = buildPluginsParams(
        "/plugin add clawhub:@openclaw/alias-demo@1.0.0",
        workspaceDir,
      );
      const result = await handlePluginsCommand(params, true);
      if (result === null) {
        throw new Error("expected plugin install result");
      }
      expect(result.reply?.text).toContain('Installed plugin "alias-demo"');
      expect(mockFirstObjectArg(installPluginFromClawHubMock).spec).toBe(
        "clawhub:@openclaw/alias-demo@1.0.0",
      );
    });
  });

  it("trusts catalog npm package installs with alternate selectors", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "wecom-openclaw-plugin",
      targetDir: "/tmp/wecom-openclaw-plugin",
      version: "2026.4.23",
      extensions: ["index.js"],
      npmResolution: {
        name: "@wecom/wecom-openclaw-plugin",
        version: "2026.4.23",
        resolvedSpec: "@wecom/wecom-openclaw-plugin@2026.4.23",
        integrity: "sha512-wecom",
        resolvedAt: "2026-05-04T20:00:00.000Z",
      },
    });
    persistPluginInstallMock.mockResolvedValue({});

    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const params = buildPluginsParams(
        "/plugins install @wecom/wecom-openclaw-plugin@latest",
        workspaceDir,
      );
      const result = await handlePluginsCommand(params, true);
      if (result === null) {
        throw new Error("expected plugin install result");
      }
      expect(result.reply?.text).toContain('Installed plugin "wecom-openclaw-plugin"');
      const npmInstallArgs = mockFirstObjectArg(installPluginFromNpmSpecMock);
      expectObjectFields(npmInstallArgs, {
        spec: "@wecom/wecom-openclaw-plugin@latest",
        expectedPluginId: "wecom-openclaw-plugin",
        trustedSourceLinkedOfficialInstall: true,
      });
      expect(npmInstallArgs.expectedIntegrity).toBeUndefined();
      expectPersistedInstall("wecom-openclaw-plugin", {
        source: "npm",
        spec: "@wecom/wecom-openclaw-plugin@latest",
        installPath: "/tmp/wecom-openclaw-plugin",
        version: "2026.4.23",
        resolvedName: "@wecom/wecom-openclaw-plugin",
        resolvedVersion: "2026.4.23",
      });
    });
  });
});
