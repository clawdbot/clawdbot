export function isGatewayMethodAdvertised(
  host: {
    hello?: {
      features?: { methods?: string[] } | null;
    } | null;
  },
  method: string,
): boolean | null {
  const methods = host.hello?.features?.methods;
  if (!Array.isArray(methods)) {
    return null;
  }
  return methods.includes(method);
}

export function isGatewayCapabilityAdvertised(
  host: {
    hello?: {
      features?: { capabilities?: string[] } | null;
    } | null;
  },
  capability: string,
): boolean | null {
  const capabilities = host.hello?.features?.capabilities;
  if (!Array.isArray(capabilities)) {
    return null;
  }
  return capabilities.includes(capability);
}
