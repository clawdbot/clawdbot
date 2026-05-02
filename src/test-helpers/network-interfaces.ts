import os from "node:os";
import type { NetworkInterfacesSnapshot } from "../infra/network-interfaces.js";

type NetworkInterfaceEntry = NonNullable<ReturnType<typeof os.networkInterfaces>[string]>[number];

type NetworkInterfaceEntryInput = {
  address: string;
  family: "IPv4" | "IPv6";
  internal?: boolean;
  netmask?: string;
};

function makeNetworkInterfaceEntry(input: NetworkInterfaceEntryInput): NetworkInterfaceEntry {
  if (input.family === "IPv6") {
    return {
      address: input.address,
      family: "IPv6",
      internal: input.internal ?? false,
      netmask: input.netmask ?? "",
      cidr: null,
      mac: "",
      scopeid: 0,
    };
  }

  return {
    address: input.address,
    family: "IPv4",
    internal: input.internal ?? false,
    netmask: input.netmask ?? "",
    cidr: null,
    mac: "",
  };
}

export function makeNetworkInterfacesSnapshot(
  snapshot: Record<string, NetworkInterfaceEntryInput[]>,
): NetworkInterfacesSnapshot {
  return Object.fromEntries(
    Object.entries(snapshot).map(([name, entries]) => [
      name,
      entries.map((entry) => makeNetworkInterfaceEntry(entry)),
    ]),
  );
}
