import { describe, expect, it } from "vitest";
import { findCall, getCallByProviderCallId } from "./lookup.js";

describe("voice-call manager lookup", () => {
  it("resolves provider call ids from the explicit map first", () => {
    const activeCalls = new Map([
      ["call-1", { id: "call-1", providerCallId: "prov-1" }],
      ["call-2", { id: "call-2", providerCallId: "prov-2" }],
    ]);
    const providerCallIdMap = new Map([["provider-lookup", "call-2"]]);

    expect(
      getCallByProviderCallId({
        activeCalls: activeCalls as never,
        providerCallIdMap,
        providerCallId: "provider-lookup",
      }),
    ).toEqual({ id: "call-2", providerCallId: "prov-2" });
  });

  it("falls back to scanning active calls and supports direct call ids", () => {
    const activeCalls = new Map([
      ["call-1", { id: "call-1", providerCallId: "prov-1" }],
      ["call-2", { id: "call-2", providerCallId: "prov-2" }],
    ]);
    const providerCallIdMap = new Map<string, string>();

    expect(
      getCallByProviderCallId({
        activeCalls: activeCalls as never,
        providerCallIdMap,
        providerCallId: "prov-1",
      }),
    ).toEqual({ id: "call-1", providerCallId: "prov-1" });

    expect(
      findCall({
        activeCalls: activeCalls as never,
        providerCallIdMap,
        callIdOrProviderCallId: "call-2",
      }),
    ).toEqual({ id: "call-2", providerCallId: "prov-2" });

    expect(
      findCall({
        activeCalls: activeCalls as never,
        providerCallIdMap,
        callIdOrProviderCallId: "missing",
      }),
    ).toBeUndefined();
  });
});
