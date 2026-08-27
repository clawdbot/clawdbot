/** Host-minted role authority; never accepted from Gateway wire params.
    Leaf contract: both ws-types and server-methods/shared-types embed it in
    client `internal` state, so it must not import either hub. */
export type GatewayOperatorRoleActor = { kind: "system" } | { kind: "operator"; profileId: string };
