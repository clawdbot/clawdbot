import { describe, expect, it } from "vitest";
import { buildExecOverridePromptHint } from "./get-reply-run.js";

describe("buildExecOverridePromptHint", () => {
  it("returns undefined when exec state is fully inherited and elevated is off", () => {
    expect(
      buildExecOverridePromptHint({
        elevatedLevel: "off",
      }),
    ).toBeUndefined();
  });

  it("includes current exec defaults and warns against stale denial assumptions", () => {
    const result = buildExecOverridePromptHint({
      execOverrides: {
        host: "gateway",
        security: "full",
        ask: "always",
        node: "worker-1",
      },
      elevatedLevel: "off",
    });

    expect(result).toContain(
      "Current session exec defaults: host=gateway security=full ask=always node=worker-1.",
    );
    expect(result).toContain("Current elevated level: off.");
    expect(result).toContain("Do not assume a prior denial still applies");
  });

  it("still reports elevated state when exec overrides are inherited", () => {
    const result = buildExecOverridePromptHint({
      elevatedLevel: "full",
    });

    expect(result).toContain(
      "Current session exec defaults: inherited from configured agent/global defaults.",
    );
    expect(result).toContain("Current elevated level: full.");
  });

  it("warns when auto-approved full access is unavailable", () => {
    const result = buildExecOverridePromptHint({
      elevatedLevel: "full",
      fullAccessAvailable: false,
      fullAccessBlockedReason: "runtime",
    });

    expect(result).toContain("Current elevated level: full.");
    expect(result).toContain(
      "Auto-approved /elevated full is unavailable here (runtime). Do not ask the user to switch to /elevated full.",
    );
  });
});
