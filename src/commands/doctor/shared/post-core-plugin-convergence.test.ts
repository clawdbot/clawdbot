// Post-core plugin convergence tests cover update convergence checks after core updates.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";

const mocks = vi.hoisted(() => ({
  listManagedPluginNpmRoots: vi.fn(),
  maybeRepairStaleManagedNpmBundledPlugins: vi.fn(),
  repairMissingConfiguredPluginInstalls: vi.fn(),
  relinkOpenClawPeerDependenciesInManagedNpmRoot: vi.fn(),
  runPluginPayloadSmokeCheck: vi.fn(),
}));

vi.mock("./missing-configured-plugin-install.js", () => ({
  repairMissingConfiguredPluginInstalls: mocks.repairMissingConfiguredPluginInstalls,
}));
vi.mock("../../doctor-plugin-registry.js", () => ({
  maybeRepairStaleManagedNpmBundledPlugins: mocks.maybeRepairStaleManagedNpmBundledPlugins,
}));
vi.mock("../../../plugins/plugin-peer-link.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../plugins/plugin-peer-link.js")>();
  return {
    ...actual,
    relinkOpenClawPeerDependenciesInManagedNpmRoot:
      mocks.relinkOpenClawPeerDependenciesInManagedNpmRoot,
  };
});
vi.mock("../../../plugins/npm-project-roots.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../plugins/npm-project-roots.js")>();
  return {
    ...actual,
    listManagedPluginNpmRoots: mocks.listManagedPluginNpmRoots,
  };
});
vi.mock("../../../plugins/payload-verification.js", () => ({
  runPluginPayloadSmokeCheck: mocks.runPluginPayloadSmokeCheck,
}));

import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import {
  filterRecordsToActive,
  runActivePluginPayloadSmokeCheck,
} from "../../../plugins/active-payload-verification.js";
import { VERSION } from "../../../version.js";
import { runPostCorePluginConvergence } from "./post-core-plugin-convergence.js";

