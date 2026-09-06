import { expect, vi } from "vitest";

export function makePreflightConfigSnapshot(config: Record<string, unknown>) {
  return {
    exists: true,
    valid: true,
    config,
    sourceConfig: config,
    parsed: config,
    legacyIssues: [] as Array<{ path: string; message: string }>,
    warnings: [] as Array<{ path: string; message: string }>,
    issues: [] as Array<{ path: string; message: string }>,
  };
}

export function queueConfigSnapshot<T>(
  reader: { mockResolvedValueOnce(snapshot: T): unknown },
  snapshot: T,
  count = 1,
): void {
  for (let index = 0; index < count; index += 1) {
    reader.mockResolvedValueOnce(snapshot);
  }
}

export function expectMigrationIdentity(): {
  effectiveConfigFingerprint: unknown;
  pluginDoctorConfigFingerprint: unknown;
  pluginMigrationFingerprint: string;
} {
  return {
    effectiveConfigFingerprint: expect.any(String),
    pluginDoctorConfigFingerprint: expect.any(String),
    pluginMigrationFingerprint: "plugin-migrations",
  };
}

export type StateMigrationResult = {
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
};

export function makeStateMigrationResult(changes: string[], migrated = true): StateMigrationResult {
  return { migrated, skipped: false, changes, warnings: [] };
}

const maybeRepairPluginOpenClawHostLinks = vi.hoisted(() =>
  vi.fn(
    async (_params: {
      env: NodeJS.ProcessEnv;
      prompter: { shouldRepair: boolean };
    }): Promise<boolean> => false,
  ),
);

vi.mock("./doctor-plugin-host-links.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-plugin-host-links.js")>();
  return { ...actual, maybeRepairPluginOpenClawHostLinks };
});

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
