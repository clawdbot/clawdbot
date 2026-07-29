import { describe, expect, it } from "vitest";
import { collectCoreInsecureOrDangerousFlags } from "./core-dangerous-config-flags.js";

describe("system-agent dangerous config flags", () => {
  it("reports the explicit always approval policy", () => {
    expect(
      collectCoreInsecureOrDangerousFlags({
        approvals: { systemAgent: { mode: "always" } },
      }),
    ).toContain("approvals.systemAgent.mode=always");
  });

  it("does not report the default prompt policy", () => {
    expect(
      collectCoreInsecureOrDangerousFlags({
        approvals: { systemAgent: { mode: "prompt" } },
      }),
    ).not.toContain("approvals.systemAgent.mode=always");
  });
});
