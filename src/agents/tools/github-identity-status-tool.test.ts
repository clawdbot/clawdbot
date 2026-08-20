import { describe, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createGitHubIdentityStatusTool } from "./github-identity-status-tool.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";

describe("github_identity_status tool", () => {
  it("returns bounded secret-free status and an operator next action", async () => {
    const callGatewayMock = vi.fn(async () => ({
      agentId: "main",
      selectedScope: "agent" as const,
      selected: { scope: "agent" as const, configured: false, identity: null },
      effective: {
        source: "system-configured" as const,
        credentialKind: "managed-oauth" as const,
        credentialState: "configured_unavailable" as const,
        account: { login: "roboclaw-bot" },
        gitAuthor: { name: "roboclaw-bot", email: null },
        evidence: "none" as const,
        accessExpiresAtMs: 1_900_000_000_000,
        refreshState: "expired" as const,
        oauthScopes: ["repo", "workflow"],
        repositoryGrants: "unknown" as const,
      },
    }));
    const tool = createGitHubIdentityStatusTool({
      callGateway: callGatewayMock as InProcessGatewayCaller,
    });

    const result = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:status" },
      async () => await tool.execute("status-1", {}),
    );

    expect(callGatewayMock).toHaveBeenCalledWith("tools.github.status", {
      agentId: "main",
      selectedScope: "agent",
    });
    expect(JSON.stringify(result)).toContain("Ask the operator");
    expect(JSON.stringify(result)).not.toMatch(/accessToken|refreshToken|deviceCode/u);
  });
});
