import { vi } from "vitest";

export type StateMigrationResult = {
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
};

const maybeRepairPluginOpenClawHostLinks = vi.hoisted(() =>
  vi.fn(
    async (_params: {
      env: NodeJS.ProcessEnv;
      prompter: { shouldRepair: boolean };
    }): Promise<boolean> => false,
  ),
);

vi.mock("./doctor-plugin-host-links.js", () => ({
  maybeRepairPluginOpenClawHostLinks,
}));

export function getMaybeRepairPluginOpenClawHostLinksMock() {
  return maybeRepairPluginOpenClawHostLinks;
}

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

export const stateCheckpointOptions = {
  migrateState: true,
  migrateLegacyConfig: false,
  invalidConfigNote: false,
  requireStateMigrationCheckpoint: true,
} as const;

export const startupCheckpointOptions = {
  migrateLegacyConfig: false,
  invalidConfigNote: false,
  requireStartupMigrationCheckpoint: true,
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
