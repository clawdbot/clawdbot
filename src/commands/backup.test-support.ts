// Backup test support provides temp config/state fixtures and mocked backup runtime helpers.
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { deleteTestEnvValue } from "../test-utils/env.js";
import * as backupShared from "./backup-shared.js";
import type { BackupAsset } from "./backup-shared.js";

type BackupPlan = {
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs: string[];
  included: BackupAsset[];
  skipped: Array<{
    kind: "state" | "config" | "credentials" | "workspace";
    sourcePath: string;
    displayPath: string;
    reason: "covered" | "missing";
    coveredBy?: string;
  }>;
};

type ResolveBackupPlanFromPathsParams = {
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs?: string[];
  includeWorkspace?: boolean;
  onlyConfig?: boolean;
  configInsideState?: boolean;
  oauthInsideState?: boolean;
  nowMs?: number;
};

type BackupPlanTestApi = {
  resolveBackupPlanFromPaths(params: ResolveBackupPlanFromPathsParams): Promise<BackupPlan>;
};

function getBackupPlanTestApi(): BackupPlanTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.backupPlanTestApi")
  ] as BackupPlanTestApi;
}

export async function resolveBackupPlanFromPaths(
  params: ResolveBackupPlanFromPathsParams,
): Promise<BackupPlan> {
  return await getBackupPlanTestApi().resolveBackupPlanFromPaths(params);
}

const backupTestMocks = vi.hoisted(() => ({
  backupVerifyCommandMock: vi.fn(),
  tarCreateMock: vi.fn(),
}));

export const { backupVerifyCommandMock, tarCreateMock } = backupTestMocks;

export function createMockTarStream(
  params: {
    beforeRead?: () => Promise<void> | void;
    contents?: string;
    error?: Error;
  } = {},
): Readable {
  return Readable.from(
    (async function* () {
      await params.beforeRead?.();
      if (params.error) {
        throw params.error;
      }
      yield params.contents ?? "archive-bytes";
    })(),
  );
}

vi.mock("tar", () => ({
  c: backupTestMocks.tarCreateMock,
}));

vi.mock("./backup-verify.js", () => ({
  backupVerifyCommand: backupTestMocks.backupVerifyCommandMock,
}));

export function createBackupTestRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } satisfies RuntimeEnv;
}

export async function resetBackupTempHome(tempHome: { home: string }) {
  await fs.rm(tempHome.home, { recursive: true, force: true });
  await fs.mkdir(path.join(tempHome.home, ".openclaw"), { recursive: true });
  deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
}

export async function mockStateOnlyBackupPlan(stateDir: string) {
  await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
  vi.spyOn(backupShared, "resolveBackupPlanFromDisk").mockResolvedValue(
    await resolveBackupPlanFromPaths({
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
      oauthDir: path.join(stateDir, "credentials"),
      includeWorkspace: false,
      configInsideState: true,
      oauthInsideState: true,
      nowMs: 123,
    }),
  );
}
