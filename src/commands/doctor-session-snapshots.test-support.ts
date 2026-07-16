import type { SessionEntry } from "../config/sessions/types.js";
import "./doctor-session-snapshots.js";

type SnapshotPathSource =
  | "skillsSnapshot.prompt"
  | "skillsSnapshot.resolvedSkills"
  | "systemPromptReport.injectedWorkspaceFiles";

type TestApi = {
  resolveSessionSnapshotBundledSkillsDir(params?: {
    bundledSkillsDir?: string;
    argv1?: string;
    moduleUrl?: string;
    cwd?: string;
    execPath?: string;
  }): string | undefined;
  scanSessionStoreForStaleRuntimeSnapshotPaths(params: {
    store: Record<string, SessionEntry>;
    bundledSkillsDir: string | undefined;
    pathExists?: (filePath: string) => boolean;
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
  }): Array<{
    sessionKey: string;
    field: SnapshotPathSource;
    cachedPath: string;
    expectedPath: string;
  }>;
};

function getTestApi(): TestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.doctorSessionSnapshotsTestApi")
  ] as TestApi;
}

export const resolveSessionSnapshotBundledSkillsDir: TestApi["resolveSessionSnapshotBundledSkillsDir"] =
  (params) => getTestApi().resolveSessionSnapshotBundledSkillsDir(params);

export const scanSessionStoreForStaleRuntimeSnapshotPaths: TestApi["scanSessionStoreForStaleRuntimeSnapshotPaths"] =
  (params) => getTestApi().scanSessionStoreForStaleRuntimeSnapshotPaths(params);
