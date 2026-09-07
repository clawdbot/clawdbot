// Verifies createOpenClawTools passes the durable runSessionKey (not the
// sandbox/policy agentSessionKey) to sessions_spawn as the parent lineage key.
// Regression for #137690: Telegram DM visible spawns failed because the policy
// key (with account-id segment) was used as parentSessionKey, but the durable
// store entry is persisted under a different key.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./common.js";

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
    spawnToolOptions: vi.fn(),
    subagentsToolOptions: vi.fn(),
    imageGenerateToolOptions: vi.fn(),
    videoGenerateToolOptions: vi.fn(),
    musicGenerateToolOptions: vi.fn(),
  };
});

vi.mock("../openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

vi.mock("../openclaw-tools.media-factory-plan.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  // Force every media generator to be constructed so the factory-boundary regression
  // can assert the agentSessionKey each one receives, without re-implementing the rest
  // of the plan module.
  return {
    ...actual,
    resolveOptionalMediaToolFactoryPlan: () => ({
      imageGenerate: true,
      videoGenerate: true,
      musicGenerate: true,
      pdf: false,
    }),
  };
});

vi.mock("../openclaw-tools.nodes-workspace-guard.js", () => ({
  applyNodesToolWorkspaceGuard: (tool: AnyAgentTool) => tool,
}));

vi.mock("./agents-list-tool.js", () => ({
  createAgentsListTool: () => mocks.stubTool("agents_list"),
}));

vi.mock("./cron-tool.js", () => ({
  createCronTool: () => mocks.stubTool("cron"),
}));

vi.mock("./gateway-tool.js", () => ({
  createGatewayTool: () => mocks.stubTool("gateway"),
}));

vi.mock("./image-generate-tool.js", () => ({
  createImageGenerateTool: (options: unknown) => {
    mocks.imageGenerateToolOptions(options);
    return mocks.stubTool("image_generate");
  },
}));

vi.mock("./image-tool.js", () => ({
  createImageTool: () => mocks.stubTool("view_image"),
}));

vi.mock("./message-tool-execution.js", () => ({
  createMessageTool: () => mocks.stubTool("message"),
}));

vi.mock("./music-generate-tool.js", () => ({
  createMusicGenerateTool: (options: unknown) => {
    mocks.musicGenerateToolOptions(options);
    return mocks.stubTool("music_generate");
  },
}));

vi.mock("./nodes-tool.js", () => ({
  createNodesTool: () => mocks.stubTool("nodes"),
}));

vi.mock("./pdf-tool.js", () => ({
  createPdfTool: () => mocks.stubTool("pdf"),
}));

vi.mock("./session-status-tool.js", () => ({
  createSessionStatusTool: () => mocks.stubTool("session_status"),
}));

vi.mock("./sessions-history-tool.js", () => ({
  createSessionsHistoryTool: () => mocks.stubTool("sessions_history"),
}));

vi.mock("./sessions-list-tool.js", () => ({
  createSessionsListTool: () => mocks.stubTool("sessions_list"),
}));

vi.mock("./sessions-send-tool.js", () => ({
  createSessionsSendTool: () => mocks.stubTool("sessions_send"),
}));

vi.mock("./sessions-spawn-tool.js", () => ({
  createSessionsSpawnTool: (options: unknown) => {
    mocks.spawnToolOptions(options);
    return mocks.stubTool("sessions_spawn");
  },
}));

vi.mock("./sessions-yield-tool.js", () => ({
  createSessionsYieldTool: () => mocks.stubTool("sessions_yield"),
}));

vi.mock("./subagents-tool.js", () => ({
  createSubagentsTool: (options: unknown) => {
    mocks.subagentsToolOptions(options);
    return mocks.stubTool("subagents");
  },
}));

vi.mock("./transcripts-tool.js", () => ({
  createTranscriptsTool: () => mocks.stubTool("transcripts"),
}));

vi.mock("./video-generate-tool.js", () => ({
  createVideoGenerateTool: (options: unknown) => {
    mocks.videoGenerateToolOptions(options);
    return mocks.stubTool("video_generate");
  },
}));

vi.mock("./web-tools.js", () => ({
  createWebFetchTool: () => mocks.stubTool("web_fetch"),
  createWebSearchTool: () => mocks.stubTool("web_search"),
}));

import { createOpenClawTools } from "../openclaw-tools.js";

