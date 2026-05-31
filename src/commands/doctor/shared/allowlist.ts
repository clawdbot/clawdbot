import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { DoctorAllowFromList } from "../types.js";

export function hasAllowFromEntries(list?: DoctorAllowFromList) {
  return Array.isArray(list) && normalizeStringEntries(list).length > 0;
}
