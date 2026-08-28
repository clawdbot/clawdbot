import { afterEach, describe, expect, it, vi } from "vitest";
import { abortContinuationDispatchClaims } from "./continuation-dispatch-claims.js";
import { registerContinuationDelegateDispatchClaim } from "./delegate-spawn-authority.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("continuation delegate claim construction", () => {
  it("does not register a claim when loading owner identity throws", () => {
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    const ownerSessionKey = "agent:main:owner-load-throws";

    expect(() =>
      registerContinuationDelegateDispatchClaim({
        controller: "pending",
        delegate: { task: "must not leak a claim" },
        loadOwnerSessionEntry: () => {
          throw new Error("owner store unavailable");
        },
        ownerSessionKey,
      }),
    ).toThrow("owner store unavailable");

    abortContinuationDispatchClaims(ownerSessionKey);
    expect(abortSpy).not.toHaveBeenCalled();
  });
});
