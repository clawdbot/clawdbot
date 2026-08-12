// Defines and normalizes doctor session route state ownership for plugin repairs.
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";

export type DoctorSessionRouteStateOwner = {
  id: string;
  label: string;
  providerIds?: readonly string[];
  runtimeIds?: readonly string[];
  cliSessionKeys?: readonly string[];
  authProfilePrefixes?: readonly string[];
};

function isDoctorSessionRouteStateOwner(value: unknown): value is DoctorSessionRouteStateOwner {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    id?: unknown;
    label?: unknown;
    providerIds?: unknown;
    runtimeIds?: unknown;
    cliSessionKeys?: unknown;
    authProfilePrefixes?: unknown;
  };
  return (
    typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    candidate.id.trim().length > 0 &&
    candidate.label.trim().length > 0 &&
    (candidate.providerIds === undefined ||
      normalizeTrimmedStringList(candidate.providerIds).length > 0) &&
    (candidate.runtimeIds === undefined ||
      normalizeTrimmedStringList(candidate.runtimeIds).length > 0) &&
    (candidate.cliSessionKeys === undefined ||
      normalizeTrimmedStringList(candidate.cliSessionKeys).length > 0) &&
    (candidate.authProfilePrefixes === undefined ||
      normalizeTrimmedStringList(candidate.authProfilePrefixes).length > 0)
  );
}

export function coerceDoctorSessionRouteStateOwners(
  value: unknown,
): DoctorSessionRouteStateOwner[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isDoctorSessionRouteStateOwner).map((owner) => ({
    id: owner.id.trim(),
    label: owner.label.trim(),
    providerIds: normalizeTrimmedStringList(owner.providerIds),
    runtimeIds: normalizeTrimmedStringList(owner.runtimeIds),
    cliSessionKeys: normalizeTrimmedStringList(owner.cliSessionKeys),
    authProfilePrefixes: normalizeTrimmedStringList(owner.authProfilePrefixes),
  }));
}
