import type { GatewayMethodScope } from "./descriptor.js";

export type CoreGatewayMethodSpec = {
  name: string;
  family?: string;
  scope: GatewayMethodScope;
  since?: string;
  advertise?: false;
  startup?: true;
  controlPlaneWrite?: true;
  compatibilityRestored?: true;
  description?: string;
};

export type CoreGatewayMethodMetadata = Pick<CoreGatewayMethodSpec, "name" | "scope" | "since">;

type CoreGatewayMethodPolicy = Pick<
  CoreGatewayMethodSpec,
  "advertise" | "startup" | "controlPlaneWrite" | "compatibilityRestored" | "description"
>;

export type CoreGatewayMethodSpecRow = readonly [
  name: string,
  family: string | null,
  scope: GatewayMethodScope,
  since: string,
  policy?: CoreGatewayMethodPolicy,
];

export function normalizeCoreGatewayMethodSpecs(
  rows: readonly CoreGatewayMethodSpecRow[],
): readonly CoreGatewayMethodSpec[] {
  return rows.map(([name, family, scope, since, policy]) => ({
    name,
    scope,
    since,
    ...(family ? { family } : {}),
    ...(policy?.advertise === false ? { advertise: false as const } : {}),
    ...(policy?.startup === true ? { startup: true as const } : {}),
    ...(policy?.controlPlaneWrite === true ? { controlPlaneWrite: true as const } : {}),
    ...(policy?.compatibilityRestored === true ? { compatibilityRestored: true as const } : {}),
    ...(policy?.description ? { description: policy.description } : {}),
  }));
}
