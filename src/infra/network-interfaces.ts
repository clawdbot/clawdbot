import os from "node:os";

export type NetworkInterfacesSnapshot = ReturnType<typeof os.networkInterfaces>;
type NetworkInterfaceFamily = "IPv4" | "IPv6";
type ExternalNetworkInterfaceAddress = {
  name: string;
  address: string;
  family: NetworkInterfaceFamily;
};

function normalizeNetworkInterfaceFamily(
  family: string | number | undefined,
): NetworkInterfaceFamily | undefined {
  if (family === "IPv4" || family === 4) {
    return "IPv4";
  }
  if (family === "IPv6" || family === 6) {
    return "IPv6";
  }
  return undefined;
}

export function readNetworkInterfaces(
  networkInterfaces: () => NetworkInterfacesSnapshot = os.networkInterfaces,
): NetworkInterfacesSnapshot {
  return networkInterfaces();
}

export function safeNetworkInterfaces(
  networkInterfaces: () => NetworkInterfacesSnapshot = os.networkInterfaces,
): NetworkInterfacesSnapshot | undefined {
  try {
    return readNetworkInterfaces(networkInterfaces);
  } catch {
    return undefined;
  }
}

export function listExternalInterfaceAddresses(
  snapshot: NetworkInterfacesSnapshot | undefined,
  family?: NetworkInterfaceFamily,
): ExternalNetworkInterfaceAddress[] {
  const addresses: ExternalNetworkInterfaceAddress[] = [];
  if (!snapshot) {
    return addresses;
  }

  for (const [name, entries] of Object.entries(snapshot)) {
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      if (!entry || entry.internal) {
        continue;
      }
      const address = entry.address?.trim();
      if (!address) {
        continue;
      }
      const entryFamily = normalizeNetworkInterfaceFamily(entry.family);
      if (!entryFamily || (family && entryFamily !== family)) {
        continue;
      }
      addresses.push({ name, address, family: entryFamily });
    }
  }

  return addresses;
}

export function pickMatchingExternalInterfaceAddress(
  snapshot: NetworkInterfacesSnapshot | undefined,
  params: {
    family: NetworkInterfaceFamily;
    preferredNames?: string[];
    matches?: (address: string) => boolean;
  },
): string | undefined {
  const { family, preferredNames = [], matches = () => true } = params;
  const addresses = listExternalInterfaceAddresses(snapshot, family);

  for (const name of preferredNames) {
    const preferred = addresses.find((entry) => entry.name === name && matches(entry.address));
    if (preferred) {
      return preferred.address;
    }
  }

  return addresses.find((entry) => matches(entry.address))?.address;
}
