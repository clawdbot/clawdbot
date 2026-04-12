import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import * as backupShared from "./backup-shared.js";
import { resolveBackupPlanFromPaths } from "./backup-shared.js";

export const tarCreateMock = vi.fn();
export const backupVerifyCommandMock = vi.fn();

vi.mock("tar", () => ({
  c: tarCreateMock,
}));

vi.mock("./backup-verify.js", () => ({
  backupVerifyCommand: backupVerifyCommandMock,
}));

export function createBackupTestRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } satisfies RuntimeEnv;
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
