// Default secret-provider alias resolution.
//
// Split from the `provider-auth` barrel, which also value-loads the auth-profile
// store, provider runtime, and plugin install graph (execa, kysely, commander).
// Doctor closures only need the alias grammar, and doctor enumeration cold-loads
// those closures.

export { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";
