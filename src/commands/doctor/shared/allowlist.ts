// Shared doctor allowlist predicates for normalized sender lists.
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { DoctorAllowFromList } from "../types.js";

/** Return true when an allowFrom-like list has at least one normalized sender entry. */
export function hasAllowFromEntries(list?: DoctorAllowFromList) {
  return Array.isArray(list) && normalizeStringEntries(list).length > 0;
}
