import { describe, expect, it } from "vitest";
import { clickClackConfigSchema } from "./config-schema.js";

describe("ClickClack config schema compatibility", () => {
  it("accepts managedOnly on named accounts used by the gateway", () => {
    const result = clickClackConfigSchema.runtime?.safeParse({
      accounts: {
        "agent-compass": {
          enabled: true,
          baseUrl: "http://127.0.0.1:8100",
          token: "test-token",
          workspace: "wsp_managed",
          managedOnly: true,
          agentId: "compass",
          discussions: { enabled: true },
        },
      },
    });

    expect(result?.success).toBe(true);
  });

  it.each([
    { label: "missing", account: { managedOnly: true } },
    { label: "invalid", account: { managedOnly: true, agentId: "not an agent" } },
  ])("rejects $label managedOnly accounts without a valid agentId", ({ account }) => {
    const result = clickClackConfigSchema.runtime?.safeParse({
      accounts: {
        "agent-compass": {
          baseUrl: "http://127.0.0.1:8100",
          token: "test-token",
          workspace: "wsp_managed",
          ...account,
        },
      },
    });

    expect(result?.success).toBe(false);
  });
});
