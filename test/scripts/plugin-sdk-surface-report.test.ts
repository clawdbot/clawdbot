// Plugin Sdk Surface Report tests cover plugin sdk surface report script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  collectPluginSdkSurfaceReport,
  evaluatePluginSdkSurfaceReport,
  readPluginSdkSurfaceBudgets,
} from "../../scripts/plugin-sdk-surface-report.mjs";

const pluginSdkSurfaceBudgetEnvPattern = /^OPENCLAW_PLUGIN_SDK_MAX_/u;

function baseSurfaceReportEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !pluginSdkSurfaceBudgetEnvPattern.test(key)),
  );
}

function runSurfaceReport(env: Record<string, string>) {
  return spawnSync(process.execPath, ["scripts/plugin-sdk-surface-report.mjs", "--check"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...baseSurfaceReportEnv(),
      ...env,
    },
  });
}

type PublicSurfaceCounts = {
  callableExports: number;
  exports: number;
  wildcardReexports: number;
};

function readDefaultPublicSurfaceBudgets(): PublicSurfaceCounts {
  const { budgets } = readPluginSdkSurfaceBudgets({});
  return {
    exports: budgets.publicExports,
    callableExports: budgets.publicFunctionExports,
    wildcardReexports: budgets.publicWildcardReexports,
  };
}

type SurfaceReport = ReturnType<typeof collectPluginSdkSurfaceReport>;
let surfaceReport: SurfaceReport;

function readCurrentPublicSurfaceCounts(): PublicSurfaceCounts {
  return {
    exports: surfaceReport.publicStats.totals.exports,
    callableExports: surfaceReport.publicStats.totals.callableExports,
    wildcardReexports: surfaceReport.publicWildcards.count,
  };
}

describe("plugin SDK surface report", () => {
  beforeAll(() => {
    surfaceReport = collectPluginSdkSurfaceReport();
  });

  it("rejects unknown CLI options before collecting SDK stats", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/plugin-sdk-surface-report.mjs", "--chekc"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown plugin SDK surface report option: --chekc");
    expect(result.stderr).not.toContain("at ");
  });

  it("prints help before collecting SDK stats", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/plugin-sdk-surface-report.mjs", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: node scripts/plugin-sdk-surface-report.mjs");
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("all SDK entrypoints:");
  });

  it("rejects loose numeric budget env vars before collecting SDK stats", () => {
    const result = runSurfaceReport({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS: "1e9",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS must be a non-negative integer",
    );
    expect(result.stderr).not.toContain("at ");
  });

  it("rejects unsafe budget env vars before collecting SDK stats", () => {
    const result = runSurfaceReport({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS: "9007199254740992",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS must be a safe non-negative integer",
    );
    expect(result.stderr).not.toContain("at ");
  });

  it("accepts exact deprecated export budget overrides by public entrypoint", () => {
    const budgetConfig = readPluginSdkSurfaceBudgets({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS_BY_ENTRYPOINT: JSON.stringify({ core: 2 }),
    });

    expect(evaluatePluginSdkSurfaceReport(surfaceReport, budgetConfig)).not.toContain(
      expect.stringContaining("public deprecated exports in core"),
    );
  });

  it("keeps default public surface budgets pinned to current source counts", () => {
    expect(readDefaultPublicSurfaceBudgets()).toEqual(readCurrentPublicSurfaceCounts());
  });

  it("keeps approval store internals out of the deprecated infra barrel", () => {
    const source = fs.readFileSync("src/plugin-sdk/infra-runtime.ts", "utf8");
    expect(source).not.toMatch(/export\s+(?:type\s+)?\*\s+from\s+["'][^"']*exec-approvals/u);

    for (const internalName of [
      "ensureExecApprovalsSnapshot",
      "persistAllowAlwaysDecisionLocked",
      "recordAllowlistMatchesUseLocked",
      "resolveExecApprovalsLocked",
      "restoreExecApprovalsSnapshotLocked",
      "updateExecApprovals",
    ]) {
      expect(source).not.toContain(internalName);
    }
  });

  it("keeps generated package declarations out of source surface counts", () => {
    const budget = readDefaultPublicSurfaceBudgets().callableExports;
    const budgetConfig = readPluginSdkSurfaceBudgets({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_FUNCTION_EXPORTS: String(budget - 1),
    });

    expect(evaluatePluginSdkSurfaceReport(surfaceReport, budgetConfig)).toContain(
      `public callable exports ${budget} > ${budget - 1}`,
    );
  });

  it("strips ambient CI budget overrides from CLI checks", () => {
    const original = process.env.OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS;
    process.env.OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS = "1";
    try {
      expect(baseSurfaceReportEnv()).not.toHaveProperty("OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS");
    } finally {
      if (original === undefined) {
        delete process.env.OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS;
      } else {
        process.env.OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS = original;
      }
    }
  });

  it("rejects deprecated export growth by public entrypoint", () => {
    const budgetConfig = readPluginSdkSurfaceBudgets({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS_BY_ENTRYPOINT: JSON.stringify({ core: 1 }),
    });

    expect(evaluatePluginSdkSurfaceReport(surfaceReport, budgetConfig)).toContain(
      "public deprecated exports in core 2 > 1",
    );
  });
});
