// Verifies sandbox tool allow/deny policy extraction and additive alsoAllow behavior.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveEffectiveToolPolicy } from "./agent-tools.policy.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import { resolveEffectiveToolFsRootExpansionAllowed } from "./tool-fs-policy.js";

describe("pickSandboxToolPolicy", () => {
  it("returns undefined when neither allow nor deny is configured", () => {
    expect(pickSandboxToolPolicy({})).toBeUndefined();
  });

  it("keeps alsoAllow without allow additive", () => {
    expect(
      pickSandboxToolPolicy({
        alsoAllow: ["web_search"],
      }),
    ).toEqual({
      allow: ["*", "web_search"],
      deny: undefined,
    });
  });

  it("merges allow and alsoAllow when both are present", () => {
    expect(
      pickSandboxToolPolicy({
        allow: ["read"],
        alsoAllow: ["write"],
      }),
    ).toEqual({
      allow: ["read", "write"],
      deny: undefined,
    });
  });

  it("preserves allow-all semantics for allow: [] plus alsoAllow", () => {
    // Empty allow means allow-all; alsoAllow remains additive, not restrictive.
    expect(
      pickSandboxToolPolicy({
        allow: [],
        alsoAllow: ["web_search"],
      }),
    ).toEqual({
      allow: ["*", "web_search"],
      deny: undefined,
    });
  });

  it("passes deny through unchanged", () => {
    expect(
      pickSandboxToolPolicy({
        deny: ["exec"],
      }),
    ).toEqual({
      allow: undefined,
      deny: ["exec"],
    });
  });

  it("keeps global alsoAllow additive in effective tool policy resolution", () => {
    const cfg: OpenClawConfig = {
      tools: {
        profile: "coding",
        alsoAllow: ["lobster"],
      },
    };

    const resolved = resolveEffectiveToolPolicy({ config: cfg, agentId: "main" });
    expect(resolved.globalPolicy).toEqual({ allow: ["*", "lobster"], deny: undefined });
    expect(resolved.profileAlsoAllow).toEqual(["lobster"]);
  });

  it("does not block fs root expansion when only global alsoAllow is configured", () => {
    const cfg: OpenClawConfig = {
      tools: {
        alsoAllow: ["lobster"],
      },
    };

    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId: "main" })).toBe(true);
  });
});
