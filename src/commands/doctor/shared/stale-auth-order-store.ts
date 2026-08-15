import fs from "node:fs";
import path from "node:path";
import { coercePersistedAuthProfileStore } from "../../../agents/auth-profiles/persisted.js";
import {
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  inspectPersistedSharedAuthProfileStateRaw,
  inspectPersistedSharedAuthProfileStoreRaw,
  resolveAuthProfileDatabaseFilePaths,
} from "../../../agents/auth-profiles/sqlite.js";
import {
  coerceAuthProfileState,
  mergeAuthProfileState,
} from "../../../agents/auth-profiles/state.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import { isRecord } from "../../../utils.js";
import {
  resolveLegacyAuthProfilesPath,
  resolveLegacyAuthStatePath,
  resolveLegacyFlatAuthPath,
} from "../../doctor-auth-legacy-paths.js";

function inspectAuthPath(pathname: string): "present" | "missing" | "unreadable" {
  try {
    fs.statSync(pathname);
    return "present";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return "unreadable";
    }
  }
  try {
    fs.lstatSync(pathname);
    return "unreadable";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return "unreadable";
    }
  }

  // Accept ENOENT only when no broken symlink or non-directory ancestor masks the source.
  let ancestor = path.dirname(pathname);
  while (true) {
    try {
      const stat = fs.lstatSync(ancestor);
      if (!stat.isSymbolicLink()) {
        return stat.isDirectory() ? "missing" : "unreadable";
      }
      try {
        return fs.statSync(ancestor).isDirectory() ? "missing" : "unreadable";
      } catch {
        return "unreadable";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return "unreadable";
      }
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      return "missing";
    }
    ancestor = parent;
  }
}

export function inspectUnmigratedAuthStoreSources(
  agentDir: string,
): "present" | "missing" | "unreadable" {
  const results = new Set(
    [
      resolveLegacyAuthProfilesPath(agentDir),
      resolveLegacyAuthStatePath(agentDir),
      resolveLegacyFlatAuthPath(agentDir),
    ].map((pathname) => inspectAuthPath(pathname)),
  );
  if (results.has("unreadable")) {
    return "unreadable";
  }
  return results.has("present") ? "present" : "missing";
}

export function inspectAuthDatabaseFiles(agentDir: string): "present" | "missing" | "unreadable" {
  const [databasePath, ...sidecarPaths] = resolveAuthProfileDatabaseFilePaths(agentDir);
  if (!databasePath) {
    return "unreadable";
  }
  const availability = inspectAuthPath(databasePath);
  const sidecarAvailability = sidecarPaths.map((pathname) => inspectAuthPath(pathname));
  if (
    availability === "unreadable" ||
    sidecarAvailability.some((status) => status === "unreadable")
  ) {
    return "unreadable";
  }
  if (availability === "present") {
    return "present";
  }
  return sidecarAvailability.every((sidecar) => sidecar === "missing") ? "missing" : "unreadable";
}

export function loadCompletePersistedStore(
  agentDir?: string,
  env: NodeJS.ProcessEnv = process.env,
):
  | { status: "ok"; store: AuthProfileStore | null; hasAuthTables: boolean }
  | { status: "invalid" } {
  const inspection = agentDir
    ? inspectPersistedAuthProfileStoreRaw(agentDir)
    : inspectPersistedSharedAuthProfileStoreRaw(env);
  const stateInspection = agentDir
    ? inspectPersistedAuthProfileStateRaw(agentDir)
    : inspectPersistedSharedAuthProfileStateRaw(env);
  if (inspection.status === "unreadable" || stateInspection.status === "unreadable") {
    return { status: "invalid" };
  }
  const storeMissingReason = inspection.status === "missing" ? inspection.reason : undefined;
  const stateMissingReason =
    stateInspection.status === "missing" ? stateInspection.reason : undefined;
  if (storeMissingReason === "database" || stateMissingReason === "database") {
    return storeMissingReason === "database" && stateMissingReason === "database"
      ? { status: "ok", store: null, hasAuthTables: false }
      : { status: "invalid" };
  }
  if ((storeMissingReason === "table") !== (stateMissingReason === "table")) {
    return { status: "invalid" };
  }
  if (storeMissingReason === "table") {
    return { status: "ok", store: null, hasAuthTables: false };
  }
  const persistedState =
    stateInspection.status === "readable" ? coerceAuthProfileState(stateInspection.raw) : {};
  if (inspection.status === "missing") {
    return stateInspection.status === "missing"
      ? { status: "ok", store: null, hasAuthTables: true }
      : {
          status: "ok",
          store: { version: 1, profiles: {}, ...persistedState },
          hasAuthTables: true,
        };
  }
  if (!isRecord(inspection.raw) || !isRecord(inspection.raw.profiles)) {
    return { status: "invalid" };
  }
  const store = coercePersistedAuthProfileStore(inspection.raw);
  const rawProfileIds = Object.keys(inspection.raw.profiles);
  if (
    !store ||
    rawProfileIds.length !== Object.keys(store.profiles).length ||
    rawProfileIds.some((profileId) => !Object.hasOwn(store.profiles, profileId))
  ) {
    return { status: "invalid" };
  }
  return {
    status: "ok",
    store: {
      ...store,
      ...mergeAuthProfileState(coerceAuthProfileState(inspection.raw), persistedState),
    },
    hasAuthTables: true,
  };
}
