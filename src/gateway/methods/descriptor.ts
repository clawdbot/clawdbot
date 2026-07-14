// Gateway method descriptor types define the reusable contract shared by core, plugin, channel, and auxiliary methods.
import type { OperatorScope } from "../operator-scopes.js";

/** Scope marker for methods that only authenticated node clients may call. */
export const NODE_GATEWAY_METHOD_SCOPE = "node" as const;
/** Scope marker for methods whose handler derives the required operator scope at runtime. */
export const DYNAMIC_GATEWAY_METHOD_SCOPE = "dynamic" as const;

/** Authorization scope attached to a gateway method descriptor. */
export type GatewayMethodScope =
  | OperatorScope
  | typeof NODE_GATEWAY_METHOD_SCOPE
  | typeof DYNAMIC_GATEWAY_METHOD_SCOPE;

/** Owner metadata used to keep core, plugin, channel, and auxiliary methods distinguishable. */
export type GatewayMethodOwner =
  | { kind: "core"; area: string }
  | { kind: "plugin"; pluginId: string }
  | { kind: "channel"; channelId: string }
  | { kind: "aux"; area: string };

/** Startup availability flag exposed to clients as retryable startup-unavailable errors. */
type GatewayMethodStartupAvailability = "available" | "unavailable-until-sidecars";

export type GatewayMethodHandler = (opts: never) => unknown;

/** Complete metadata for one dispatchable gateway method. */
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

/** Input descriptor shape before registry normalization trims and validates the method name. */
export type GatewayMethodDescriptorInput = Omit<GatewayMethodDescriptor, "name"> & {
  name: string;
};

/** Read-only method registry view used by request dispatch and method listing. */
export type GatewayMethodRegistryView = {
  getHandler: (name: string) => GatewayMethodHandler | undefined;
  listMethods: () => string[];
  listAdvertisedMethods: () => string[];
  getScope: (name: string) => GatewayMethodScope | undefined;
  isStartupUnavailable: (name: string) => boolean;
  isControlPlaneWrite: (name: string) => boolean;
  descriptors: () => readonly GatewayMethodDescriptor[];
};
