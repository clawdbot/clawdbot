import { describe, expect, it } from "vitest";
import { canonicalizeMainSessionAlias } from "./main-session.js";

describe("canonicalizeMainSessionAlias", () => {
  it("remaps shipped hardcoded main keys for a non-main agent", () => {
    expect(
      canonicalizeMainSessionAlias({
        cfg: { agents: { list: [{ id: "ops", default: true }] } } as never,
        agentId: "ops",
        sessionKey: "agent:main:main",
      }),
    ).toBe("agent:ops:main");
  });

  it("does not reinterpret another real main agent's key", () => {
    expect(
      canonicalizeMainSessionAlias({
        cfg: { agents: { list: [{ id: "main" }, { id: "ops" }] } } as never,
        agentId: "ops",
        sessionKey: "agent:main:main",
      }),
    ).toBe("agent:main:main");
  });
});
