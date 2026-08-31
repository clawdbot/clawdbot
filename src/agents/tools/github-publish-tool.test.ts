import { describe, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createGitHubPublishTool } from "./github-publish-tool.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";

describe("github_publish tool", () => {
  it("binds bounded model intent to the host-owned session", async () => {
    const callGatewayMock = vi.fn(async () => ({
      requestId: "publication-1",
      status: "requested" as const,
      message: "Publication was accepted.",
    }));
    const callGateway = callGatewayMock as InProcessGatewayCaller;
    const tool = createGitHubPublishTool({ callGateway });

    await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:host-owned" },
      async () => await tool.execute("tool-call-1", { title: "Publish the fix" }),
    );

    expect(callGatewayMock).toHaveBeenCalledWith("sessions.github.publish", {
      sessionKey: "agent:main:host-owned",
      idempotencyKey: "tool-call-1",
      title: "Publish the fix",
    });
  });
});
