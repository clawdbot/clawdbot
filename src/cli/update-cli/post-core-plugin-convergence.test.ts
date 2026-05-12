import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repairMissingConfiguredPluginInstalls: vi.fn(),
  runPluginPayloadSmokeCheck: vi.fn(),
}));

vi.mock("../../commands/doctor/shared/missing-configured-plugin-install.js", () => ({
  repairMissingConfiguredPluginInstalls: mocks.repairMissingConfiguredPluginInstalls,
}));
vi.mock("./plugin-payload-validation.js", () => ({
  runPluginPayloadSmokeCheck: mocks.runPluginPayloadSmokeCheck,
}));

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  convergenceWarningsToOutcomes,
  filterRecordsToActive,
  runPostCorePluginConvergence,
} from "./post-core-plugin-convergence.js";

describe("runPostCorePluginConvergence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: [],
      warnings: [],
      records: {},
    });
    mocks.runPluginPayloadSmokeCheck.mockResolvedValue({ checked: [], failures: [] });
  });

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
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
      baselineRecords: baseline,
    });
  });

  it("flags errored=true and surfaces actionable guidance when repair warns", async () => {
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
    expect(result.errored).toBe(true);
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
