import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { collectBaseArrayPaths } from "../../../../src/config/patch-replace-paths.js";

type CloudWorkerConfigPatch = { patch: Record<string, unknown>; replacePaths: string[] };

export type CloudWorkerProfileDraft = {
  id: string;
  backend: string;
  machineClass: string;
  ttl: string;
  idleTimeout: string;
  setup: string;
  desktop: boolean;
  binary: string;
};

export type ConfiguredCloudWorkerProfile = {
  id: string;
  providerId: string;
  install: "bundle" | "npm";
  backend: string;
  machineClass: string;
  ttl: string;
  idleTimeout: string;
  setup: string;
  desktop: boolean;
  binary: string;
};

export type CloudWorkerDraftError =
  | "profileId"
  | "profileExists"
  | "profileMissing"
  | "backend"
  | "machineClass"
  | "ttl"
  | "idleTimeout"
  | "binary";

type CloudWorkerProfileStatus = "advertised" | "restart-required" | "loading";

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
// Matches Crabbox's Go-duration grammar and requires at least one non-zero digit.
const GO_DURATION_PATTERN = /^(?=.*[1-9])\+?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+$/u;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;

function profileRecords(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const cloudWorkers = isRecord(config.cloudWorkers) ? config.cloudWorkers : null;
  return isRecord(cloudWorkers?.profiles) ? cloudWorkers.profiles : {};
}

function profileSettings(profile: Record<string, unknown>): Record<string, unknown> {
  return isRecord(profile.settings) ? profile.settings : {};
}

function stringSetting(settings: Record<string, unknown>, key: string): string {
  return normalizeOptionalString(settings[key]) ?? "";
}

