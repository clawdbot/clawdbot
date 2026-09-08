/**
 * Gateway tool-resolution tests.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  McpLoopbackToolCache,
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "./mcp-http.runtime.js";
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
    expect(messageTool).toBeDefined();
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
    expect(messageTool).toBeDefined();
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

  it.each([
    { first: undefined, second: false },
    { first: false, second: undefined },
  ])(
    "keeps unknown and disabled model vision distinct in cached tools: $first then $second",
    async ({ first, second }) => {
      const cache = new McpLoopbackToolCache();
      const cfg: OpenClawConfig = { tools: { allow: ["computer"] } };
      for (const modelHasVision of [first, second]) {
        const result = await cache.resolve({
          cfg,
          context: {
            sessionKey: "agent:main:vision-context",
            senderIsOwner: true,
            modelHasVision,
          },
        });
        expect(result.tools.some((tool) => tool.name === "computer")).toBe(
          modelHasVision !== false,
        );
      }
    },
  );

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

  it.each(
    [
      { mode: "policy", resolve: resolveMcpLoopbackPolicyTools },
      { mode: "exact grant", resolve: resolveMcpLoopbackScopedTools },
    ].flatMap(({ mode, resolve }) =>
      [
        { label: "ls-only", toolsAllow: ["ls"], expected: ["ls"] },
        { label: "read-only", toolsAllow: ["read"], expected: ["read"] },
        { label: "mixed", toolsAllow: ["ls", "read"], expected: ["ls", "read"] },
        {
          label: "filesystem group",
          toolsAllow: ["group:fs"],
          expected: mode === "policy" ? ["ls", "read"] : [],
        },
      ].map((testCase) => Object.assign(testCase, { mode, resolve })),
    ),
  )(
    "materializes $label loopback $mode without widening its cap",
    async ({ resolve, toolsAllow, expected }) => {
      const scope = {
        cfg: {
          plugins: { enabled: false },
          tools: { profile: "minimal", alsoAllow: ["ls", "read"] },
        } satisfies OpenClawConfig,
        context: {
          sessionKey: "agent:main:cron:listing-surface",
          workspaceDir: path.join(os.tmpdir(), "openclaw-listing-surface"),
          senderIsOwner: true,
          toolsAllow,
        },
      };
      const allowed = await resolve(scope);
      expect(allowed.tools.map((tool) => tool.name)).toEqual(expected);

      const denied = await resolve({
        ...scope,
        cfg: { ...scope.cfg, tools: { ...scope.cfg.tools, deny: ["ls"] } },
      });
      expect(denied.tools.map((tool) => tool.name)).toEqual(
        expected.filter((name) => name !== "ls"),
      );
    },
  );

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
        acknowledgment: "I’m waiting on the subagents.",
      });
    } finally {
      markRequesterTurnYielded.mockRestore();
    }
  });
});
