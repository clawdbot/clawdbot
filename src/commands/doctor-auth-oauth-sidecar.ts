/** Doctor repair for legacy OAuth sidecar files and inline auth profile stores. */
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveOAuthDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadJsonFileThroughSymlink, writeJsonTarget } from "../infra/json-file.js";
import { shortenHomePath } from "../utils.js";
import {
  listAuthProfileRepairCandidates,
  type AuthProfileRepairCandidate,
} from "./doctor-auth-legacy-paths.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  isLegacyOAuthRef,
  isLegacyOAuthSidecarPayload,
  loadLegacyOAuthSidecarMaterial,
  resolveLegacyOAuthSidecarPath,
  type LegacyOAuthRef,
  type LegacyOAuthSecretMaterial,
} from "./doctor/shared/legacy-oauth-sidecar.js";

const LEGACY_OAUTH_SECRET_DIRNAME = "auth-profiles";

type LegacyOAuthSidecarProfile = {
  profileId: string;
  provider: string;
  ref: LegacyOAuthRef;
};

type LegacyOAuthSidecarStore = AuthProfileRepairCandidate & {
  raw: Record<string, unknown>;
  profiles: LegacyOAuthSidecarProfile[];
};

type LegacyOAuthUnreferencedSidecar = {
  sidecarPath: string;
};

type LegacyOAuthSidecarRepairResult = {
  detected: string[];
  changes: string[];
  warnings: string[];
};

function resolveLegacyOAuthSidecarStore(
  candidate: AuthProfileRepairCandidate,
): LegacyOAuthSidecarStore | null {
  if (!fs.existsSync(candidate.authPath)) {
    return null;
  }
  const raw = loadJsonFileThroughSymlink(candidate.authPath);
  if (!isRecord(raw) || !isRecord(raw.profiles)) {
    return null;
  }
  const profiles: LegacyOAuthSidecarProfile[] = [];
  for (const [profileId, value] of Object.entries(raw.profiles)) {
    if (!isRecord(value) || value.type !== "oauth") {
      continue;
    }
    const ref = isLegacyOAuthRef(value.oauthRef) ? value.oauthRef : undefined;
    if (!ref || readNonEmptyString(value.provider) !== ref.provider) {
      continue;
    }
    profiles.push({ profileId, provider: ref.provider, ref });
  }
  return profiles.length > 0
    ? {
        ...candidate,
        raw,
        profiles,
      }
    : null;
}

function listUnreferencedLegacyOAuthSidecars(
  referencedRefIds: Set<string>,
  env: NodeJS.ProcessEnv,
): LegacyOAuthUnreferencedSidecar[] {
  const sidecarDir = path.join(resolveOAuthDir(env), LEGACY_OAUTH_SECRET_DIRNAME);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sidecarDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      return [];
    }
    const refId = entry.name.slice(0, -".json".length);
    if (!/^[a-f0-9]{32}$/.test(refId) || referencedRefIds.has(refId)) {
      return [];
    }
    const sidecarPath = path.join(sidecarDir, entry.name);
    return isLegacyOAuthSidecarPayload(loadJsonFileThroughSymlink(sidecarPath))
      ? [{ sidecarPath }]
      : [];
  });
}

function applyLegacyOAuthSidecarMaterial(params: {
  raw: Record<string, unknown>;
  profile: LegacyOAuthSidecarProfile;
  material: LegacyOAuthSecretMaterial;
}): boolean {
  if (!isRecord(params.raw.profiles)) {
    return false;
  }
  const entry = params.raw.profiles[params.profile.profileId];
  if (!isRecord(entry)) {
    return false;
  }
  delete entry.oauthRef;
  if (params.material.access) {
    entry.access = params.material.access;
  }
  if (params.material.refresh) {
    entry.refresh = params.material.refresh;
  }
  if (params.material.idToken) {
    entry.idToken = params.material.idToken;
  }
  return true;
}

function backupLegacyOAuthSidecarStore(authPath: string, now: () => number): string {
  const backupPath = `${authPath}.oauth-ref.${now()}.bak`;
  fs.copyFileSync(authPath, backupPath);
  return backupPath;
}

/**
 * Migrates legacy Codex OAuth sidecar secrets back into inline auth profile credentials.
 *
 * Only sidecar files that were successfully imported and are not referenced by another failed
 * profile are removed; unreferenced sidecars stay because unknown agent directories may use them.
 */
