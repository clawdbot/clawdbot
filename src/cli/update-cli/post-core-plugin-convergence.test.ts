import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listManagedPluginNpmRoots: vi.fn(),
  repairMissingConfiguredPluginInstalls: vi.fn(),
  relinkOpenClawPeerDependenciesInManagedNpmRoot: vi.fn(),
  runPluginPayloadSmokeCheck: vi.fn(),
}));

vi.mock("../../commands/doctor/shared/missing-configured-plugin-install.js", () => ({
  repairMissingConfiguredPluginInstalls: mocks.repairMissingConfiguredPluginInstalls,
}));
vi.mock("../../plugins/plugin-peer-link.js", () => ({
  relinkOpenClawPeerDependenciesInManagedNpmRoot:
    mocks.relinkOpenClawPeerDependenciesInManagedNpmRoot,
}));
vi.mock("../../plugins/npm-project-roots.js", () => ({
  listManagedPluginNpmRoots: mocks.listManagedPluginNpmRoots,
}));
vi.mock("./plugin-payload-validation.js", () => ({
  runPluginPayloadSmokeCheck: mocks.runPluginPayloadSmokeCheck,
}));

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { VERSION } from "../../version.js";
import {
  convergenceWarningsToOutcomes,
  filterRecordsToActive,
  runPostCorePluginConvergence,
} from "./post-core-plugin-convergence.js";

describe("runPostCorePluginConvergence", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listManagedPluginNpmRoots.mockImplementation((npmRoot: string) =>
      Promise.resolve([npmRoot]),
    );
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

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-post-core-convergence-"));
    tempDirs.push(dir);
    return dir;
  }

  function writeBundledPlugin(rootDir: string, pluginId: string): string {
    const pluginDir = path.join(rootDir, pluginId);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "index.js"), "export default {};\n", "utf8");
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        name: pluginId,
        version: "2026.5.20-beta.1",
        configSchema: { type: "object" },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: `@openclaw/${pluginId}`,
        version: "2026.5.20-beta.1",
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
    expect(mocks.repairMissingConfiguredPluginInstalls).toHaveBeenCalledWith({
      cfg,
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
    });
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
    });
    expect(mocks.relinkOpenClawPeerDependenciesInManagedNpmRoot).toHaveBeenNthCalledWith(2, {
      npmRoot: "/tmp/openclaw-state/npm/projects/codex",
      logger: {},
    });
    expect(result.changes).toEqual([
      "Repaired OpenClaw host peer link(s) for 1 managed npm plugin package(s).",
    ]);
    expect(
      mocks.relinkOpenClawPeerDependenciesInManagedNpmRoot.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.runPluginPayloadSmokeCheck.mock.invocationCallOrder[0]);
  });

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
    const bundledRoot = makeTempDir();
    writeBundledPlugin(bundledRoot, "discord");
    const baseline = {
      discord: {
        source: "path" as const,
        installPath: path.join(makeTempDir(), "dist", "extensions", "discord"),
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
        guidance: ["Run `openclaw doctor --fix` to retry plugin repair."],
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
          "Run `openclaw doctor --fix` to retry plugin repair.",
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
          "Run `openclaw doctor --fix` to retry plugin repair.",
          "Run `openclaw plugins inspect brave --runtime --json` for details.",
        ],
      },
    ]);
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

describe("convergenceWarningsToOutcomes", () => {
  it("emits per-plugin error outcomes for warnings that name a pluginId", () => {
    const folded = convergenceWarningsToOutcomes({
      changes: [],
      warnings: [
        {
          pluginId: "brave",
          reason: "missing-main-entry: …",
          message: 'Plugin "brave" failed payload smoke check.',
          guidance: ["Run `openclaw doctor --fix`."],
        },
        {
          reason: "Failed install",
          message: "Failed install for some plugin.",
          guidance: ["Run `openclaw doctor --fix`."],
        },
      ],
      errored: true,
      smokeFailures: [],
      installRecords: {},
    });
    expect(folded.errored).toBe(true);
    expect(folded.outcomes).toEqual([
      { pluginId: "brave", status: "error", message: 'Plugin "brave" failed payload smoke check.' },
    ]);
    expect(folded.warnings).toHaveLength(2);
  });

  it("returns errored=false and no outcomes for a clean convergence", () => {
    const folded = convergenceWarningsToOutcomes({
      changes: ["Repaired."],
      warnings: [],
      errored: false,
      smokeFailures: [],
      installRecords: {},
    });
    expect(folded).toEqual({ warnings: [], outcomes: [], errored: false });
  });
});

describe("filterRecordsToActive", () => {
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
