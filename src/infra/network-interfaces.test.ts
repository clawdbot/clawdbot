// Covers safe network interface enumeration and address selection.
import { describe, expect, it } from "vitest";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";
import {
  listExternalInterfaceAddresses,
  pickMatchingExternalInterfaceAddress,
  safeNetworkInterfaces,
} from "./network-interfaces.js";

describe("network-interfaces", () => {
  it("returns undefined when interface discovery throws", () => {
    expect(
      safeNetworkInterfaces(() => {
        throw new Error("uv_interface_addresses failed");
      }),
    ).toBeUndefined();
  });

  it.each([
    {
      name: "lists trimmed non-internal external addresses only",
      snapshot: makeNetworkInterfacesSnapshot({
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        en0: [
          { address: " 192.168.1.42 ", family: "IPv4" },
          { address: "fd7a:115c:a1e0::1", family: "IPv6" },
          { address: " ", family: "IPv6" },
        ],
      }),
      run: (snapshot: ReturnType<typeof makeNetworkInterfacesSnapshot>) =>
        expect(listExternalInterfaceAddresses(snapshot)).toEqual([
          { name: "en0", address: "192.168.1.42", family: "IPv4" },
          { name: "en0", address: "fd7a:115c:a1e0::1", family: "IPv6" },
        ]),
    },
    {
      name: "prefers configured interface names before falling back",
      snapshot: makeNetworkInterfacesSnapshot({
        wlan0: [{ address: "172.16.0.99", family: "IPv4" }],
        en0: [{ address: "192.168.1.42", family: "IPv4" }],
      }),
      run: (snapshot: ReturnType<typeof makeNetworkInterfacesSnapshot>) =>
        expect(
          pickMatchingExternalInterfaceAddress(snapshot, {
            family: "IPv4",
            preferredNames: ["en0", "eth0"],
          }),
        ).toBe("192.168.1.42"),
    },
  ])("$name", ({ snapshot, run }) => {
    run(snapshot);
  });
});
