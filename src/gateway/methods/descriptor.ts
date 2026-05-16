import type { OperatorScope } from "../operator-scopes.js";

export const NODE_GATEWAY_METHOD_SCOPE = "node" as const;
export const DYNAMIC_GATEWAY_METHOD_SCOPE = "dynamic" as const;

export type GatewayMethodScope =
  | OperatorScope
  | typeof NODE_GATEWAY_METHOD_SCOPE
  | typeof DYNAMIC_GATEWAY_METHOD_SCOPE;

export type GatewayMethodOwner =
  | { kind: "core"; area: string }
  | { kind: "plugin"; pluginId: string }
  | { kind: "channel"; channelId: string }
  | { kind: "aux"; area: string };

export type GatewayMethodStartupAvailability = "available" | "unavailable-until-sidecars";

export type GatewayMethodHandler = (opts: never) => unknown;

export type GatewayMethodDescriptor = {
  name: string;
  handler: GatewayMethodHandler;
  scope: GatewayMethodScope;
  owner: GatewayMethodOwner;
  startup?: GatewayMethodStartupAvailability;
  controlPlaneWrite?: boolean;
  advertise?: boolean;
  description?: string;
};

export type GatewayMethodDescriptorInput = Omit<GatewayMethodDescriptor, "name"> & {
  name: string;
};

export type GatewayMethodRegistryView = {
  getHandler: (name: string) => GatewayMethodHandler | undefined;
  listMethods: () => string[];
  listAdvertisedMethods: () => string[];
  getScope: (name: string) => GatewayMethodScope | undefined;
  isStartupUnavailable: (name: string) => boolean;
  isControlPlaneWrite: (name: string) => boolean;
  descriptors: () => readonly GatewayMethodDescriptor[];
};