export function readCloudWorkerProfiles(
  config: Readonly<Record<string, unknown>> | null,
): ConfiguredCloudWorkerProfile[] {
  if (!config) {
    return [];
  }
  return Object.entries(profileRecords(config))
    .flatMap<ConfiguredCloudWorkerProfile>(([id, raw]) => {
      if (!isRecord(raw)) {
        return [];
      }
      const settings = profileSettings(raw);
      return [
        {
          id,
          providerId: normalizeOptionalString(raw.provider) ?? "",
          install: raw.install === "npm" ? "npm" : "bundle",
          backend: stringSetting(settings, "provider"),
          machineClass: stringSetting(settings, "class"),
          ttl: stringSetting(settings, "ttl"),
          idleTimeout: stringSetting(settings, "idleTimeout"),
          setup: stringSetting(settings, "setup"),
          desktop: settings.desktop === true,
          binary: stringSetting(settings, "binary"),
        },
      ];
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

export function createCloudWorkerDraft(
  profile?: ConfiguredCloudWorkerProfile,
): CloudWorkerProfileDraft {
  return {
    id: profile?.id ?? "",
    backend: profile?.backend ?? "",
    machineClass: profile?.machineClass ?? "",
    ttl: profile?.ttl || "8h",
    idleTimeout: profile?.idleTimeout || "45m",
    setup: profile?.setup ?? "",
    desktop: profile?.desktop ?? false,
    binary: profile?.binary ?? "",
  };
}

export function validateCloudWorkerDraft(
  draft: CloudWorkerProfileDraft,
  profiles: Readonly<Record<string, unknown>>,
  editingId: string | null,
): CloudWorkerDraftError | null {
  const id = draft.id.trim();
  if (!PROFILE_ID_PATTERN.test(id) || id !== draft.id) {
    return "profileId";
  }
  if (!editingId && Object.hasOwn(profiles, id)) {
    return "profileExists";
  }
  if (editingId && !Object.hasOwn(profiles, editingId)) {
    return "profileMissing";
  }
  if (!draft.backend.trim()) {
    return "backend";
  }
  const machineClass = draft.machineClass.trim();
  if (!machineClass || machineClass.length > 128) {
    return "machineClass";
  }
  if (!GO_DURATION_PATTERN.test(draft.ttl.trim())) {
    return "ttl";
  }
  if (!GO_DURATION_PATTERN.test(draft.idleTimeout.trim())) {
    return "idleTimeout";
  }
  const binary = draft.binary.trim();
  if (binary && !binary.startsWith("/") && !WINDOWS_ABSOLUTE_PATH_PATTERN.test(binary)) {
    return "binary";
  }
  return null;
}

export function buildCloudWorkerUpsertPatch(
  config: Readonly<Record<string, unknown>>,
  draft: CloudWorkerProfileDraft,
  editingId: string | null,
): CloudWorkerConfigPatch | { error: CloudWorkerDraftError } {
  const profiles = profileRecords(config);
  const error = validateCloudWorkerDraft(draft, profiles, editingId);
  if (error) {
    return { error };
  }
  const id = editingId ?? draft.id;
  const existing = isRecord(profiles[id]) ? profiles[id] : {};
  const existingSettings = profileSettings(existing);
  // Recheck the authoritative snapshot: a stale rich draft must not overwrite an Advanced profile.
  if (
    editingId &&
    (normalizeOptionalString(existing.provider) !== "crabbox" ||
      !stringSetting(existingSettings, "class"))
  ) {
    return { error: "profileMissing" };
  }
  const setup = draft.setup.trim();
  const clearSetupEnv =
    !setup && Array.isArray(existingSettings.setupEnv) && existingSettings.setupEnv.length > 0;
  // Omitted settings merge in place; resending opaque nulls would delete them.
  const settings = {
    provider: draft.backend.trim(),
    class: draft.machineClass.trim(),
    ttl: draft.ttl.trim(),
    idleTimeout: draft.idleTimeout.trim(),
    setup: setup || null,
    ...(clearSetupEnv ? { setupEnv: null } : {}),
    desktop: draft.desktop ? true : null,
    binary: draft.binary.trim() || null,
  };
  const profile = {
    provider: normalizeOptionalString(existing.provider) ?? "crabbox",
    install: existing.install === "npm" ? "npm" : "bundle",
    settings,
  };
  return {
    patch: { cloudWorkers: { profiles: { [id]: profile } } },
    replacePaths: clearSetupEnv
      ? collectBaseArrayPaths(
          existingSettings.setupEnv,
          `cloudWorkers.profiles.${id}.settings.setupEnv`,
        )
      : [],
  };
}

export function buildCloudWorkerDeletePatch(
  config: Readonly<Record<string, unknown>>,
  profileId: string,
): CloudWorkerConfigPatch | { error: "profileMissing" } {
  const profiles = profileRecords(config);
  if (!Object.hasOwn(profiles, profileId)) {
    return { error: "profileMissing" };
  }
  const cloudWorkers = isRecord(config.cloudWorkers) ? config.cloudWorkers : null;
  const projectProfiles = isRecord(cloudWorkers?.projectProfiles)
    ? cloudWorkers.projectProfiles
    : {};
  const removedProjectProfiles = Object.fromEntries(
    Object.entries(projectProfiles)
      .filter(([, target]) => target === profileId)
      .map(([project]) => [project, null]),
  );
  return {
    patch: {
      cloudWorkers: {
        profiles: { [profileId]: null },
        ...(Object.keys(removedProjectProfiles).length > 0
          ? { projectProfiles: removedProjectProfiles }
          : {}),
      },
    },
    replacePaths: collectBaseArrayPaths(profiles[profileId], `cloudWorkers.profiles.${profileId}`),
  };
}

export function cloudWorkerProfileStatus(
  profileId: string,
  advertisedIds: ReadonlySet<string>,
  catalogLoaded: boolean,
): CloudWorkerProfileStatus {
  if (!catalogLoaded) {
    return "loading";
  }
  return advertisedIds.has(profileId) ? "advertised" : "restart-required";
}
