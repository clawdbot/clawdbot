import { describe, expect, it } from "vitest";
import { getPolicyPath, scopedPolicyValue } from "./policy-value.js";

describe("policy values", () => {
  it("reads nested policy paths", () => {
    expect(getPolicyPath({ tools: { deny: ["exec"] } }, ["tools", "deny"])).toEqual(["exec"]);
    expect(getPolicyPath({ tools: null }, ["tools", "deny"])).toBeUndefined();
  });

  it("reads scoped values from the canonical agents root", () => {
    const overlay = {
      agents: {
        tools: {
          deny: ["exec"],
        },
      },
    };

    expect(scopedPolicyValue(overlay, ["agents", "tools", "deny"])).toEqual(["exec"]);
    expect(scopedPolicyValue(overlay, [])).toBeUndefined();
  });
});
