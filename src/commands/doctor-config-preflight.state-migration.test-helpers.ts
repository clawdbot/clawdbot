import { vi } from "vitest";

export type StateMigrationResult = {
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
};

type StartupConvergenceWarning = {
  pluginId?: string;
  reason: string;
  message: string;
  guidance: string[];
};

export type StartupSmokeFailure = {
  pluginId: string;
  installPath?: string;
  reason: "missing-install-path" | "missing-main-entry" | "unreadable-package-json";
  detail: string;
};

export type StartupConvergenceResult = {
  changes: string[];
  notices?: StartupConvergenceWarning[];
  warnings: StartupConvergenceWarning[];
  errored: boolean;
  smokeFailures: StartupSmokeFailure[];
  installRecords: Record<string, unknown>;
};

export function mockLegacyPluginModelCatalogDetection(): void {
  vi.doMock("./doctor-plugin-model-catalog-detection.js", () => ({
    detectLegacyPluginModelCatalogs: vi.fn(async () => ({
      detected: [],
      migrations: [],
      warnings: [],
    })),
    findLegacyPluginCatalogStartupRefusal: vi.fn(async () => undefined),
    formatLegacyPluginModelCatalogStartupRefusal: vi.fn(),
  }));
}

export const currentCheckpointPluginVerificationStages = [
  "doctor.config-preflight.startup-checkpoint-import",
  "doctor.config-preflight.pristine-state-plan-import",
  "doctor.config-preflight.pristine-state-plan",
  "doctor.config-preflight.config-snapshot",
  "doctor.config-preflight.legacy-plugin-model-catalog-detection-import",
  "doctor.config-preflight.legacy-plugin-model-catalog-detection",
  "doctor.config-preflight.plugin-plan-import",
  "doctor.config-preflight.plugin-plan",
  "doctor.config-preflight.plugin-payload-verification-import",
  "doctor.config-preflight.plugin-payload-verification",
] as const;

export const stateCheckpointOptions = {
  migrateState: true,
  migrateLegacyConfig: false,
  invalidConfigNote: false,
  requireStateMigrationCheckpoint: true,
} as const;

export function makeStartupConvergenceResult(
  overrides: Partial<StartupConvergenceResult> = {},
): StartupConvergenceResult {
  return {
    changes: [],
    notices: [],
    warnings: [],
    errored: false,
    smokeFailures: [],
    installRecords: {},
    ...overrides,
  };
}
