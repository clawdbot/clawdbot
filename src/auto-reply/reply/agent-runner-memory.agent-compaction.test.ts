// Focused tests for the agent-requested (session_compact tool) post-turn compaction helper.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runAgentRequestedCompactionIfNeeded } from "./agent-runner-memory.js";
import type { FollowupRun } from "./queue.js";

const { compactEmbeddedAgentSessionMock } = vi.hoisted(() => ({
  compactEmbeddedAgentSessionMock: vi.fn(),
}));

vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock,
}));

function createTestFollowupRun(): FollowupRun {
  return {
    prompt: "next",
    enqueuedAt: 1,
    run: {
      agentId: "main",
      agentDir: "/tmp/openclaw-agents/main",
      sessionId: "session-1",
      sessionFile: "agent:main:session-main",
      workspaceDir: "/tmp/openclaw-workspace",
      provider: "anthropic",
      model: "anthropic/claude-test",
      config: {} as OpenClawConfig,
    },
  } as FollowupRun;
}

function createTestSessionEntry(): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 1,
  } as SessionEntry;
}

function createTestParams(overrides?: {
  request?: { focus?: string };
  sessionKey?: string;
  isHeartbeat?: boolean;
}) {
  return {
    cfg: {} as OpenClawConfig,
    followupRun: createTestFollowupRun(),
    request: overrides?.request,
    sessionEntry: createTestSessionEntry(),
    sessionKey: overrides?.sessionKey ?? "agent:main:session-main",
    storePath: "/tmp/openclaw-test-store/sessions.json",
    isHeartbeat: overrides?.isHeartbeat ?? false,
  };
}

describe("runAgentRequestedCompactionIfNeeded", () => {
  afterEach(() => {
    compactEmbeddedAgentSessionMock.mockReset();
  });

  it("compacts through the manual pipeline with the requested focus", async () => {
    compactEmbeddedAgentSessionMock.mockResolvedValue({ ok: true, compacted: true });
    await runAgentRequestedCompactionIfNeeded(
      createTestParams({ request: { focus: "keep the schema decisions" } }),
    );
    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    const compactParams = compactEmbeddedAgentSessionMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(compactParams.trigger).toBe("manual");
    expect(compactParams.force).toBe(true);
    expect(compactParams.customInstructions).toBe("keep the schema decisions");
    expect(compactParams.sessionId).toBe("session-1");
    expect(compactParams.sessionKey).toBe("agent:main:session-main");
  });

  it("does nothing without a recorded request", async () => {
    await runAgentRequestedCompactionIfNeeded(createTestParams());
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("skips heartbeat turns", async () => {
    compactEmbeddedAgentSessionMock.mockResolvedValue({ ok: true, compacted: true });
    await runAgentRequestedCompactionIfNeeded(
      createTestParams({ request: { focus: "keep decisions" }, isHeartbeat: true }),
    );
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("logs skipped compaction outcomes without throwing", async () => {
    compactEmbeddedAgentSessionMock.mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "active_run",
    });
    await expect(
      runAgentRequestedCompactionIfNeeded(createTestParams({ request: {} })),
    ).resolves.toBeUndefined();
  });

  it("swallows compaction failures to protect the recorded reply", async () => {
    compactEmbeddedAgentSessionMock.mockRejectedValue(new Error("compaction exploded"));
    await expect(
      runAgentRequestedCompactionIfNeeded(createTestParams({ request: {} })),
    ).resolves.toBeUndefined();
  });
});
