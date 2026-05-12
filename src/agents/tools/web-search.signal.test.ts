import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebSearchTool } from "./web-search.js";

const mocks = vi.hoisted(() => ({
  runWebSearch: vi.fn(),
}));

vi.mock("../../web-search/runtime.js", () => ({
  resolveWebSearchProviderId: vi.fn(() => "mock"),
  runWebSearch: mocks.runWebSearch,
}));

describe("web_search signal plumbing", () => {
  beforeEach(() => {
    mocks.runWebSearch.mockReset();
    mocks.runWebSearch.mockResolvedValue({
      provider: "mock",
      result: { ok: true },
    });
  });

  it("passes the agent abort signal into web search runtime execution", async () => {
    const controller = new AbortController();
    const tool = createWebSearchTool({ config: {} });

    await tool?.execute("call-search", { query: "openclaw" }, controller.signal);

    expect(mocks.runWebSearch).toHaveBeenCalledTimes(1);
    const params = mocks.runWebSearch.mock.calls.at(0)?.[0];
    expect(params?.args).toEqual({ query: "openclaw" });
    expect(params?.signal).toBe(controller.signal);
  });
});