describe("createOpenClawTools sessions_spawn session-key selection", () => {
  beforeEach(() => {
    mocks.spawnToolOptions.mockClear();
    mocks.subagentsToolOptions.mockClear();
    mocks.imageGenerateToolOptions.mockClear();
    mocks.videoGenerateToolOptions.mockClear();
    mocks.musicGenerateToolOptions.mockClear();
  });

  it("passes the durable runSessionKey as agentSessionKey when both keys differ", () => {
    // Regression for #137690: the factory must prefer runSessionKey (durable
    // store key) over agentSessionKey (sandbox/policy key) so that visible
    // spawns resolve the correct persisted parent in Gateway.
    const policyKey = "agent:main:telegram:default:direct:456";
    const durableKey = "agent:main:telegram:direct:456";

    createOpenClawTools({
      agentSessionKey: policyKey,
      runSessionKey: durableKey,
      disableMessageTool: true,
      disablePluginTools: true,
    });

    expect(mocks.spawnToolOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionKey: durableKey,
        completionOwnerKey: durableKey,
      }),
    );
    // The policy key must NOT leak into the spawn tool's agentSessionKey.
    const call = mocks.spawnToolOptions.mock.calls[0]?.[0] as
      | { agentSessionKey?: string }
      | undefined;
    expect(call?.agentSessionKey).not.toBe(policyKey);
  });

  it("falls back to agentSessionKey when runSessionKey is absent", () => {
    const policyKey = "agent:main:telegram:default:direct:456";

    createOpenClawTools({
      agentSessionKey: policyKey,
      disableMessageTool: true,
      disablePluginTools: true,
    });

    expect(mocks.spawnToolOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionKey: policyKey,
      }),
    );
  });

  it("passes the durable runSessionKey to createSubagentsTool when keys differ", () => {
    // Regression for the ClawSweeper P1 finding on #137779: spawn registers runs under the
    // durable controller key (derived from the spawn tool's agentSessionKey), but the
    // subagents listing tool matches that key by exact equality. If the listing tool kept
    // receiving the policy key, split-key callers (Telegram DM) would never see their newly
    // spawned runs. The factory must hand the listing tool the same durable key.
    const policyKey = "agent:main:telegram:default:direct:456";
    const durableKey = "agent:main:telegram:direct:456";

    createOpenClawTools({
      agentSessionKey: policyKey,
      runSessionKey: durableKey,
      disableMessageTool: true,
      disablePluginTools: true,
    });

    expect(mocks.subagentsToolOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionKey: durableKey,
        // The policy key is forwarded as the fallback owner key so retained task rows
        // (created before the durable-key alignment, still carrying the policy key in
        // owner_key) stay reachable and cancellable for split-key callers.
        callerPolicySessionKey: policyKey,
      }),
    );
    // The policy key must NOT reach the listing tool as the primary agentSessionKey,
    // or split-key runs stay invisible.
    const call = mocks.subagentsToolOptions.mock.calls[0]?.[0] as
      | { agentSessionKey?: string }
      | undefined;
    expect(call?.agentSessionKey).not.toBe(policyKey);
  });

  it("passes agentSessionKey to createSubagentsTool when runSessionKey is absent", () => {
    const policyKey = "agent:main:telegram:default:direct:456";

    createOpenClawTools({
      agentSessionKey: policyKey,
      disableMessageTool: true,
      disablePluginTools: true,
    });

    expect(mocks.subagentsToolOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionKey: policyKey,
      }),
    );
  });

  it("preserves the policy owner key for non-cron media tasks when keys differ", () => {
    // Retained tasks use the policy key for media status and duplicate lookup.
    // The subagents tool accepts both keys without changing media ownership.
    const policyKey = "agent:main:telegram:default:direct:456";
    const durableKey = "agent:main:telegram:direct:456";

    createOpenClawTools({
      agentSessionKey: policyKey,
      runSessionKey: durableKey,
      disableMessageTool: true,
      disablePluginTools: true,
    });

    for (const [name, captured] of [
      ["image_generate", mocks.imageGenerateToolOptions],
      ["video_generate", mocks.videoGenerateToolOptions],
      ["music_generate", mocks.musicGenerateToolOptions],
    ] as const) {
      expect(captured, `${name} tool should be constructed`).toHaveBeenCalledWith(
        expect.objectContaining({ agentSessionKey: policyKey }),
      );
      const call = captured.mock.calls[0]?.[0] as { agentSessionKey?: string } | undefined;
      expect(call?.agentSessionKey, `${name} must retain existing task ownership`).not.toBe(
        durableKey,
      );
    }
  });

  it("passes agentSessionKey to media-generation tools when runSessionKey is absent", () => {
    const policyKey = "agent:main:telegram:default:direct:456";

    createOpenClawTools({
      agentSessionKey: policyKey,
      disableMessageTool: true,
      disablePluginTools: true,
    });

    expect(mocks.imageGenerateToolOptions).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionKey: policyKey }),
    );
  });
});
