// Backup test support provides temp config/state fixtures and mocked backup runtime helpers.
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { deleteTestEnvValue } from "../test-utils/env.js";
import * as backupShared from "./backup-shared.js";

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
  await fs.writeFile(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({ agents: { ownership: "explicit", entries: {} } }),
    "utf8",
  );
  const plan = await backupShared.resolveBackupPlanFromDisk({
    includeWorkspace: false,
    nowMs: 123,
  });
  vi.spyOn(backupShared, "resolveBackupPlanFromDisk").mockResolvedValue(plan);
}
