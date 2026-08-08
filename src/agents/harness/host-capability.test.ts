import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import {
  rewrapToolWithBeforeToolCallHook,
  runBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";

vi.mock("../agent-tools.before-tool-call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-tools.before-tool-call.js")>()),
  rewrapToolWithBeforeToolCallHook: vi.fn((tool) => tool),
  runBeforeToolCallHook: vi.fn(async ({ params }) => ({ blocked: false, params })),
}));

const mockRewrap = vi.mocked(rewrapToolWithBeforeToolCallHook);
const mockRunBefore = vi.mocked(runBeforeToolCallHook);

function attempt(): EmbeddedRunAttemptParams {
  const runId = "run-1";
  return {
    admittedRunContext: {
      operationalRunInstance: createOperationalRunInstanceRef(runId),
    },
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    runId,
    cwd: "/attempt/worktree",
    workspaceDir: "/workspace",
    currentChannelId: "chat-1",
    messageChannel: "telegram",
  } as unknown as EmbeddedRunAttemptParams;
}

describe("agent harness host capability", () => {
  beforeEach(() => {
    mockRewrap.mockClear();
    mockRunBefore.mockClear();
  });

  it("overwrites plugin policy fields with the host snapshot and revokes after the attempt", async () => {
    const host = createAgentHarnessHostCapabilities({ attempt: attempt(), pluginId: "codex" });
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const tool = { name: "read", description: "read", parameters: {}, execute } as never;

    const [bound] = host.capabilities.bindToolSurface([tool]);
    expect(mockRewrap).toHaveBeenCalledWith(
      tool,
      expect.objectContaining({
        agentId: "main",
        runId: "run-1",
        sessionKey: "agent:main:session-1",
        channelId: "chat-1",
      }),
    );

    await host.capabilities.runBeforeToolCall({
      toolName: "exec",
      params: { command: "true" },
      approvalMode: "deny",
      ctx: { agentId: "forged" },
    } as never);
    expect(mockRunBefore).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalMode: "request",
        ctx: expect.objectContaining({ agentId: "main", runId: "run-1" }),
      }),
    );

    host.close();
    expect(() => host.capabilities.bindToolSurface([tool])).toThrow("no longer active");
    await expect((bound as never as { execute: () => Promise<unknown> }).execute()).rejects.toThrow(
      "no longer active",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps policy snapshots independent from later attempt mutation", async () => {
    const source = attempt() as EmbeddedRunAttemptParams & {
      config: { tools: { loopDetection: { enabled: boolean } } };
      skillsSnapshot: { prompt: string; version: number; skills: Array<{ name: string }> };
    };
    source.config = { tools: { loopDetection: { enabled: true } } };
    source.skillsSnapshot = { prompt: "safe", version: 1, skills: [{ name: "safe" }] };
    const skillUsagePaths = [
      {
        readPath: "/sandbox/safe/SKILL.md",
        skillFile: "/skills/safe/SKILL.md",
        skillName: "safe",
        skillSource: "workspace" as const,
      },
    ];
    source.sandbox = {
      enabled: true,
      workspaceAccess: "rw",
      workspaceDir: "/sandbox",
      fsBridge: {} as never,
      skillUsagePaths,
    } as unknown as NonNullable<EmbeddedRunAttemptParams["sandbox"]>;
    const host = createAgentHarnessHostCapabilities({ attempt: source, pluginId: "codex" });

    source.config.tools.loopDetection.enabled = false;
    source.skillsSnapshot.skills[0]!.name = "forged";
    skillUsagePaths[0]!.skillFile = "/skills/forged/SKILL.md";
    await host.capabilities.runBeforeToolCall({ toolName: "read", params: {} });

    expect(mockRunBefore).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          config: { tools: { loopDetection: { enabled: true } } },
          skillsSnapshot: expect.objectContaining({ skills: [{ name: "safe" }] }),
          skillUsagePaths: [
            expect.objectContaining({
              readPath: "/sandbox/safe/SKILL.md",
              skillFile: "/skills/safe/SKILL.md",
            }),
          ],
        }),
      }),
    );
  });

  it("derives a bounded native action cwd without accepting forged host authority", async () => {
    const host = createAgentHarnessHostCapabilities({ attempt: attempt(), pluginId: "codex" });

    await host.capabilities.runBeforeToolCall({
      toolName: "exec",
      params: { command: "pwd" },
      nativeOperation: { cwd: " ./native/../action " },
      ctx: { agentId: "forged", cwd: "/forged" },
    } as never);

    expect(mockRunBefore).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          agentId: "main",
          runId: "run-1",
          sessionKey: "agent:main:session-1",
          cwd: "/attempt/worktree/action",
        }),
      }),
    );

    await expect(
      host.capabilities.runBeforeToolCall({
        toolName: "exec",
        params: { command: "pwd" },
        nativeOperation: { cwd: `/${"x".repeat(4096)}` },
      }),
    ).rejects.toThrow("must not exceed 4096 bytes");
    expect(mockRunBefore).toHaveBeenCalledTimes(1);
  });
});
