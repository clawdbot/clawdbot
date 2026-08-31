import "./chat-engine.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import {
  fakeOverviewLoader,
  useTempStateDir,
  SystemAgentChatEngine,
} from "./chat-engine.test-support.js";

describe.each([
  ["cli", "Use /openclaw to come back."],
  ["gateway", "You can return through Settings → Ask OpenClaw."],
] as const)("SystemAgentChatEngine %s handoff", (surface, returnHint) => {
  it("handles the exact agent handoff without consulting a model", async () => {
    const runAgentTurn = vi.fn(async () => ({ text: "model reply without a directive" }));
    const engine = new SystemAgentChatEngine({
      surface,
      runAgentTurn,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("talk to agent");

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(reply.action).toBe("open-tui");
    expect(reply.handoff).toEqual({ kind: "open-tui" });
    expect(reply.text).toBe(`Opening a chat with your agent. ${returnHint}`);
  });

  it("hatches into the agent after a fresh setup applies", async () => {
    useTempStateDir();
    const verifyInferenceConfig = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.5",
      latencyMs: 100,
    }));
    const applySetup = vi.fn(async () => ({
      configPath: "/tmp/openclaw.json",
      configHashBefore: "before",
      configHashAfter: "after",
      bootstrapPending: true,
      workspaceReady: true,
      gateway: { status: "ready" as const, action: "reused" as const },
      lines: ["Workspace: /tmp/hatch-work"],
    }));
    const engine = new SystemAgentChatEngine({
      surface,
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
      deps: {
        applySetup,
        verifyInferenceConfig,
        loadOverview: fakeOverviewLoader({ defaultModel: "openai/gpt-5.5" }),
      },
    });
    engine.propose({ kind: "setup", workspace: "/tmp/hatch-work" });

    const reply = await engine.handle("yes");

    expect(applySetup).toHaveBeenCalledOnce();
    expect(reply.action).toBe("open-tui");
    expect(reply.agentDraft).toBe("hatch");
    expect(reply.handoff).toMatchObject({
      kind: "open-tui",
      workspace: "/tmp/hatch-work",
      agentDraft: "hatch",
    });
    expect(reply.text).toContain("Your agent is hatching");
    expect(reply.text).toContain(returnHint);
  });
});
