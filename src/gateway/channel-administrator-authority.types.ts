/** Opaque host-owned authority; public fields cannot recreate the capability. */
export type ChannelAdministratorAuthority = Readonly<{ runId: string }>;

/** One-request grant bound to its exact method and live operational run. */
export type ChannelAdministratorGrant = Readonly<{ runId: string; token: string }>;
