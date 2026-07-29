// Qqbot tests cover activation plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionStoreMocks = vi.hoisted(() => ({
  getSessionEntry: vi.fn(),
  resolveStorePath: vi.fn(() => "/state/agents/main/openclaw-agent.sqlite"),
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => sessionStoreMocks);

import { resolveGroupActivation } from "./activation.js";

describe("engine/group/activation", () => {
  beforeEach(() => {
    sessionStoreMocks.getSessionEntry.mockReset();
    sessionStoreMocks.resolveStorePath.mockClear();
  });

  it.each([
    { configRequireMention: true, expected: "mention" },
    { configRequireMention: false, expected: "always" },
  ] as const)("falls back to $expected when no override exists", (testCase) => {
    expect(
      resolveGroupActivation({
        cfg: {},
        agentId: "main",
        sessionKey: "missing",
        configRequireMention: testCase.configRequireMention,
      }),
    ).toBe(testCase.expected);
  });

  it.each([
    { raw: "mention", configRequireMention: false, expected: "mention" },
    { raw: "always", configRequireMention: true, expected: "always" },
    { raw: "  Always  ", configRequireMention: true, expected: "always" },
    { raw: "weird-mode", configRequireMention: true, expected: "mention" },
  ] as const)("resolves session activation $raw as $expected", (testCase) => {
    sessionStoreMocks.getSessionEntry.mockReturnValue({ groupActivation: testCase.raw });

    expect(
      resolveGroupActivation({
        cfg: {},
        agentId: "main",
        sessionKey: "k1",
        configRequireMention: testCase.configRequireMention,
      }),
    ).toBe(testCase.expected);
    expect(sessionStoreMocks.resolveStorePath).toHaveBeenCalledWith(undefined, { agentId: "main" });
    expect(sessionStoreMocks.getSessionEntry).toHaveBeenCalledWith({
      storePath: "/state/agents/main/openclaw-agent.sqlite",
      agentId: "main",
      sessionKey: "k1",
    });
  });

  it("falls back when the session accessor fails", () => {
    sessionStoreMocks.getSessionEntry.mockImplementation(() => {
      throw new Error("unavailable");
    });

    expect(
      resolveGroupActivation({
        cfg: {},
        agentId: "main",
        sessionKey: "k1",
        configRequireMention: false,
      }),
    ).toBe("always");
  });
});
