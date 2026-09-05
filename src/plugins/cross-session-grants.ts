import { createHash } from "node:crypto";
import {
  createCorePluginStateSyncKeyedStore,
  type OpenKeyedStoreOptions,
} from "../plugin-state/plugin-state-store.js";
import type {
  CrossSessionGrant,
  CrossSessionGrantAuthority,
  CrossSessionGrantRuntime,
} from "./runtime/types.js";

const MAX_GRANTS = 1_000;
const MAX_GRANTS_PER_SUBJECT = 32;
const GRANT_TTL_MS = 7 * 24 * 60 * 60_000;

/** Create a host-owned, plugin-scoped cross-session grant authority. */
export function createCrossSessionGrantRuntime(
  pluginId: string,
  isPluginLive: () => boolean,
  env?: OpenKeyedStoreOptions["env"],
): CrossSessionGrantRuntime {
  const store = createCorePluginStateSyncKeyedStore<CrossSessionGrant>({
    ownerId: `core:cross-session-grants:${pluginId}`,
    namespace: "grants",
    maxEntries: MAX_GRANTS,
    overflowPolicy: "reject-new",
    defaultTtlMs: GRANT_TTL_MS,
    ...(env ? { env } : {}),
  });

  const get = (grantId: string, signal: AbortSignal): CrossSessionGrant | undefined => {
    if (!isPluginLive() || signal.aborted) {
      return undefined;
    }
    const value = store.lookup(grantKey(grantId));
    return value ? validateGrant(value) : undefined;
  };
  const authorize = (authority: CrossSessionGrantAuthority): CrossSessionGrant | undefined => {
    if (!isPluginLive() || authority.signal.aborted) {
      return undefined;
    }
    const grant = get(authority.grantId, authority.signal);
    return grant && matchesAuthority(grant, authority) ? grant : undefined;
  };
  const update = store.update;
  if (!update) {
    throw new Error("Cross-session grants require atomic plugin-state updates");
  }

  return {
    create(grant, signal) {
      if (!isPluginLive() || signal.aborted) {
        return false;
      }
      const validated = validateGrant({
        ...grant,
        standing: false,
        revoked: false,
        revocationPending: false,
      });
      const existing = store.lookup(grantKey(validated.grantId));
      if (existing) {
        return matchesRegistration(validateGrant(existing), validated);
      }
      // Revoked rows still consume replay-protection capacity until expiry, so include them in the
      // subject quota rather than letting one peer exhaust the global store through churn.
      const subjectCount = store
        .entries()
        .map((entry) => validateGrant(entry.value))
        .filter((entry) => entry.subjectId === validated.subjectId).length;
      if (subjectCount >= MAX_GRANTS_PER_SUBJECT) {
        return false;
      }
      return store.registerIfAbsent(grantKey(validated.grantId), validated);
    },
    list(signal) {
      return isPluginLive() && !signal.aborted
        ? store.entries().map((entry) => validateGrant(entry.value))
        : [];
    },
    get,
    authorize,
    allowStanding(authority) {
      let changed = false;
      update(grantKey(authority.grantId), (existing) => {
        if (!existing || !isPluginLive() || authority.signal.aborted) {
          return existing;
        }
        const grant = validateGrant(existing);
        if (!matchesAuthority(grant, authority)) {
          return grant;
        }
        changed = true;
        return validateGrant({ ...grant, standing: true });
      });
      return changed;
    },
    revoke(params) {
      if (!isPluginLive() || params.signal.aborted) {
        return undefined;
      }
      const current = get(params.grantId, params.signal);
      if (current?.revoked && current.generation === params.expectedGeneration) {
        return current;
      }
      let revoked: CrossSessionGrant | undefined;
      update(grantKey(params.grantId), (existing) => {
        if (!existing || !isPluginLive() || params.signal.aborted) {
          return existing;
        }
        const grant = validateGrant(existing);
        if (
          grant.role !== "issuer" ||
          grant.revoked ||
          grant.generation !== params.expectedGeneration
        ) {
          return grant;
        }
        revoked = validateGrant({
          ...grant,
          generation: grant.generation + 1,
          standing: false,
          revoked: true,
          revocationPending: true,
        });
        return revoked;
      });
      return revoked;
    },
    applyRevocation(authority) {
      let changed = false;
      update(grantKey(authority.grantId), (existing) => {
        if (!existing || !isPluginLive() || authority.signal.aborted) {
          return existing;
        }
        const grant = validateGrant(existing);
        if (
          grant.role !== "holder" ||
          grant.subjectId !== authority.subjectId ||
          grant.subjectBinding !== authority.subjectBinding ||
          grant.targetSessionId !== authority.targetSessionId ||
          authority.generation <= grant.generation
        ) {
          return grant;
        }
        changed = true;
        return validateGrant({
          ...grant,
          generation: authority.generation,
          standing: false,
          revoked: true,
          revocationPending: false,
        });
      });
      return changed;
    },
    acknowledgeRevocation(params) {
      let changed = false;
      update(grantKey(params.grantId), (existing) => {
        if (!existing || !isPluginLive() || params.signal.aborted) {
          return existing;
        }
        const grant = validateGrant(existing);
        if (
          grant.role !== "issuer" ||
          !grant.revoked ||
          !grant.revocationPending ||
          grant.generation !== params.generation
        ) {
          return grant;
        }
        changed = true;
        return validateGrant({ ...grant, revocationPending: false });
      });
      return changed;
    },
  };
}

function matchesRegistration(left: CrossSessionGrant, right: CrossSessionGrant): boolean {
  return (
    !left.revoked &&
    left.grantId === right.grantId &&
    left.subjectId === right.subjectId &&
    left.subjectBinding === right.subjectBinding &&
    left.role === right.role &&
    left.targetSessionKey === right.targetSessionKey &&
    left.targetSessionId === right.targetSessionId &&
    left.generation === right.generation
  );
}

function matchesAuthority(
  grant: CrossSessionGrant,
  authority: CrossSessionGrantAuthority,
): boolean {
  return (
    grant.role === "issuer" &&
    !grant.revoked &&
    grant.subjectId === authority.subjectId &&
    grant.subjectBinding === authority.subjectBinding &&
    grant.targetSessionId === authority.targetSessionId &&
    grant.generation === authority.generation
  );
}

function grantKey(grantId: string): string {
  return `grant:${createHash("sha256").update(grantId).digest("hex")}`;
}

function validateGrant(value: CrossSessionGrant): CrossSessionGrant {
  if (
    !value ||
    !isBoundedString(value.grantId, 512) ||
    !isBoundedString(value.subjectId, 512) ||
    !isBoundedString(value.subjectBinding, 2_048) ||
    (value.role !== "issuer" && value.role !== "holder") ||
    !isBoundedString(value.targetSessionKey, 4_096) ||
    !isBoundedString(value.targetSessionId, 512) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    typeof value.standing !== "boolean" ||
    typeof value.revoked !== "boolean" ||
    typeof value.revocationPending !== "boolean"
  ) {
    throw new Error("invalid cross-session grant");
  }
  return structuredClone(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}
