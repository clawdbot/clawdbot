import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";

const runStackLoaded = vi.hoisted(() => vi.fn());

vi.mock("./agent-run-handler.js", () => {
  runStackLoaded();
  return { agentRunHandler: vi.fn() };
});

describe("lazy core handler families", () => {
  it("loads agent identity without importing the agent run stack", async () => {
    const { coreGatewayHandlers } = await import("../server-methods.js");
    const respond = vi.fn();
    await expectDefined(
      coreGatewayHandlers["agent.identity.get"],
      "agent.identity.get lazy handler",
    )({
      req: { type: "req", id: "identity-light-family", method: "agent.identity.get" },
      params: { agentId: "main" },
      respond,
      context: { getRuntimeConfig: () => ({}) } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ agentId: "main" }),
      undefined,
    );
    expect(runStackLoaded).not.toHaveBeenCalled();
  });
});