describe("runPostCorePluginConvergence", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listManagedPluginNpmRoots.mockImplementation((npmRoot: string) =>
      Promise.resolve([npmRoot]),
    );
    mocks.maybeRepairStaleManagedNpmBundledPlugins.mockReturnValue(null);
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: [],
      warnings: [],
      records: {},
    });
    mocks.relinkOpenClawPeerDependenciesInManagedNpmRoot.mockResolvedValue({
      checked: 0,
      attempted: 0,
      repaired: 0,
      skipped: 0,
    });
    mocks.runPluginPayloadSmokeCheck.mockResolvedValue({ checked: [], failures: [] });
  });

  function writeBundledPlugin(
    rootDir: string,
    pluginId: string,
    version = "2026.5.20-beta.1",
  ): string {
    const pluginDir = path.join(rootDir, pluginId);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "index.js"), "export default {};\n", "utf8");
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        name: pluginId,
        version,
        configSchema: { type: "object" },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: `@openclaw/${pluginId}`,
        version,
      }),
      "utf8",
    );
    return pluginDir;
  }

  it("calls repair with OPENCLAW_UPDATE_POST_CORE_CONVERGENCE=1 set", async () => {
    const cfg = { plugins: { entries: {} } } as unknown as OpenClawConfig;
    await runPostCorePluginConvergence({
      cfg,
      env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
    });
    expect(mocks.repairMissingConfiguredPluginInstalls).toHaveBeenCalledTimes(1);
    expect(mocks.maybeRepairStaleManagedNpmBundledPlugins).toHaveBeenCalledWith({
      config: cfg,
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
      prompter: { shouldRepair: true },
    });
    expect(mocks.repairMissingConfiguredPluginInstalls).toHaveBeenCalledWith({
      cfg,
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
    });
    expect(
      expectDefined(
        mocks.maybeRepairStaleManagedNpmBundledPlugins.mock.invocationCallOrder[0],
        "stale managed cleanup call order",
      ),
    ).toBeLessThan(
      expectDefined(
        mocks.repairMissingConfiguredPluginInstalls.mock.invocationCallOrder[0],
        "missing configured plugin repair call order",
      ),
    );
  });

  it("checks active payloads without running repair or peer-link convergence", async () => {
    const cfg = {
      plugins: {
        deny: ["disabled"],
        entries: { active: { enabled: true }, disabled: { enabled: true } },
      },
    } as unknown as OpenClawConfig;
    const records = {
      active: { source: "npm" as const, installPath: "/p/active" },
      disabled: { source: "npm" as const, installPath: "/p/disabled" },
    };

    await runActivePluginPayloadSmokeCheck({ cfg, records, env: { OPENCLAW_STATE_DIR: "/state" } });

    expect(mocks.runPluginPayloadSmokeCheck).toHaveBeenCalledWith({
      records: { active: records.active },
      env: { OPENCLAW_STATE_DIR: "/state" },
    });
    expect(mocks.repairMissingConfiguredPluginInstalls).not.toHaveBeenCalled();
    expect(mocks.relinkOpenClawPeerDependenciesInManagedNpmRoot).not.toHaveBeenCalled();
  });

  it("uses the candidate runtime version over a stale inherited host version", async () => {
    const cfg = { plugins: { entries: {} } } as unknown as OpenClawConfig;
    await runPostCorePluginConvergence({
      cfg,
      env: { OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.12" },
    });
    expect(mocks.repairMissingConfiguredPluginInstalls).toHaveBeenCalledWith({
      cfg,
      env: {
        OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
    });
  });

  it("uses an explicit compatibility host version for startup convergence", async () => {
    const cfg = { plugins: { entries: {} } } as unknown as OpenClawConfig;
    await runPostCorePluginConvergence({
      cfg,
      env: { OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.12" },
      compatibilityHostVersion: "2026.7.2-beta.7",
    });
    expect(mocks.repairMissingConfiguredPluginInstalls).toHaveBeenCalledWith({
      cfg,
      env: {
        OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.7.2-beta.7",
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
    });
  });

  it("returns ok when no warnings/failures and includes repair changes", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: ['Repaired missing configured plugin "discord".'],
      warnings: [],
      records: { discord: { source: "npm", installPath: "/p/discord" } },
    });
    const result = await runPostCorePluginConvergence({
      cfg: {
        plugins: { entries: { discord: { enabled: true } } },
      } as unknown as OpenClawConfig,
      env: {},
    });
    expect(result.errored).toBe(false);
    expect(result.changes).toEqual(['Repaired missing configured plugin "discord".']);
    expect(result.warnings).toEqual([]);
  });

  it("returns the post-repair install records so callers can re-seed pluginConfig", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: ["Repaired"],
      warnings: [],
      records: { discord: { source: "npm", installPath: "/p/discord" } },
    });
    const result = await runPostCorePluginConvergence({
      cfg: { plugins: { entries: { discord: { enabled: true } } } } as unknown as OpenClawConfig,
      env: {},
    });
    expect(result.installRecords).toEqual({
      discord: { source: "npm", installPath: "/p/discord" },
    });
  });

  it("repairs managed npm openclaw peer links in every managed npm project before payload smoke checks", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: [],
      warnings: [],
      records: { codex: { source: "npm", installPath: "/p/codex" } },
    });
    mocks.listManagedPluginNpmRoots.mockResolvedValue([
      "/tmp/openclaw-state/npm",
      "/tmp/openclaw-state/npm/projects/codex",
    ]);
    mocks.relinkOpenClawPeerDependenciesInManagedNpmRoot
      .mockResolvedValueOnce({
        checked: 0,
        attempted: 0,
        repaired: 0,
        skipped: 0,
      })
      .mockResolvedValueOnce({
        checked: 1,
        attempted: 1,
        repaired: 1,
        skipped: 0,
      });

    const result = await runPostCorePluginConvergence({
      cfg: { plugins: { entries: { codex: { enabled: true } } } } as unknown as OpenClawConfig,
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
    });

    expect(mocks.relinkOpenClawPeerDependenciesInManagedNpmRoot).toHaveBeenNthCalledWith(1, {
      npmRoot: "/tmp/openclaw-state/npm",
      logger: {},
      onPackageReadError: expect.any(Function),
    });
    expect(mocks.relinkOpenClawPeerDependenciesInManagedNpmRoot).toHaveBeenNthCalledWith(2, {
      npmRoot: "/tmp/openclaw-state/npm/projects/codex",
      logger: {},
      onPackageReadError: expect.any(Function),
    });
    expect(result.changes).toEqual([
      "Repaired OpenClaw host peer link(s) for 1 managed npm plugin package(s).",
    ]);
    expect(
      mocks.relinkOpenClawPeerDependenciesInManagedNpmRoot.mock.invocationCallOrder[0],
    ).toBeLessThan(
      expectDefined(
        mocks.runPluginPayloadSmokeCheck.mock.invocationCallOrder[0],
        "mocks.runPluginPayloadSmokeCheck.mock.invocationCallOrder[0] test invariant",
      ),
    );
  });

  it.each(["peerDependencies", "dependencies"] as const)(
    "repairs a registered extensions-root %s stale host before the real payload smoke check",
    async (dependencyField) => {
      const stateDir = tempDirs.make("openclaw-post-core-convergence-");
      const packageDir = path.join(stateDir, "extensions", "email");
      const staleHostDir = path.join(packageDir, "node_modules", "openclaw");
      fs.mkdirSync(staleHostDir, { recursive: true });
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: "@clawemail/email",
          version: "2026.7.1",
          [dependencyField]: { openclaw: ">=2026.7.1" },
          openclaw: { extensions: ["./index.js"] },
        }),
      );
      fs.writeFileSync(path.join(packageDir, "index.js"), "export default {};\n");
      fs.writeFileSync(
        path.join(staleHostDir, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.7.1-beta.2" }),
      );
      const records = {
        email: { source: "npm" as const, installPath: packageDir },
      };
      mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
        changes: [],
        warnings: [],
        records,
      });
      mocks.runPluginPayloadSmokeCheck.mockImplementation(async (params) => {
        const actual = await vi.importActual<
          typeof import("../../../plugins/payload-verification.js")
        >("../../../plugins/payload-verification.js");
        return await actual.runPluginPayloadSmokeCheck(params);
      });

      const result = await runPostCorePluginConvergence({
        cfg: { plugins: { entries: { email: { enabled: true } } } },
        env: { OPENCLAW_STATE_DIR: stateDir },
        baselineInstallRecords: records,
      });

      expect(fs.lstatSync(staleHostDir).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(staleHostDir)).toBe(fs.realpathSync(process.cwd()));
      expect(result.errored).toBe(false);
      expect(result.smokeFailures).toEqual([]);
    },
  );

  it("forwards baselineInstallRecords to repair so sync/npm in-memory mutations are preserved", async () => {
    const baseline = { matrix: { source: "npm" as const, installPath: "/p/matrix" } };
    const cfg = {
      plugins: { entries: { matrix: { enabled: true } } },
    } as unknown as OpenClawConfig;
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: [],
      warnings: [],
      records: baseline,
    });
    await runPostCorePluginConvergence({
      cfg,
      env: {},
      baselineInstallRecords: baseline,
    });
    expect(mocks.maybeRepairStaleManagedNpmBundledPlugins).toHaveBeenCalledWith({
      config: cfg,
      env: {
        OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
      installRecords: baseline,
      prompter: { shouldRepair: true },
    });
    expect(mocks.repairMissingConfiguredPluginInstalls).toHaveBeenCalledTimes(1);
    expect(mocks.repairMissingConfiguredPluginInstalls).toHaveBeenCalledWith({
      cfg,
      env: {
        OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
      baselineRecords: baseline,
    });
  });

  it("prunes stale local bundled plugin shadows from baseline records before repair", async () => {
    const bundledRoot = tempDirs.make("openclaw-post-core-convergence-");
    writeBundledPlugin(bundledRoot, "discord");
    const baseline = {
      discord: {
        source: "path" as const,
        installPath: path.join(
          tempDirs.make("openclaw-post-core-convergence-"),
          "dist",
          "extensions",
          "discord",
        ),
        version: "2026.5.4-beta.3",
      },
      brave: { source: "npm" as const, installPath: "/p/brave" },
    };
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: [],
      warnings: [],
      records: { brave: baseline.brave },
    });
    const cfg = {
      plugins: { entries: { discord: { enabled: true }, brave: { enabled: true } } },
    } as unknown as OpenClawConfig;

    const result = await runPostCorePluginConvergence({
      cfg,
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        VITEST: "true",
      },
      baselineInstallRecords: baseline,
    });

    expect(mocks.repairMissingConfiguredPluginInstalls).toHaveBeenCalledWith({
      cfg,
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        VITEST: "true",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
      baselineRecords: {
        brave: baseline.brave,
      },
    });
    expect(result.changes).toEqual([
      'Removed stale local bundled plugin install record "discord".',
    ]);
    expect(result.installRecords).toEqual({ brave: baseline.brave });
  });

  it("keeps repair warnings nonblocking with actionable guidance", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: [],
      warnings: [
        'Failed to install missing configured plugin "discord" from @openclaw/discord: ENETUNREACH.',
      ],
      records: {},
    });
    const result = await runPostCorePluginConvergence({
      cfg: {
        plugins: { entries: { discord: { enabled: true } } },
      } as unknown as OpenClawConfig,
      env: {},
    });
    expect(result.errored).toBe(false);
    expect(result.warnings).toStrictEqual([
      {
        reason:
          'Failed to install missing configured plugin "discord" from @openclaw/discord: ENETUNREACH.',
        message:
          'Failed to install missing configured plugin "discord" from @openclaw/discord: ENETUNREACH.',
        guidance: ["Run `openclaw update repair` to retry plugin repair."],
      },
    ]);
  });

  it("keeps failed configured-plugin repair fetches nonblocking", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: [],
      warnings: [
        'Failed to install missing configured plugin "matrix" from clawhub:@openclaw/matrix@beta: ClawHub ClawPack download for @openclaw/matrix@2026.6.1-beta.1 body stalled after 30000ms.',
      ],
      failedPluginIds: ["matrix"],
      records: {},
    });
    const result = await runPostCorePluginConvergence({
      cfg: {
        plugins: { entries: { matrix: { enabled: true } } },
      } as unknown as OpenClawConfig,
      env: {},
    });
    expect(result.errored).toBe(false);
    expect(result.outcomes).toBeUndefined();
    expect(result.warnings).toStrictEqual([
      {
        reason:
          'Failed to install missing configured plugin "matrix" from clawhub:@openclaw/matrix@beta: ClawHub ClawPack download for @openclaw/matrix@2026.6.1-beta.1 body stalled after 30000ms.',
        message:
          'Failed to install missing configured plugin "matrix" from clawhub:@openclaw/matrix@beta: ClawHub ClawPack download for @openclaw/matrix@2026.6.1-beta.1 body stalled after 30000ms.',
        guidance: ["Run `openclaw update repair` to retry plugin repair."],
      },
    ]);
    expect(mocks.runPluginPayloadSmokeCheck).toHaveBeenCalledWith({
      records: {},
      env: expect.any(Object),
    });
  });

  it("blocks convergence when a missing plugin cannot activate without capability consent", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: [],
      warnings: ['Plugin "consent-fixture" requires capability consent.'],
      failedPluginIds: ["consent-fixture"],
      outcomes: [
        {
          pluginId: "consent-fixture",
          status: "error",
          code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
          message: 'Plugin "consent-fixture" requires capability consent.',
        },
      ],
      records: {},
    });

    const result = await runPostCorePluginConvergence({
      cfg: { plugins: { entries: { "consent-fixture": { enabled: true } } } },
      env: {},
    });

    expect(result.errored).toBe(true);
    expect(result.warnings).toEqual([
      expect.objectContaining({ message: 'Plugin "consent-fixture" requires capability consent.' }),
    ]);
    expect(result.smokeFailures).toEqual([]);
    expect(result.installRecords).toEqual({});
  });

  it("keeps inactive repair failures nonblocking", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: [],
      warnings: [
        'Failed to install missing configured plugin "discord" from @openclaw/discord: ENETUNREACH.',
      ],
      failedPluginIds: ["discord"],
      records: {
        discord: {
          source: "npm",
          spec: "@acme/discord",
          installPath: "/p/discord",
        },
      },
    });
    const result = await runPostCorePluginConvergence({
      cfg: {
        plugins: {
          deny: ["discord"],
          entries: { discord: { enabled: true } },
        },
      } as unknown as OpenClawConfig,
      env: {},
    });
    expect(result.errored).toBe(false);
    expect(mocks.runPluginPayloadSmokeCheck).toHaveBeenCalledWith({
      records: {},
      env: expect.any(Object),
    });
  });

  it("surfaces repair notices without marking convergence errored", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: ['Installed missing configured plugin "discord".'],
      notices: [
        'ClawHub trust warning for "@openclaw/discord@1.2.3": ClawHub has not completed a fresh clean security check for this release. Status: security scan is pending. Review the package before enabling it.',
      ],
      warnings: [],
      records: { discord: { source: "clawhub", installPath: "/p/discord" } },
    });
    const result = await runPostCorePluginConvergence({
      cfg: {
        plugins: { entries: { discord: { enabled: true } } },
      } as unknown as OpenClawConfig,
      env: {},
    });
    expect(result.errored).toBe(false);
    expect(result.warnings).toStrictEqual([]);
    expect(result.notices).toStrictEqual([
      {
        reason:
          'ClawHub trust warning for "@openclaw/discord@1.2.3": ClawHub has not completed a fresh clean security check for this release. Status: security scan is pending. Review the package before enabling it.',
        message:
          'ClawHub trust warning for "@openclaw/discord@1.2.3": ClawHub has not completed a fresh clean security check for this release. Status: security scan is pending. Review the package before enabling it.',
        guidance: [],
      },
    ]);
  });

  it("flags errored=true when smoke check finds a missing main entry", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: [],
      warnings: [],
      records: { brave: { source: "npm", installPath: "/p/brave" } },
    });
    mocks.runPluginPayloadSmokeCheck.mockResolvedValue({
      checked: ["brave"],
      failures: [
        {
          pluginId: "brave",
          installPath: "/p/brave",
          reason: "missing-main-entry",
          detail: 'Plugin main entry "dist/index.js" not found at /p/brave/dist/index.js',
        },
      ],
    });
    const result = await runPostCorePluginConvergence({
      cfg: {
        plugins: { entries: { brave: { enabled: true } } },
      } as unknown as OpenClawConfig,
      env: {},
    });
    expect(result.errored).toBe(true);
    expect(result.warnings).toStrictEqual([
      {
        pluginId: "brave",
        reason:
          'missing-main-entry: Plugin main entry "dist/index.js" not found at /p/brave/dist/index.js',
        message:
          'Plugin "brave" failed post-core payload smoke check (missing-main-entry): Plugin main entry "dist/index.js" not found at /p/brave/dist/index.js',
        guidance: [
          "Run `openclaw update repair` to retry plugin repair.",
          "Run `openclaw plugins inspect brave --runtime --json` for details.",
        ],
      },
    ]);
  });

  it("flags errored=true when smoke check finds a missing install path", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: [],
      warnings: [],
      records: { brave: { source: "npm" } },
    });
    mocks.runPluginPayloadSmokeCheck.mockResolvedValue({
      checked: ["brave"],
      failures: [
        {
          pluginId: "brave",
          reason: "missing-install-path",
          detail: "Install path is missing from the plugin install record.",
        },
      ],
    });
    const result = await runPostCorePluginConvergence({
      cfg: {
        plugins: { entries: { brave: { enabled: true } } },
      } as unknown as OpenClawConfig,
      env: {},
    });
    expect(result.errored).toBe(true);
    expect(result.warnings).toStrictEqual([
      {
        pluginId: "brave",
        reason: "missing-install-path: Install path is missing from the plugin install record.",
        message:
          'Plugin "brave" failed post-core payload smoke check (missing-install-path): Install path is missing from the plugin install record.',
        guidance: [
          "Run `openclaw update repair` to retry plugin repair.",
          "Run `openclaw plugins inspect brave --runtime --json` for details.",
        ],
      },
    ]);
  });

  it("uses ownership guidance for unreadable package.json", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: [],
      warnings: [],
      records: { brave: { source: "npm", installPath: "/p/brave" } },
    });
    mocks.runPluginPayloadSmokeCheck.mockResolvedValue({
      checked: ["brave"],
      failures: [
        {
          pluginId: "brave",
          installPath: "/p/brave",
          reason: "unreadable-package-json",
          detail: "Could not read package.json at /p/brave/package.json: EACCES: permission denied",
        },
      ],
    });

    const result = await runPostCorePluginConvergence({
      cfg: {
        plugins: { entries: { brave: { enabled: true } } },
      } as unknown as OpenClawConfig,
      env: {},
    });

    const message =
      'Plugin "brave" failed post-core payload smoke check (unreadable-package-json): Could not read package.json at /p/brave/package.json: EACCES: permission denied';
    const guidance = [
      "Fix file access for /p/brave/package.json so it is readable by the user running OpenClaw. For EACCES or EPERM, correct its ownership or permissions; otherwise resolve the reported filesystem I/O error, then retry.",
      "Run `openclaw plugins inspect brave --runtime --json` for details.",
    ];
    expect(result.warnings).toStrictEqual([
      {
        pluginId: "brave",
        reason:
          "unreadable-package-json: Could not read package.json at /p/brave/package.json: EACCES: permission denied",
        message,
        guidance,
      },
    ]);
    expect(result.errored).toBe(true);
  });

  it("does not duplicate a package-scoped repair error owned by a smoke failure", async () => {
    const installPath = "/tmp/openclaw-state/npm/projects/brave/node_modules/brave";
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: [],
      warnings: [],
      records: { brave: { source: "npm", installPath } },
    });
    mocks.relinkOpenClawPeerDependenciesInManagedNpmRoot.mockImplementation(
      async (params: { onPackageReadError?: (error: unknown, packageDir: string) => void }) => {
        params.onPackageReadError?.(
          new Error(`EACCES: permission denied, open '${installPath}/package.json'`),
          installPath,
        );
        return { checked: 0, attempted: 0, repaired: 0, skipped: 1 };
      },
    );
    mocks.runPluginPayloadSmokeCheck.mockResolvedValue({
      checked: ["brave"],
      failures: [
        {
          pluginId: "brave",
          installPath,
          reason: "unreadable-package-json",
          detail: `Could not read package.json at ${installPath}/package.json: EACCES: permission denied`,
        },
      ],
    });

    const result = await runPostCorePluginConvergence({
      cfg: {
        plugins: { entries: { brave: { enabled: true } } },
      } as unknown as OpenClawConfig,
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      pluginId: "brave",
      reason: expect.stringContaining("unreadable-package-json"),
    });
    expect(result.errored).toBe(true);
  });

  it("keeps an active __proto__ record in smoke and package-path classification", async () => {
    const installPath = "/tmp/openclaw-state/npm/projects/__proto__/node_modules/__proto__";
    const record: PluginInstallRecord = { source: "npm", installPath };
    const records = Object.create(null) as Record<string, PluginInstallRecord>;
    Object.defineProperty(records, "__proto__", {
      configurable: true,
      enumerable: true,
      value: record,
      writable: true,
    });
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: [],
      warnings: [],
      records,
    });
    mocks.relinkOpenClawPeerDependenciesInManagedNpmRoot.mockImplementation(
      async (params: { onPackageReadError?: (error: unknown, packageDir: string) => void }) => {
        params.onPackageReadError?.(new Error("EACCES: permission denied"), installPath);
        return { checked: 0, attempted: 0, repaired: 0, skipped: 1 };
      },
    );
    mocks.runPluginPayloadSmokeCheck.mockImplementation(
      async (params: { records: Record<string, PluginInstallRecord> }) => {
        expect(Object.getPrototypeOf(params.records)).toBeNull();
        expect(Object.keys(params.records)).toEqual(["__proto__"]);
        expect(Object.getOwnPropertyDescriptor(params.records, "__proto__")?.value).toBe(record);
        return {
          checked: ["__proto__"],
          failures: [
            {
              pluginId: "__proto__",
              installPath,
              reason: "unreadable-package-json",
              detail: `Could not read package.json at ${installPath}/package.json: EACCES`,
            },
          ],
        };
      },
    );

    const result = await runPostCorePluginConvergence({
      cfg: { plugins: { enabled: true } } as unknown as OpenClawConfig,
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      pluginId: "__proto__",
      reason: expect.stringContaining("unreadable-package-json"),
    });
    expect(result.errored).toBe(true);
  });

  it("does not promote an inactive package read error into an ownerless blocker", async () => {
    const installPath = "/tmp/openclaw-state/npm/projects/brave/node_modules/brave";
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: [],
      warnings: [],
      records: { brave: { source: "npm", installPath } },
    });
    mocks.relinkOpenClawPeerDependenciesInManagedNpmRoot.mockImplementation(
      async (params: { onPackageReadError?: (error: unknown, packageDir: string) => void }) => {
        params.onPackageReadError?.(
          new Error(`EACCES: permission denied, open '${installPath}/package.json'`),
          installPath,
        );
        return { checked: 0, attempted: 0, repaired: 0, skipped: 1 };
      },
    );

    const result = await runPostCorePluginConvergence({
      cfg: {
        plugins: { entries: { brave: { enabled: false } } },
      } as unknown as OpenClawConfig,
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
    });

    expect(mocks.runPluginPayloadSmokeCheck).toHaveBeenCalledWith({
      records: {},
      env: expect.any(Object),
    });
    expect(result.warnings).toEqual([]);
    expect(result.errored).toBe(false);
  });

  it("keeps an unowned package read error visible for startup to block", async () => {
    const packageDir = "/tmp/openclaw-state/npm/node_modules/untracked";
    mocks.relinkOpenClawPeerDependenciesInManagedNpmRoot.mockImplementation(
      async (params: { onPackageReadError?: (error: unknown, packageDir: string) => void }) => {
        params.onPackageReadError?.(new Error("EACCES: permission denied"), packageDir);
        return { checked: 0, attempted: 0, repaired: 0, skipped: 1 };
      },
    );

    const result = await runPostCorePluginConvergence({
      cfg: { plugins: { entries: {} } } as unknown as OpenClawConfig,
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
    });

    expect(result.warnings).toStrictEqual([
      {
        reason: "Failed to repair managed npm OpenClaw host peer links: EACCES: permission denied",
        message: "Failed to repair managed npm OpenClaw host peer links: EACCES: permission denied",
        guidance: ["Run `openclaw update repair` to retry plugin repair."],
      },
    ]);
    expect(result.errored).toBe(false);
  });

  it("hands repair's post-mutation records straight to the smoke check (no second disk read)", async () => {
    const records = { brave: { source: "npm" as const, installPath: "/p/brave" } };
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: ["Repaired"],
      warnings: [],
      records,
    });
    await runPostCorePluginConvergence({
      cfg: {
        plugins: { entries: { brave: { enabled: true } } },
      } as unknown as OpenClawConfig,
      env: {},
    });
    expect(mocks.runPluginPayloadSmokeCheck).toHaveBeenCalledTimes(1);
    expect(mocks.runPluginPayloadSmokeCheck).toHaveBeenCalledWith({
      records,
      env: {
        OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
    });
  });
});

