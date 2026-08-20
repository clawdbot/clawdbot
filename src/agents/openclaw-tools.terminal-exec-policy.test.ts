// Verifies createOpenClawTools forwards the swarm non-interactive approval
// policy to the terminal tool, matching the exec tool's wiring.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";
import type { AnyAgentTool } from "./tools/common.js";

const mocks = vi.hoisted(() => {
  const stubTool = (name: string) =>
    ({
      name,
      label: name,
      displaySummary: name,
      description: name,
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    }) satisfies AnyAgentTool;

  return {
    stubTool,
    createTerminalTool: vi.fn((options: unknown) => {
      mocks.terminalToolOptions = options;
      return stubTool("terminal");
    }),
    terminalToolOptions: undefined as unknown,
  };
});

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

vi.mock("./openclaw-tools.nodes-workspace-guard.js", () => ({
  applyNodesToolWorkspaceGuard: (tool: AnyAgentTool) => tool,
}));

vi.mock("./tools/agents-list-tool.js", () => ({
  createAgentsListTool: () => mocks.stubTool("agents_list"),
}));

vi.mock("./tools/cron-tool.js", () => ({
  createCronTool: () => mocks.stubTool("cron"),
}));

vi.mock("./tools/gateway-tool.js", () => ({
  createGatewayTool: () => mocks.stubTool("gateway"),
}));

vi.mock("./tools/image-generate-tool.js", () => ({
  createImageGenerateTool: () => mocks.stubTool("image_generate"),
}));

vi.mock("./tools/image-tool.js", () => ({
  createImageTool: () => mocks.stubTool("image"),
}));

vi.mock("./tools/message-tool-execution.js", () => ({
  createMessageTool: () => mocks.stubTool("message"),
}));

vi.mock("./tools/music-generate-tool.js", () => ({
  createMusicGenerateTool: () => mocks.stubTool("music_generate"),
}));

vi.mock("./tools/nodes-tool.js", () => ({
  createNodesTool: () => mocks.stubTool("nodes"),
}));

vi.mock("./tools/pdf-tool.js", () => ({
  createPdfTool: () => mocks.stubTool("pdf"),
}));

vi.mock("./tools/session-status-tool.js", () => ({
  createSessionStatusTool: () => mocks.stubTool("session_status"),
}));

vi.mock("./tools/sessions-history-tool.js", () => ({
  createSessionsHistoryTool: () => mocks.stubTool("sessions_history"),
}));

vi.mock("./tools/sessions-list-tool.js", () => ({
  createSessionsListTool: () => mocks.stubTool("sessions_list"),
}));

vi.mock("./tools/sessions-send-tool.js", () => ({
  createSessionsSendTool: () => mocks.stubTool("sessions_send"),
}));

vi.mock("./tools/sessions-spawn-tool.js", () => ({
  createSessionsSpawnTool: () => mocks.stubTool("sessions_spawn"),
}));

vi.mock("./tools/sessions-yield-tool.js", () => ({
  createSessionsYieldTool: () => mocks.stubTool("sessions_yield"),
}));

vi.mock("./tools/subagents-tool.js", () => ({
  createSubagentsTool: () => mocks.stubTool("subagents"),
}));

vi.mock("./tools/terminal-tool.js", () => ({
  createTerminalTool: mocks.createTerminalTool,
}));

vi.mock("./tools/transcripts-tool.js", () => ({
  createTranscriptsTool: () => mocks.stubTool("transcripts"),
}));

vi.mock("./tools/update-plan-tool.js", () => ({
  createUpdatePlanTool: () => mocks.stubTool("update_plan"),
}));

vi.mock("./tools/video-generate-tool.js", () => ({
  createVideoGenerateTool: () => mocks.stubTool("video_generate"),
}));

vi.mock("./tools/web-tools.js", () => ({
  createWebFetchTool: () => mocks.stubTool("web_fetch"),
  createWebSearchTool: () => mocks.stubTool("web_search"),
}));

describe("createOpenClawTools terminal exec-policy wiring", () => {
  beforeEach(() => {
    mocks.createTerminalTool.mockClear();
    mocks.terminalToolOptions = undefined;
  });

  it("forwards the swarm non-interactive approval policy to the terminal tool", () => {
    createOpenClawTools({
      swarmCollector: true,
      agentSessionKey: "agent:main:main",
    });

    expect(mocks.createTerminalTool).toHaveBeenCalledTimes(1);
    expect(mocks.terminalToolOptions).toMatchObject({
      nonInteractiveApproval: true,
    });
  });

  it("leaves non-interactive approval unset for regular runs", () => {
    createOpenClawTools({
      agentSessionKey: "agent:main:main",
    });

    expect(mocks.createTerminalTool).toHaveBeenCalledTimes(1);
    expect(
      (mocks.terminalToolOptions as { nonInteractiveApproval?: boolean } | undefined)
        ?.nonInteractiveApproval,
    ).toBeUndefined();
  });

  it("forwards the prepared session permission policy to the terminal tool", () => {
    const sessionPermissionPolicy = { root: "/workspace", mode: "read-only" as const };
    createOpenClawTools({
      agentSessionKey: "agent:main:main",
      sessionPermissionPolicy,
    });

    expect(mocks.createTerminalTool).toHaveBeenCalledTimes(1);
    expect(mocks.terminalToolOptions).toMatchObject({
      sessionPermissionPolicy,
    });
  });

  it("leaves the session permission policy unset for unrestricted runs", () => {
    createOpenClawTools({
      agentSessionKey: "agent:main:main",
    });

    expect(mocks.createTerminalTool).toHaveBeenCalledTimes(1);
    expect(
      (mocks.terminalToolOptions as { sessionPermissionPolicy?: unknown } | undefined)
        ?.sessionPermissionPolicy,
    ).toBeUndefined();
  });
});
