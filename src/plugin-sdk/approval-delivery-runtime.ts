export function createChannelApprovalCapability<T>(capability: T): T {
  return capability;
}

export function createApproverRestrictedNativeApprovalCapability<T>(capability: T): T {
  return capability;
}

export function splitChannelApprovalCapability<T>(capability: T): {
  native: T;
  delivery: T;
} {
  return {
    native: capability,
    delivery: capability,
  };
}
