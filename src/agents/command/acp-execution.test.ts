import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentCommandOpts } from "./types.js";

const { resolveAcpApprovalRouting } = await import("./acp-execution.routing.js");

describe("resolveAcpApprovalRouting", () => {
  it("routes spawned ACP approvals to the parent Slack session delivery context", () => {
    const parentSessionKey = "agent:main:slack:channel:C0BRUDC9D0A";
    const childSessionKey = "agent:cursor:acp:child-1";
    const storePath = "/tmp/openclaw-sessions.json";
    const cfg = {} as OpenClawConfig;
    const sessionStore: Record<string, SessionEntry> = {
      [parentSessionKey]: {
        sessionId: "parent-session-id",
        updatedAt: Date.now(),
        delivery: {
          kind: "external",
          context: {
            channel: "slack",
            to: "channel:C0BRUDC9D0A",
            accountId: "workspace-1",
            threadId: "1724353200.123456",
          },
          route: {
            channel: "slack",
            accountId: "workspace-1",
            target: {
              to: "channel:C0BRUDC9D0A",
              chatType: "channel",
            },
          },
          origin: {
            provider: "slack",
            surface: "slack",
            chatType: "channel",
          },
        },
      },
    };

    const routing = resolveAcpApprovalRouting({
      cfg,
      sessionKey: childSessionKey,
      sessionEntry: {
        sessionId: "child-session-id",
        updatedAt: Date.now(),
        parentSessionKey,
        spawnedBy: parentSessionKey,
      },
      sessionStore,
      storePath,
      opts: {} as AgentCommandOpts,
      sessionAgentId: "cursor",
    });

    expect(routing.approvalSessionKey).toBe(parentSessionKey);
    expect(routing.approvalAgentId).toBe("main");
    expect(routing.messageChannel).toBe("slack");
    expect(routing.currentMessagingTarget).toBe("channel:C0BRUDC9D0A");
    expect(routing.agentAccountId).toBe("workspace-1");
    expect(routing.currentThreadTs).toBe("1724353200.123456");
  });

  it("ignores child spawn opts when parent Slack delivery context is available", () => {
    const parentSessionKey = "agent:main:slack:channel:C0BRUDC9D0A";
    const childSessionKey = "agent:cursor:acp:child-2";
    const storePath = "/tmp/openclaw-sessions.json";
    const cfg = {} as OpenClawConfig;
    const sessionStore: Record<string, SessionEntry> = {
      [parentSessionKey]: {
        sessionId: "parent-session-id",
        updatedAt: Date.now(),
        delivery: {
          kind: "external",
          context: {
            channel: "slack",
            to: "channel:C0BRUDC9D0A",
            accountId: "workspace-1",
          },
          route: {
            channel: "slack",
            accountId: "workspace-1",
            target: {
              to: "channel:C0BRUDC9D0A",
              chatType: "channel",
            },
          },
          origin: {
            provider: "slack",
            surface: "slack",
            chatType: "channel",
          },
        },
      },
    };

    const routing = resolveAcpApprovalRouting({
      cfg,
      sessionKey: childSessionKey,
      sessionEntry: {
        sessionId: "child-session-id",
        updatedAt: Date.now(),
        parentSessionKey,
      },
      sessionStore,
      storePath,
      opts: {
        channel: "slack",
        to: "user:U0BRWB9DDLH",
      } as AgentCommandOpts,
      sessionAgentId: "cursor",
    });

    expect(routing.currentMessagingTarget).toBe("channel:C0BRUDC9D0A");
    expect(routing.messageChannel).toBe("slack");
  });
});