export async function maybeRepairLegacyOAuthSidecarProfiles(params: {
  cfg: OpenClawConfig;
  prompter: Pick<DoctorPrompter, "confirmAutoFix">;
  now?: () => number;
  emitNotes?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<LegacyOAuthSidecarRepairResult> {
  const now = params.now ?? Date.now;
  const emitNotes = params.emitNotes !== false;
  const env = params.env ?? process.env;
  const stores = listAuthProfileRepairCandidates(params.cfg, env)
    .map(resolveLegacyOAuthSidecarStore)
    .filter((entry): entry is LegacyOAuthSidecarStore => entry !== null);
  const referencedRefIds = new Set(stores.flatMap((entry) => entry.profiles.map((p) => p.ref.id)));
  const unreferencedSidecars = listUnreferencedLegacyOAuthSidecars(referencedRefIds, env);

  const result: LegacyOAuthSidecarRepairResult = {
    detected: [
      ...stores.map((entry) => entry.authPath),
      ...unreferencedSidecars.map((entry) => entry.sidecarPath),
    ],
    changes: [],
    warnings: [],
  };
  if (stores.length === 0 && unreferencedSidecars.length === 0) {
    return result;
  }

  if (emitNotes) {
    note(
      [
        ...stores.map(
          (entry) =>
            `- ${shortenHomePath(entry.authPath)} has legacy Codex OAuth profiles to migrate.`,
        ),
        ...(unreferencedSidecars.length > 0
          ? [
              `- Found ${unreferencedSidecars.length} unreferenced legacy Codex OAuth sidecar credential file${unreferencedSidecars.length === 1 ? "" : "s"}.`,
              `- Unreferenced sidecar files are left in place because external agent directories outside this scan may still reference them.`,
            ]
          : []),
        `- ${formatCliCommand("openclaw doctor --fix")} migrates active profiles back to inline OAuth credentials and removes only sidecar files it successfully migrated.`,
      ].join("\n"),
      "Auth profiles",
    );
  }

  // Unreferenced sidecars alone are informational: the store loop below never
  // touches them, so prompting would confirm a guaranteed no-op on every run.
  if (stores.length > 0) {
    const shouldRepair = await params.prompter.confirmAutoFix({
      message: "Migrate legacy Codex OAuth credentials now?",
      initialValue: true,
    });
    if (!shouldRepair) {
      return result;
    }
  }

  const migratedSidecarsByRefId = new Map<string, string>();
  const unresolvedRefIds = new Set<string>();
  for (const store of stores) {
    let migratedCount = 0;
    const storeMigratedSidecarsByRefId = new Map<string, string>();
    for (const profile of store.profiles) {
      const material = loadLegacyOAuthSidecarMaterial({ ...profile, env });
      if (!material) {
        unresolvedRefIds.add(profile.ref.id);
        result.warnings.push(
          `Could not decrypt legacy OAuth sidecar for ${profile.profileId} in ${shortenHomePath(store.authPath)}; re-authenticate this profile.`,
        );
        continue;
      }
      if (applyLegacyOAuthSidecarMaterial({ raw: store.raw, profile, material })) {
        migratedCount += 1;
        storeMigratedSidecarsByRefId.set(
          profile.ref.id,
          resolveLegacyOAuthSidecarPath(profile.ref, env),
        );
      } else {
        unresolvedRefIds.add(profile.ref.id);
      }
    }

    if (migratedCount === 0) {
      continue;
    }

    try {
      const backupPath = backupLegacyOAuthSidecarStore(store.authPath, now);
      if (!("version" in store.raw)) {
        store.raw.version = AUTH_STORE_VERSION;
      }
      writeJsonTarget(store.authPath, store.raw);
      for (const [refId, sidecarPath] of storeMigratedSidecarsByRefId) {
        migratedSidecarsByRefId.set(refId, sidecarPath);
      }
      result.changes.push(
        `Migrated ${migratedCount} legacy Codex OAuth profile${migratedCount === 1 ? "" : "s"} in ${shortenHomePath(store.authPath)} to inline credentials (backup: ${shortenHomePath(backupPath)}).`,
      );
    } catch (err) {
      for (const refId of storeMigratedSidecarsByRefId.keys()) {
        unresolvedRefIds.add(refId);
      }
      result.warnings.push(
        `Failed to migrate legacy OAuth sidecars in ${shortenHomePath(store.authPath)}: ${String(err)}`,
      );
    }
  }

  for (const [refId, sidecarPath] of migratedSidecarsByRefId) {
    if (unresolvedRefIds.has(refId)) {
      continue;
    }
    try {
      fs.rmSync(sidecarPath, { force: true });
    } catch (err) {
      result.warnings.push(
        `Failed to remove migrated legacy OAuth sidecar ${shortenHomePath(sidecarPath)}: ${String(err)}`,
      );
    }
  }

  if (unreferencedSidecars.length > 0) {
    result.warnings.push(
      `Found ${unreferencedSidecars.length} unreferenced legacy Codex OAuth sidecar credential file${unreferencedSidecars.length === 1 ? "" : "s"}; left in place because external agent directories outside this scan may still reference ${unreferencedSidecars.length === 1 ? "it" : "them"}.`,
    );
  }

  if (result.changes.length > 0) {
    clearRuntimeAuthProfileStoreSnapshots();
  }
  if (emitNotes && result.changes.length > 0) {
    note(result.changes.map((change) => `- ${change}`).join("\n"), "Doctor changes");
  }
  if (emitNotes && result.warnings.length > 0) {
    note(result.warnings.map((warning) => `- ${warning}`).join("\n"), "Doctor warnings");
  }
  return result;
}
