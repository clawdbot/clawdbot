/**
 * Gateway tool-resolution tests.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

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

    expect(unbound.tools.some((tool) => tool.name === "image")).toBe(false);
    expect(grantBound.tools.some((tool) => tool.name === "image")).toBe(true);
  });

  it("uses the prepared vision fact for the loopback image loader", () => {
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      agentDir: "/agents/cli",
      sessionKey: "agent:main:main",
      modelHasVision: true,
      surface: "loopback",
    });

    const imageTool = result.tools.find((tool) => tool.name === "image");
    expect(imageTool).toMatchObject({
      label: "Inspect Image",
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
    const onYield = vi.fn();
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal", alsoAllow: ["sessions_yield"] } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      sessionId: "session-123",
      onYield,
      surface: "loopback",
    });
    const yieldTool = result.tools.find((tool) => tool.name === "sessions_yield");
    if (!yieldTool) {
      throw new Error("expected sessions_yield tool");
    }

    const toolResult = await yieldTool.execute("tool-call-1", {
      message: "waiting on subagents",
    });

    expect(onYield).toHaveBeenCalledWith("waiting on subagents");
    expect(toolResult.details).toEqual({
      status: "yielded",
      message: "waiting on subagents",
    });
  });
});
