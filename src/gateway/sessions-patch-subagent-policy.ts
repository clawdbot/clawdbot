import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import {
  normalizeInheritedToolAllowlist,
  normalizeInheritedToolDenylist,
} from "../agents/inherited-tool-deny.js";
import type { SessionEntry } from "../config/sessions.js";
import { isAcpSessionKey, isSubagentSessionKey } from "../routing/session-key.js";

function supportsSpawnPolicy(storeKey: string): boolean {
  return isSubagentSessionKey(storeKey) || isAcpSessionKey(storeKey);
}

function unsupportedField(field: string, storeKey: string): string | undefined {
  return supportsSpawnPolicy(storeKey)
    ? undefined
    : `${field} is only supported for subagent:* or acp:* sessions`;
}

/** Applies the remaining public child-policy fields after lineage became creation-only. */
export function applySessionsPatchSubagentPolicy(params: {
  existing?: SessionEntry;
  next: SessionEntry;
  patch: SessionsPatchParams;
  storeKey: string;
}): string | undefined {
  const { existing, next, patch, storeKey } = params;
  if ("completionOwnerSessionKey" in patch) {
    const raw = patch.completionOwnerSessionKey;
    if (raw === null && existing?.completionOwnerSessionKey) {
      return "completionOwnerSessionKey cannot be cleared once set";
    }
    if (raw !== null && raw !== undefined) {
      const unsupported = unsupportedField("completionOwnerSessionKey", storeKey);
      if (unsupported) {
        return unsupported;
      }
      const normalized = normalizeOptionalString(raw);
      if (!normalized) {
        return "invalid completionOwnerSessionKey: empty";
      }
      if (
        existing?.completionOwnerSessionKey &&
        existing.completionOwnerSessionKey !== normalized
      ) {
        return "completionOwnerSessionKey cannot be changed once set";
      }
      next.completionOwnerSessionKey = normalized;
    }
  }

  if ("inheritedToolPolicyVersion" in patch) {
    const raw = patch.inheritedToolPolicyVersion;
    if (raw === null && existing?.inheritedToolPolicyVersion !== undefined) {
      return "inheritedToolPolicyVersion cannot be cleared once set";
    }
    if (raw !== null && raw !== undefined) {
      const unsupported = unsupportedField("inheritedToolPolicyVersion", storeKey);
      if (unsupported) {
        return unsupported;
      }
      if (raw !== 1) {
        return "invalid inheritedToolPolicyVersion (expected 1)";
      }
      next.inheritedToolPolicyVersion = 1;
    }
  }

  for (const field of ["inheritedToolDeny", "inheritedToolAllow"] as const) {
    if (!(field in patch)) {
      continue;
    }
    const raw = patch[field];
    if (raw === null) {
      delete next[field];
      continue;
    }
    if (raw === undefined) {
      continue;
    }
    if (!Array.isArray(raw)) {
      return `invalid ${field} (use an array of tool names)`;
    }
    const unsupported = unsupportedField(field, storeKey);
    if (unsupported) {
      return unsupported;
    }
    const normalized =
      field === "inheritedToolDeny"
        ? normalizeInheritedToolDenylist(raw)
        : normalizeInheritedToolAllowlist(raw);
    if (normalized.length > 0) {
      next[field] = normalized;
    } else {
      delete next[field];
    }
  }
  return undefined;
}
