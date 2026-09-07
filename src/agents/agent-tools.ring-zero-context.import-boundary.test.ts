import { describe, expect, it, vi } from "vitest";

const { loadAgentToolCommon } = vi.hoisted(() => ({
  loadAgentToolCommon: vi.fn(),
}));

vi.mock("./tools/common.js", async (importOriginal) => {
  loadAgentToolCommon();
  return await importOriginal();
});

describe("agent ring-zero context import boundary", () => {
  it("does not load the heavy agent-tool graph", async () => {
    await import("./agent-tools.ring-zero-context.js");

    expect(loadAgentToolCommon).not.toHaveBeenCalled();
  });
});
