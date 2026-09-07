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
  it("keeps an admin's ordinary selection session-only", () => {
    expect(
      resolveGatewayModelSelectionPolicy({
        callerScopes: ["operator.admin"],
        cfg,
      }).target,
    ).toBe("session");
  });

  it("discloses an explicitly requested agent target to an admin", () => {
    expect(
      resolveGatewayModelSelectionPolicy({
        callerScopes: ["operator.admin"],
        cfg,
        scope: "agent",
      }).target,
    ).toBe("agent");
  });

  it("discloses session-only selection without admin scope", () => {
    expect(
      resolveGatewayModelSelectionPolicy({
        callerScopes: ["operator.write"],
        cfg,
        scope: "global",
      }).target,
    ).toBe("session");
  });

  it.each(["OPENCLAW_NIX_MODE", "OPENCLAW_CONFIG_READONLY"])(
    "discloses session-only selection without writable config in %s",
    (mode) => {
      expect(
        withEnv({ [mode]: "1" }, () =>
          resolveGatewayModelSelectionPolicy({
            callerScopes: ["operator.admin"],
            cfg,
            scope: "global",
          }),
        ).target,
      ).toBe("session");
    },
  );
});
