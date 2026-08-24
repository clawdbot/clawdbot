import type { PluginInstallRecord } from "../config/types.plugins.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-record-reader.js";
import type { InstalledPluginIndexStoreOptions } from "../plugins/installed-plugin-index-store-path.js";
import { readClawHubSkillsLockfile } from "../skills/lifecycle/clawhub-store.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
// Garbage-collects ClawHub packages installed by Claw lifecycles that no
// Claw references anymore. Operator-installed packages are protected: their
// install path marks them independently owned, which persists as a package
// ref, so they never surface as candidates.
import {
  readClawInstallRecords,
  readClawPackageRefs,
  type PersistedClawPackageRef,
} from "./provenance.js";

type ClawGarbagePluginCandidate = {
  installId: string;
  ref: string;
  version?: string;
  installedAt?: string;
};

type ClawGarbageSkillCandidate = {
  ref: string;
  workspace: string;
  version?: string;
};

export type ClawGarbagePlan = {
  plugins: ClawGarbagePluginCandidate[];
  skills: ClawGarbageSkillCandidate[];
};

export type ClawGarbageOptions = OpenClawStateDatabaseOptions & {
  indexOptions?: InstalledPluginIndexStoreOptions;
};

export function clawhubRefOfRecord(record: PluginInstallRecord): string | undefined {
  if (record.source !== "clawhub") {
    return undefined;
  }
  return record.clawhubPackage ?? record.spec?.replace(/^clawhub:/u, "").split("@")[0];
}

/** Pure orphan decision: installed ClawHub artifacts without any package ref. */
export function collectClawGarbageCandidates(params: {
  plugins: Record<string, PluginInstallRecord>;
  skillSlugs: Array<{ ref: string; workspace: string; version?: string }>;
  refs: PersistedClawPackageRef[];
}): ClawGarbagePlan {
  const referencedPlugins = new Set<string>();
  const referencedSkills = new Set<string>();
  for (const ref of params.refs) {
    if (ref.kind === "plugin") {
      referencedPlugins.add(ref.ref);
    } else if (ref.kind === "skill") {
      referencedSkills.add(ref.ref);
    }
  }
  const plugins: ClawGarbagePluginCandidate[] = [];
  for (const [installId, record] of Object.entries(params.plugins)) {
    const ref = clawhubRefOfRecord(record);
    if (!ref || referencedPlugins.has(ref)) {
      continue;
    }
    plugins.push({
      installId,
      ref,
      ...(record.version ? { version: record.version } : {}),
      ...(record.installedAt ? { installedAt: record.installedAt } : {}),
    });
  }
  const skills = params.skillSlugs.filter(({ ref }) => !referencedSkills.has(ref));
  return { plugins, skills };
}

/** Loads installed ClawHub skills from Claw-owned workspaces and the managed dir. */
async function loadClawGarbageSkillSlugs(
  workspaces: string[],
): Promise<Array<{ ref: string; workspace: string; version?: string }>> {
  const slugs: Array<{ ref: string; workspace: string; version?: string }> = [];
  for (const workspace of workspaces) {
    try {
      const lockfile = await readClawHubSkillsLockfile(workspace);
      for (const [ref, entry] of Object.entries(lockfile.skills)) {
        slugs.push({ ref, workspace, version: entry.version });
      }
    } catch {
      // Missing or malformed lockfiles simply contribute no candidates.
    }
  }
  return slugs;
}

export async function planClawGarbageCollection(
  options: ClawGarbageOptions = {},
): Promise<ClawGarbagePlan> {
  const plugins = loadInstalledPluginIndexInstallRecordsSync(options.indexOptions);
  const installRecords = readClawInstallRecords(options);
  const workspaces = [
    ...new Set(installRecords.map((record) => record.workspace).filter((path) => path !== "")),
  ];
  const skillSlugs = await loadClawGarbageSkillSlugs(workspaces);
  const refs = readClawPackageRefs(options);
  return collectClawGarbageCandidates({ plugins, skillSlugs, refs });
}
