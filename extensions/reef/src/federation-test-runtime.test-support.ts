import type { PluginRuntime } from "openclaw/plugin-sdk/core";

type CrossSessionGrant = NonNullable<ReturnType<PluginRuntime["crossSessionGrants"]["get"]>>;
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";

const grantsByStateDir = new Map<string, Map<string, CrossSessionGrant>>();

/** Build a persistent test runtime for Reef federation state. */
export function createReefFederationTestRuntime(stateDir: string): PluginRuntime {
  const runtime = createPluginRuntimeMock();
  const grants = grantsByStateDir.get(stateDir) ?? new Map<string, CrossSessionGrant>();
  grantsByStateDir.set(stateDir, grants);
  runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
  runtime.crossSessionGrants = {
    create: (grant, signal) => {
      if (signal.aborted) {
        return false;
      }
      const subjectCount = [...grants.values()].filter(
        (existing) => existing.subjectId === grant.subjectId,
      ).length;
      if (grants.has(grant.grantId) || subjectCount >= 32) {
        return false;
      }
      grants.set(
        grant.grantId,
        structuredClone({ ...grant, standing: false, revoked: false, revocationPending: false }),
      );
      return true;
    },
    list: (signal) =>
      signal.aborted ? [] : [...grants.values()].map((grant) => structuredClone(grant)),
    get: (grantId, signal) => {
      const grant = signal.aborted ? undefined : grants.get(grantId);
      return grant ? structuredClone(grant) : undefined;
    },
    authorize: (authority) => {
      const grant = grants.get(authority.grantId);
      return grant && !authority.signal.aborted && matches(grant, authority)
        ? structuredClone(grant)
        : undefined;
    },
    allowStanding: (authority) => {
      const grant = grants.get(authority.grantId);
      if (!grant || authority.signal.aborted || !matches(grant, authority)) {
        return false;
      }
      grants.set(grant.grantId, { ...grant, standing: true });
      return true;
    },
    revoke: ({ grantId, expectedGeneration, signal }) => {
      const grant = signal.aborted ? undefined : grants.get(grantId);
      if (!grant || grant.role !== "issuer") {
        return undefined;
      }
      if (grant.revoked && grant.generation === expectedGeneration) {
        return structuredClone(grant);
      }
      if (grant.revoked || grant.generation !== expectedGeneration) {
        return undefined;
      }
      const revoked = {
        ...grant,
        standing: false,
        revoked: true,
        revocationPending: true,
        generation: grant.generation + 1,
      };
      grants.set(grantId, revoked);
      return structuredClone(revoked);
    },
    applyRevocation: (authority) => {
      const grant = grants.get(authority.grantId);
      if (
        !grant ||
        grant.role !== "holder" ||
        authority.signal.aborted ||
        grant.subjectId !== authority.subjectId ||
        grant.subjectBinding !== authority.subjectBinding ||
        grant.targetSessionId !== authority.targetSessionId ||
        authority.generation <= grant.generation
      ) {
        return false;
      }
      grants.set(grant.grantId, {
        ...grant,
        standing: false,
        revoked: true,
        revocationPending: false,
        generation: authority.generation,
      });
      return true;
    },
    acknowledgeRevocation: (authority) => {
      const grant = grants.get(authority.grantId);
      if (
        !grant ||
        grant.role !== "issuer" ||
        authority.signal.aborted ||
        !matchesRevocation(grant, authority)
      ) {
        return false;
      }
      grants.set(grant.grantId, { ...grant, revocationPending: false });
      return true;
    },
  };
  return runtime;
}

/** Clear persistent grant fixtures between tests. */
export function resetReefFederationTestRuntime(): void {
  grantsByStateDir.clear();
}

function matchesRevocation(
  grant: CrossSessionGrant,
  authority: Parameters<PluginRuntime["crossSessionGrants"]["acknowledgeRevocation"]>[0],
): boolean {
  return grant.revoked && grant.revocationPending && grant.generation === authority.generation;
}

function matches(
  grant: CrossSessionGrant,
  authority: Parameters<PluginRuntime["crossSessionGrants"]["authorize"]>[0],
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
