/** Ordered strength of one identifier-authentication claim. */
export type IdentifierAuthentication = "verified" | "asserted" | "unverified" | "mutable";

const IDENTIFIER_AUTHENTICATION_RANK: Record<IdentifierAuthentication, number> = {
  verified: 3,
  asserted: 2,
  unverified: 1,
  mutable: 0,
};

/** Existing channels remain asserted until they opt into a more precise claim. */
export const DEFAULT_IDENTIFIER_AUTHENTICATION: IdentifierAuthentication = "asserted";

export function meetsIdentifierAuthentication(
  actual: IdentifierAuthentication,
  minimum: IdentifierAuthentication,
): boolean {
  return IDENTIFIER_AUTHENTICATION_RANK[actual] >= IDENTIFIER_AUTHENTICATION_RANK[minimum];
}

/** Entry and subject claims combine by taking the weaker exact-pair claim. */
export function weakestIdentifierAuthentication(
  entry: IdentifierAuthentication,
  subject: IdentifierAuthentication,
): IdentifierAuthentication {
  return IDENTIFIER_AUTHENTICATION_RANK[entry] <= IDENTIFIER_AUTHENTICATION_RANK[subject]
    ? entry
    : subject;
}

export function identifierAuthenticationFrom(params: {
  authentication?: IdentifierAuthentication;
  dangerous?: boolean;
}): IdentifierAuthentication {
  return (
    params.authentication ?? (params.dangerous ? "mutable" : DEFAULT_IDENTIFIER_AUTHENTICATION)
  );
}

export function minimumIdentifierAuthenticationFrom(params: {
  minIdentifierAuthentication?: IdentifierAuthentication;
  mutableIdentifierMatching?: "disabled" | "enabled";
}): IdentifierAuthentication {
  return (
    params.minIdentifierAuthentication ??
    (params.mutableIdentifierMatching === "enabled" ? "mutable" : DEFAULT_IDENTIFIER_AUTHENTICATION)
  );
}