describe("filterRecordsToActive", () => {
  it.each(["__proto__", "constructor", "toString"] as const)(
    "retains active %s records as own enumerable entries without cloning",
    (pluginId) => {
      const record: PluginInstallRecord = { source: "npm", installPath: `/p/${pluginId}` };
      const records = Object.create(null) as Record<string, PluginInstallRecord>;
      Object.defineProperty(records, pluginId, {
        configurable: true,
        enumerable: true,
        value: record,
        writable: true,
      });

      const filtered = filterRecordsToActive({
        cfg: { plugins: { enabled: true } } as unknown as OpenClawConfig,
        records,
      });

      expect(Object.getPrototypeOf(filtered)).toBeNull();
      expect(Object.keys(filtered)).toEqual([pluginId]);
      expect(Object.hasOwn(filtered, pluginId)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(filtered, pluginId)).toMatchObject({
        enumerable: true,
        value: record,
      });
      expect(filtered[pluginId]).toBe(record);
    },
  );

  it("retains records for plugins whose entry is enabled", () => {
    const records = {
      enabled: { source: "npm" as const, installPath: "/p/enabled" },
    };
    const filtered = filterRecordsToActive({
      cfg: {
        plugins: { enabled: true, entries: { enabled: { enabled: true } } },
      } as unknown as OpenClawConfig,
      records,
    });
    expect(filtered).toEqual(records);
  });

  it("drops records for plugins whose entry is explicitly disabled", () => {
    const records = {
      "stale-disabled": { source: "npm" as const, installPath: "/p/stale" },
      "active-plugin": { source: "npm" as const, installPath: "/p/active" },
    };
    const filtered = filterRecordsToActive({
      cfg: {
        plugins: {
          enabled: true,
          entries: {
            "stale-disabled": { enabled: false },
            "active-plugin": { enabled: true },
          },
        },
      } as unknown as OpenClawConfig,
      records,
    });
    expect(filtered).toEqual({
      "active-plugin": { source: "npm", installPath: "/p/active" },
    });
  });

  it("drops records for plugins listed in plugins.deny", () => {
    const records = {
      denied: { source: "npm" as const, installPath: "/p/denied" },
    };
    const filtered = filterRecordsToActive({
      cfg: {
        plugins: {
          enabled: true,
          deny: ["denied"],
        },
      } as unknown as OpenClawConfig,
      records,
    });
    expect(filtered).toEqual({});
  });

  it("retains a disabled trusted-source-linked official npm install (mirroring syncOfficialPluginInstalls policy)", () => {
    // The Codex install record carries the trusted-source marker. The
    // existing post-update sync path treats it as authoritative regardless
    // of the entry's enable flag, so the convergence smoke check must too.
    const records = {
      codex: {
        source: "npm" as const,
        spec: "@openclaw/codex",
        installPath: "/p/codex",
        trustedSourceLinkedOfficial: true,
      },
    };
    const filtered = filterRecordsToActive({
      cfg: {
        plugins: {
          enabled: true,
          entries: { codex: { enabled: false } },
        },
      } as unknown as OpenClawConfig,
      records,
    });
    expect(filtered).toEqual(records);
  });
});
