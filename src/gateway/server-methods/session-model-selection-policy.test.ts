import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnv } from "../../test-utils/env.js";
import { resolveGatewayModelSelectionPolicy } from "./session-model-selection-policy.js";

const cfg = {
  agents: {
    defaults: { model: "anthropic/claude-opus-4-6" },
    list: [
      { id: "main", default: true },
      { id: "work", model: "anthropic/claude-sonnet-4-6" },
    ],
  },
} satisfies OpenClawConfig;

describe("resolveGatewayModelSelectionPolicy", () => {
  it("discloses the effective write target to an admin", () => {
    expect(
      resolveGatewayModelSelectionPolicy({
        agentId: "main",
        callerScopes: ["operator.admin"],
        cfg,
      }).target,
    ).toBe("global");
    expect(
      resolveGatewayModelSelectionPolicy({
        agentId: "work",
        callerScopes: ["operator.admin"],
        cfg,
      }).target,
    ).toBe("agent");
  });

  it("discloses session-only selection without writable config", () => {
    expect(
      resolveGatewayModelSelectionPolicy({
        agentId: "work",
        callerScopes: ["operator.write"],
        cfg,
      }).target,
    ).toBe("session");
    expect(
      withEnv({ OPENCLAW_NIX_MODE: "1" }, () =>
        resolveGatewayModelSelectionPolicy({
          agentId: "work",
          callerScopes: ["operator.admin"],
          cfg,
        }),
      ).target,
    ).toBe("session");
  });
});
