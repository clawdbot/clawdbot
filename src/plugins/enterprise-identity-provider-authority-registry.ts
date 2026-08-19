import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  EnterpriseIdentityMembershipSource,
  EnterpriseIdentityProviderAdapter,
  EnterpriseIdentityProviderAuthority,
} from "./enterprise-identity-provider-types.js";

export type EnterpriseIdentityProviderRegistration = {
  pluginId: string;
  pluginName?: string;
  provider: EnterpriseIdentityProviderAdapter;
  source: string;
  rootDir?: string;
};

/**
 * Core-owned startup authority snapshot. It deliberately outlives a replaceable
 * plugin registry so a plugin reload cannot reopen enterprise registration.
 */
export type EnterpriseIdentityProviderAuthorityRegistry = {
  readonly providers: readonly EnterpriseIdentityProviderRegistration[];
  readonly operatorAllowlist: ReadonlySet<string>;
  isSealed: () => boolean;
  /** Publish an immutable copy only after complete registry activation succeeds. */
  seal: (providers?: readonly EnterpriseIdentityProviderRegistration[]) => void;
};

function freezeMembershipSource(
  source: EnterpriseIdentityMembershipSource,
): EnterpriseIdentityMembershipSource {
  if (source.kind === "google-workspace-directory") {
    return Object.freeze({
      ...source,
      roleGroupResourceNames: Object.freeze([...source.roleGroupResourceNames]),
    });
  }
  return Object.freeze({
    ...source,
    roleGroupIds: Object.freeze([...source.roleGroupIds]),
    incompleteIndicators: Object.freeze(
      (source.incompleteIndicators ?? []).map((indicator) => Object.freeze({ ...indicator })),
    ),
  });
}

function freezeAuthority(
  authority: EnterpriseIdentityProviderAuthority,
): EnterpriseIdentityProviderAuthority {
  return Object.freeze({
    ...authority,
    audiences: Object.freeze([...authority.audiences]),
    acceptedIssuerAliases: Object.freeze([...(authority.acceptedIssuerAliases ?? [])]),
    tenantBinding: Object.freeze({ ...authority.tenantBinding }),
    assurance: Object.freeze({
      ...authority.assurance,
      acceptedAcrValues: Object.freeze([...(authority.assurance.acceptedAcrValues ?? [])]),
      requiredAmrValues: Object.freeze([...(authority.assurance.requiredAmrValues ?? [])]),
    }),
    authorizationCodeFlow: Object.freeze({
      ...authority.authorizationCodeFlow,
      scopes: Object.freeze([...authority.authorizationCodeFlow.scopes]),
    }),
    requiredClaims: Object.freeze(
      (authority.requiredClaims ?? []).map((claim) => Object.freeze({ ...claim })),
    ),
    membership: freezeMembershipSource(authority.membership),
  });
}

export function createEnterpriseIdentityProviderAuthorityRegistry(params?: {
  operatorAllowlist?: readonly string[];
}): EnterpriseIdentityProviderAuthorityRegistry {
  let providers: readonly EnterpriseIdentityProviderRegistration[] = [];
  const operatorAllowlist = new Set(params?.operatorAllowlist ?? []);
  let sealed = false;
  return {
    get providers() {
      return providers;
    },
    operatorAllowlist,
    isSealed: () => sealed,
    seal: (registrations = []) => {
      if (sealed) {
        return;
      }
      // A generic plugin registry remains reloadable. This snapshot does not:
      // publication copies records after activation so rollback cannot splice
      // enterprise authorities out of a registry that is already serving users.
      providers = Object.freeze(
        registrations.map((registration) =>
          Object.freeze({
            ...registration,
            provider: Object.freeze({
              ...registration.provider,
              authorities: Object.freeze(registration.provider.authorities.map(freezeAuthority)),
            }),
          }),
        ),
      );
      sealed = true;
    },
  };
}

/** Read the operator-owned config surface once while preparing the startup snapshot. */
export function resolveEnterpriseIdentityProviderAllowlist(
  config: OpenClawConfig | undefined,
): readonly string[] {
  return config?.plugins?.enterpriseIdentityProviders?.allow ?? [];
}

let processAuthorityRegistry: EnterpriseIdentityProviderAuthorityRegistry | undefined;

/** Read the published Gateway snapshot without creating one from a secondary runtime. */
export function getProcessEnterpriseIdentityProviderAuthorityRegistry():
  | EnterpriseIdentityProviderAuthorityRegistry
  | undefined {
  return processAuthorityRegistry;
}

/**
 * Establish the process-owned enterprise authority snapshot once, at startup.
 * Later plugin-registry replacements reuse this sealed snapshot unchanged.
 */
export function getOrCreateProcessEnterpriseIdentityProviderAuthorityRegistry(params: {
  operatorAllowlist?: readonly string[];
}): EnterpriseIdentityProviderAuthorityRegistry {
  processAuthorityRegistry ??= createEnterpriseIdentityProviderAuthorityRegistry(params);
  return processAuthorityRegistry;
}
