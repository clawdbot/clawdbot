/**
 * Gateway tool-resolution tests.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import {
  buildTurnSendTargetKey,
  commitTurnSend,
  reserveTurnSend,
  resetTurnSendLedgerForTest,
} from "../agents/tools/turn-send-ledger.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

// The message tool keys the send ledger on the agentId-scoped session key it builds
// internally (pollEchoSessionKey in message-tool-execution.ts), not the raw session key.
// #114388 made that key `${agentId}\0${sessionKey}` so concurrent agents sharing one
// session stay isolated. Seed the ledger with the exact string the tool will peek with,
// derived through the same resolver production uses; a hand-built raw key would silently
// miss the slot and let the cap stay inert even when the wiring under test is correct.
function ledgerSessionKey(sessionKey: string): string {
  return `${resolveSessionAgentId({ sessionKey })}\0${sessionKey}`;
}

// Seed one committed send for a (turn, target) via the reserve->commit primitive the
// tools use, so the opt-in cap of 1 is already reached when the tool under test peeks.
function seedCommittedSend(key: { sessionKey: string; runId: string; targetKey: string }): void {
  const reserved = reserveTurnSend(key, {});
  if (reserved.status !== "reserved") {
    throw new Error(`expected to seed a reserved send, got "${reserved.status}"`);
  }
  commitTurnSend(reserved.reservation);
}

describe("resolveGatewayScopedTools", () => {
  beforeAll(() => {
    resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "room_event",
      surface: "loopback",
    });
  });

  it("force-allows the message tool for room-event loopback turns", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "room_event",
      surface: "loopback",
    });

    const messageTool = result.tools.find((tool) => tool.name === "message");
    expect(messageTool?.description).toContain("This turn visible reply");
  });

  it("keeps webchat room-event turns on automatic source delivery", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:webchat:forge-main",
      messageProvider: "webchat",
      inboundEventKind: "room_event",
      surface: "loopback",
    });

    expect(result.tools.some((tool) => tool.name === "message")).toBe(false);
  });

  it("force-allows the message tool for routed webchat room-event turns", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "webchat",
      inboundEventKind: "room_event",
      sourceReplyDeliveryMode: "message_tool_only",
      surface: "loopback",
    });

    const messageTool = result.tools.find((tool) => tool.name === "message");
    expect(messageTool?.description).toContain("This turn visible reply");
  });

  it.each(["profile", "gateway-deny", "surface-exclusion"] as const)(
    "rejects collector mode after %s removes its reader",
    async (restriction) => {
      const result = resolveGatewayScopedTools({
        cfg: {
          agents: { entries: { main: { default: true } } },
          tools: { profile: restriction === "profile" ? "messaging" : "coding" },
          ...(restriction === "gateway-deny"
            ? { gateway: { tools: { deny: ["agents_wait"] } } }
            : {}),
        },
        sessionKey: "agent:main:main",
        surface: "loopback",
        ...(restriction === "surface-exclusion" ? { excludeToolNames: ["agents_wait"] } : {}),
      });
      const spawn = result.tools.find((tool) => tool.name === "sessions_spawn");
      expect(spawn).toBeDefined();
      expect(result.tools.some((tool) => tool.name === "agents_wait")).toBe(false);
      expect(spawn?.parameters).not.toHaveProperty("properties.collect");
      await expect(
        spawn!.execute("uncollectable", { task: "inspect", collect: true }),
      ).rejects.toThrow("Collector results are unavailable");
    },
  );

  it("keeps ordinary loopback turns under the configured profile", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "user_request",
      surface: "loopback",
    });

    expect(result.tools.some((tool) => tool.name === "message")).toBe(false);
  });

  it("keeps default-agent credentials out of unbound gateway calls", () => {
    const cfg = {
      agents: { defaults: { imageModel: { primary: "openai/gpt-5.4-mini" } } },
    } as OpenClawConfig;
    const unbound = resolveGatewayScopedTools({
      cfg,
      sessionKey: "agent:main:main",
      surface: "loopback",
    });
    const grantBound = resolveGatewayScopedTools({
      cfg,
      agentDir: "/agents/cli",
      sessionKey: "agent:main:main",
      surface: "loopback",
    });

    expect(unbound.tools.some((tool) => tool.name === "view_image")).toBe(false);
    expect(grantBound.tools.some((tool) => tool.name === "view_image")).toBe(true);
  });

  it("uses the prepared vision fact for the loopback image loader", () => {
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      agentDir: "/agents/cli",
      sessionKey: "agent:main:main",
      modelHasVision: true,
      surface: "loopback",
    });

    const imageTool = result.tools.find((tool) => tool.name === "view_image");
    expect(imageTool).toMatchObject({
      label: "View Image",
      catalogMode: "direct-only",
    });
    expect(imageTool?.description).toContain("private model context");
  });

  it("applies a borrowed runtime policy without reassigning session tools", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: {
          main: {},
          worker: { tools: { deny: ["sessions_list"] } },
        },
      },
    } satisfies OpenClawConfig;

    const result = resolveGatewayScopedTools({
      cfg,
      sessionKey: "agent:main:main",
      agentId: "main",
      runtimePolicySessionKey: "agent:worker:discord:default:direct:peer-42",
      runtimePolicyAgentId: "worker",
      surface: "loopback",
    });

    expect(result.agentId).toBe("main");
    expect(result.tools.some((tool) => tool.name === "sessions_list")).toBe(false);
    expect(result.tools.some((tool) => tool.name === "sessions_history")).toBe(true);
  });

  it("rejects a runtime policy agent that conflicts with its session key", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, worker: {} },
      },
    } satisfies OpenClawConfig;

    expect(() =>
      resolveGatewayScopedTools({
        cfg,
        sessionKey: "agent:main:main",
        agentId: "main",
        runtimePolicySessionKey: "agent:worker:main",
        runtimePolicyAgentId: "main",
        surface: "loopback",
      }),
    ).toThrowError(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
  });

  it("materializes an executable write tool on the mediated CLI surface", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mediated-write-"));
    try {
      const result = resolveGatewayScopedTools({
        cfg: {} as OpenClawConfig,
        sessionKey: "agent:main:cron:mediated-write",
        surface: "loopback",
        workspaceDir,
        mediatedToolNames: ["write"],
        excludeToolNames: ["read", "edit", "apply_patch", "exec", "process"],
      });

      const writeTool = result.tools.find((tool) => tool.name === "write");
      expect(writeTool).toBeDefined();
      await writeTool?.execute?.("mediated-write-call", {
        path: "proof.txt",
        content: "mediated write ok",
      });
      await expect(fs.readFile(path.join(workspaceDir, "proof.txt"), "utf8")).resolves.toBe(
        "mediated write ok",
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("applies sandbox tool denies to sandboxed loopback turns", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        tools: { sandbox: { tools: { deny: ["sessions_list"] } } },
      } as OpenClawConfig,
      sessionKey: "agent:main:main",
      surface: "loopback",
    });

    const toolNames = result.tools.map((tool) => tool.name);
    expect(toolNames).not.toContain("sessions_list");
    expect(toolNames).toContain("sessions_history");
  });

  it("does not apply sandbox tool policy to the main session in non-main mode", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        agents: { defaults: { sandbox: { mode: "non-main" } } },
        tools: { sandbox: { tools: { deny: ["sessions_list"] } } },
      } as OpenClawConfig,
      sessionKey: "agent:main:main",
      surface: "loopback",
    });

    expect(result.tools.some((tool) => tool.name === "sessions_list")).toBe(true);
  });

  it("exposes task suggestion tools only for actionable loopback turns", () => {
    const withoutActions = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:main",
      surface: "loopback",
    });
    const withActions = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:main",
      taskSuggestionDeliveryMode: "gateway",
      surface: "loopback",
    });

    expect(withoutActions.tools.some((tool) => tool.name === "suggest_task")).toBe(false);
    expect(withActions.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["suggest_task", "dismiss_task"]),
    );
  });

  it("passes loopback yield context into sessions_yield", async () => {
    const registry = await import("../agents/subagents/registry/subagent-registry.js");
    const markRequesterTurnYielded = vi
      .spyOn(registry, "markRequesterTurnYielded")
      .mockReturnValue(1);
    const onYield = vi.fn();
    try {
      const result = resolveGatewayScopedTools({
        cfg: { tools: { profile: "minimal", alsoAllow: ["sessions_yield"] } } as OpenClawConfig,
        sessionKey: "agent:main:telegram:group:-100123",
        sessionId: "session-123",
        runId: "run-123",
        onYield,
        surface: "loopback",
      });
      const yieldTool = result.tools.find((tool) => tool.name === "sessions_yield");
      if (!yieldTool) {
        throw new Error("expected sessions_yield tool");
      }

      const toolResult = await yieldTool.execute("tool-call-1", {
        message: "waiting on subagents",
        acknowledgment: "I’m waiting on the subagents.",
      });

      expect(markRequesterTurnYielded).toHaveBeenCalledExactlyOnceWith({
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:telegram:group:-100123",
        requesterTurnRunId: "run-123",
      });
      expect(onYield).toHaveBeenCalledWith("waiting on subagents", "I’m waiting on the subagents.");
      expect(toolResult.details).toEqual({
        status: "yielded",
        message: "waiting on subagents",
        acknowledgment: "I’m waiting on the subagents.",
      });
    } finally {
      markRequesterTurnYielded.mockRestore();
    }
  });
});

describe("resolveGatewayScopedTools per-turn send ledger wiring", () => {
  afterEach(() => {
    resetTurnSendLedgerForTest();
  });

  // The per-turn send budget only activates when runId reaches the message tool
  // (message-tool.ts builds its budget context only for a defined runId). The Gateway
  // loopback path must forward runId, or the ledger is silently inert for every
  // ordinary Gateway turn. Pre-seed one send for this turn/target, then prove the
  // opt-in cap of 1 blocks the tool the resolver produced — impossible unless runId
  // is wired through.
  it("forwards runId so the message tool per-turn cap engages on the loopback surface", async () => {
    const sessionKey = "agent:main:telegram:group:-100123";
    const runId = "gw-run-1";
    const targetKey = buildTurnSendTargetKey({ channel: "telegram", target: "peer-1" });
    seedCommittedSend({ sessionKey: ledgerSessionKey(sessionKey), runId, targetKey });

    const result = resolveGatewayScopedTools({
      cfg: {
        tools: { profile: "minimal", message: { maxMessagesPerTurnPerTarget: 1 } },
      } as OpenClawConfig,
      sessionKey,
      runId,
      messageProvider: "telegram",
      inboundEventKind: "room_event",
      surface: "loopback",
    });
    const messageTool = result.tools.find((tool) => tool.name === "message");
    if (!messageTool) {
      throw new Error("expected message tool");
    }

    const blocked = await messageTool.execute("gw-msg-1", {
      action: "send",
      channel: "telegram",
      to: "peer-1",
      message: "second variant",
    });
    expect(blocked.details).toMatchObject({
      status: "suppressed",
      reason: "turn_send_budget_exhausted",
    });
  });

  // The current-source send must key the ledger on the routable messaging target
  // (what conversations_send uses), not the native channel id. Seed the budget for
  // the routable target only, then send with no explicit target while native and
  // routable differ. This blocks only if currentMessagingTarget threads through
  // resolveGatewayScopedTools -> createOpenClawTools -> the message tool; without it
  // the no-target send falls back to the native id and misses the seeded slot.
  it("threads the routable currentMessagingTarget so a current-source send shares the ledger slot", async () => {
    const sessionKey = "agent:main:slack:dm:U123";
    const runId = "gw-run-2";
    const targetKey = buildTurnSendTargetKey({ channel: "slack", target: "user:U123" });
    seedCommittedSend({ sessionKey: ledgerSessionKey(sessionKey), runId, targetKey });

    const result = resolveGatewayScopedTools({
      cfg: {
        tools: { profile: "minimal", message: { maxMessagesPerTurnPerTarget: 1 } },
      } as OpenClawConfig,
      sessionKey,
      runId,
      messageProvider: "slack",
      // Native channel id and routable target intentionally differ, and agentTo is
      // left unset exactly as the production loopback resolve leaves it. That keeps
      // the seeded slot reachable only via currentMessagingTarget: were the routable
      // target dropped, the resolver's `?? agentTo` fallback would be undefined and
      // the no-target send would key on the native "D123" instead, missing the slot.
      currentChannelId: "D123",
      currentMessagingTarget: "user:U123",
      inboundEventKind: "room_event",
      surface: "loopback",
    });
    const messageTool = result.tools.find((tool) => tool.name === "message");
    if (!messageTool) {
      throw new Error("expected message tool");
    }

    const blocked = await messageTool.execute("gw-msg-2", {
      action: "send",
      channel: "slack",
      message: "second variant to current source",
    });
    expect(blocked.details).toMatchObject({
      status: "suppressed",
      reason: "turn_send_budget_exhausted",
    });
  });
});
