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
  it.each(["command", "tool"] as const)(
    "hands personal accounts to the human from a %s",
    async (source) => {
      const runAgentTurn = vi.fn(async () => ({
        text: "Let’s open your account controls.",
        directive: { kind: "model-accounts" as const },
      }));
      const executeOperation = vi.fn();
      const engine = new SystemAgentChatEngine({
        surface,
        runAgentTurn,
        executeOperation,
        deps: { loadOverview: fakeOverviewLoader() },
      });

      const reply = await engine.handle(
        source === "command" ? "model accounts" : "Help me sign in to my personal account",
      );

      expect(reply.action).toBe("none");
      expect(reply.step).toBeUndefined();
      expect(reply.text).toContain("Nothing has changed");
      expect(reply.text).toContain("never paste credentials");
      expect(reply.handoff).toEqual(surface === "gateway" ? { kind: "model-accounts" } : undefined);
      expect(reply.text).toContain("Settings → Profile → Connected accounts");
      if (surface === "cli") {
        expect(reply.text).toContain("openclaw models accounts login <provider>");
      }
      expect(runAgentTurn).toHaveBeenCalledTimes(source === "command" ? 0 : 1);
      expect(executeOperation).not.toHaveBeenCalled();
    },
  );

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
