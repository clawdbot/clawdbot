import { beforeEach, describe, expect, it, vi } from "vitest";

const handleSlackActionMock = vi.fn();

vi.mock("./slack-actions.js", () => ({
  handleSlackAction: (params: unknown, cfg: unknown) =>
    handleSlackActionMock(params, cfg),
}));

import { createSlackTool } from "./slack-tool.js";

describe("slack tool", () => {
  beforeEach(() => {
    handleSlackActionMock.mockReset();
    handleSlackActionMock.mockResolvedValue({
      content: [],
      details: { ok: true },
    });
  });

  it("injects agentAccountId when accountId is missing", async () => {
    const tool = createSlackTool({
      agentAccountId: " Kev ",
      config: { slack: { accounts: { kev: {} } } },
    });

    await tool.execute("call-1", {
      action: "sendMessage",
      to: "channel:C1",
      content: "hello",
    });

    expect(handleSlackActionMock).toHaveBeenCalledTimes(1);
    const [params] = handleSlackActionMock.mock.calls[0] ?? [];
    expect(params).toMatchObject({ accountId: "kev" });
  });

  it("keeps explicit accountId when provided", async () => {
    const tool = createSlackTool({
      agentAccountId: "kev",
      config: {},
    });

    await tool.execute("call-2", {
      action: "sendMessage",
      to: "channel:C1",
      content: "hello",
      accountId: "rex",
    });

    expect(handleSlackActionMock).toHaveBeenCalledTimes(1);
    const [params] = handleSlackActionMock.mock.calls[0] ?? [];
    expect(params).toMatchObject({ accountId: "rex" });
  });

  it("does not inject accountId when agentAccountId is missing", async () => {
    const tool = createSlackTool({ config: {} });

    await tool.execute("call-3", {
      action: "sendMessage",
      to: "channel:C1",
      content: "hello",
    });

    expect(handleSlackActionMock).toHaveBeenCalledTimes(1);
    const [params] = handleSlackActionMock.mock.calls[0] ?? [];
    expect(params).not.toHaveProperty("accountId");
  });

  it("does not inject unknown agentAccountId when not configured", async () => {
    const tool = createSlackTool({
      agentAccountId: "unknown",
      config: { slack: { accounts: { kev: {} } } },
    });

    await tool.execute("call-4", {
      action: "sendMessage",
      to: "channel:C1",
      content: "hello",
    });

    const [params] = handleSlackActionMock.mock.calls[0] ?? [];
    expect(params).not.toHaveProperty("accountId");
  });
});
