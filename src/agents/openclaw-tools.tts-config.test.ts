// Verifies createOpenClawTools wires shared config and context into the TTS tool.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { testing, createOpenClawTools } from "./openclaw-tools.js";
import type { AnyAgentTool } from "./tools/common.js";

const mocks = vi.hoisted(() => {
  // Stub every non-TTS tool so this suite isolates TTS option plumbing.
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
    createCronToolOptions: vi.fn(),
    createSessionStatusToolOptions: vi.fn(),
    createImageGenerateToolOptions: vi.fn(),
    createMusicGenerateToolOptions: vi.fn(),
    createVideoGenerateToolOptions: vi.fn(),
    textToSpeech: vi.fn(async () => ({
      success: true,
      audioPath: "/tmp/openclaw/tts-config-test.opus",
      provider: "microsoft",
      voiceCompatible: true,
    })),
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
  createCronTool: (options: unknown) => {
    mocks.createCronToolOptions(options);
    return mocks.stubTool("cron");
  },
}));

vi.mock("./tools/gateway-tool.js", () => ({
  createGatewayTool: () => mocks.stubTool("gateway"),
}));

vi.mock("./tools/image-generate-tool.js", () => ({
  createImageGenerateTool: (options: unknown) => {
    mocks.createImageGenerateToolOptions(options);
    return mocks.stubTool("image_generate");
  },
}));

vi.mock("./tools/image-tool.js", () => ({
  createImageTool: () => mocks.stubTool("image"),
}));

vi.mock("./tools/message-tool.js", () => ({
  createMessageTool: () => mocks.stubTool("message"),
}));

vi.mock("./tools/music-generate-tool.js", () => ({
  createMusicGenerateTool: (options: unknown) => {
    mocks.createMusicGenerateToolOptions(options);
    return mocks.stubTool("music_generate");
  },
}));

vi.mock("./tools/nodes-tool.js", () => ({
  createNodesTool: () => mocks.stubTool("nodes"),
}));

vi.mock("./tools/pdf-tool.js", () => ({
  createPdfTool: () => mocks.stubTool("pdf"),
}));

vi.mock("./tools/session-status-tool.js", () => ({
  createSessionStatusTool: (options: unknown) => {
    mocks.createSessionStatusToolOptions(options);
    return mocks.stubTool("session_status");
  },
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

vi.mock("./tools/update-plan-tool.js", () => ({
  createUpdatePlanTool: () => mocks.stubTool("update_plan"),
}));

vi.mock("./tools/video-generate-tool.js", () => ({
  createVideoGenerateTool: (options: unknown) => {
    mocks.createVideoGenerateToolOptions(options);
    return mocks.stubTool("video_generate");
  },
}));

vi.mock("./tools/web-tools.js", () => ({
  createWebFetchTool: () => mocks.stubTool("web_fetch"),
  createWebSearchTool: () => mocks.stubTool("web_search"),
}));

vi.mock("../tts/tts.js", () => ({
  textToSpeech: mocks.textToSpeech,
}));

function getTextToSpeechParams() {
  // The mocked TTS runtime exposes the exact invocation payload for assertions.
  const calls = (mocks.textToSpeech as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[0]?.[0] as
    | {
        text?: string;
        cfg?: OpenClawConfig;
        agentId?: string;
        channel?: string;
        accountId?: string;
      }
    | undefined;
}

describe("createOpenClawTools TTS config wiring", () => {
  beforeEach(() => {
    mocks.createCronToolOptions.mockClear();
    mocks.createImageGenerateToolOptions.mockClear();
    mocks.createMusicGenerateToolOptions.mockClear();
    mocks.createVideoGenerateToolOptions.mockClear();
    mocks.textToSpeech.mockClear();
  });

  it("passes the resolved shared config into the tts tool", async () => {
    const injectedConfig = {
      messages: {
        tts: {
          auto: "always",
          provider: "microsoft",
          providers: {
            microsoft: {
              voice: "en-US-AvaNeural",
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    testing.setDepsForTest({ config: injectedConfig });

    try {
      const tool = createOpenClawTools({
        disableMessageTool: true,
        disablePluginTools: true,
      }).find((candidate) => candidate.name === "tts");

      if (!tool) {
        throw new Error("missing tts tool");
      }

      await tool.execute("call-1", { text: "hello from config" });

      const ttsParams = getTextToSpeechParams();
      expect(ttsParams?.text).toBe("hello from config");
      expect(ttsParams?.cfg).toBe(injectedConfig);
    } finally {
      testing.setDepsForTest();
    }
  });

  it("keeps direct TTS tool guidance explicit even when the tool is available", async () => {
    testing.setDepsForTest({ config: {} });

    try {
      const tool = createOpenClawTools({
        disableMessageTool: true,
        disablePluginTools: true,
      }).find((candidate) => candidate.name === "tts");

      if (!tool) {
        throw new Error("missing tts tool");
      }

      expect(tool.description).toContain("Only explicit voice/speech/TTS intent");
      expect(tool.description).toContain("never ordinary text reply");
    } finally {
      testing.setDepsForTest();
    }
  });

  it("passes the resolved session agent id into the tts tool", async () => {
    const injectedConfig = {
      agents: {
        list: [{ id: "reader" }, { id: "main" }],
      },
    } satisfies OpenClawConfig;

    testing.setDepsForTest({ config: injectedConfig });

    try {
      const tool = createOpenClawTools({
        agentSessionKey: "agent:reader:telegram:chat:123",
        disableMessageTool: true,
        disablePluginTools: true,
      }).find((candidate) => candidate.name === "tts");

      if (!tool) {
        throw new Error("missing tts tool");
      }

      await tool.execute("call-1", { text: "hello from reader" });

      const ttsParams = getTextToSpeechParams();
      expect(ttsParams?.text).toBe("hello from reader");
      expect(ttsParams?.agentId).toBe("reader");
    } finally {
      testing.setDepsForTest();
    }
  });

  it("passes the active account id into the tts tool", async () => {
    const injectedConfig = {
      channels: {
        feishu: {
          accounts: {
            "feishu-main": {
              tts: {
                provider: "microsoft",
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    testing.setDepsForTest({ config: injectedConfig });

    try {
      const tool = createOpenClawTools({
        agentChannel: "feishu",
        agentAccountId: "feishu-main",
        disableMessageTool: true,
        disablePluginTools: true,
      }).find((candidate) => candidate.name === "tts");

      if (!tool) {
        throw new Error("missing tts tool");
      }

      await tool.execute("call-1", { text: "hello from account" });

      const ttsParams = getTextToSpeechParams();
      expect(ttsParams?.text).toBe("hello from account");
      expect(ttsParams?.cfg).toBe(injectedConfig);
      expect(ttsParams?.channel).toBe("feishu");
      expect(ttsParams?.accountId).toBe("feishu-main");
    } finally {
      testing.setDepsForTest();
    }
  });
});

describe("createOpenClawTools media generation session wiring", () => {
  beforeEach(() => {
    mocks.createImageGenerateToolOptions.mockClear();
    mocks.createMusicGenerateToolOptions.mockClear();
    mocks.createVideoGenerateToolOptions.mockClear();
  });

  it("uses the isolated cron run key for background media completions", () => {
    const config = {
      agents: {
        defaults: {
          imageGenerationModel: { primary: "image-owner/model" },
          videoGenerationModel: { primary: "video-owner/model" },
          musicGenerationModel: { primary: "music-owner/model" },
        },
      },
    } satisfies OpenClawConfig;

    createOpenClawTools({
      config,
      agentSessionKey: "agent:main:cron:daily-media",
      runSessionKey: "agent:main:cron:daily-media:run:run-123",
      disableMessageTool: true,
      disablePluginTools: true,
      onYield: vi.fn(),
    });

    expect(mocks.createImageGenerateToolOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionKey: "agent:main:cron:daily-media:run:run-123",
        onAsyncTaskStarted: undefined,
      }),
    );
    expect(mocks.createVideoGenerateToolOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionKey: "agent:main:cron:daily-media:run:run-123",
      }),
    );
    expect(mocks.createMusicGenerateToolOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionKey: "agent:main:cron:daily-media:run:run-123",
      }),
    );
  });

  it("keeps the requester session key for non-cron media completions", () => {
    const config = {
      agents: {
        defaults: {
          imageGenerationModel: { primary: "image-owner/model" },
        },
      },
    } satisfies OpenClawConfig;

    createOpenClawTools({
      config,
      agentSessionKey: "agent:main:slack:channel:C123",
      runSessionKey: "agent:main:slack:channel:C123:run:run-123",
      disableMessageTool: true,
      disablePluginTools: true,
    });

    expect(mocks.createImageGenerateToolOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionKey: "agent:main:slack:channel:C123",
      }),
    );
  });
});

describe("createOpenClawTools session status route context wiring", () => {
  beforeEach(() => {
    mocks.createSessionStatusToolOptions.mockClear();
  });

  it("passes the active live-run route into the session_status tool", () => {
    createOpenClawTools({
      agentSessionKey: "agent:main:discord:channel:1489550370136129537",
      runSessionKey: "agent:main:discord:channel:1489550370136129537",
      agentChannel: "webchat",
      agentAccountId: "browser",
      agentTo: "channel:1489550370136129537",
      agentThreadId: "origin-thread",
      currentChannelId: "webchat:control-ui",
      currentThreadTs: "webchat-thread-1",
      disableMessageTool: true,
      disablePluginTools: true,
    });

    expect(mocks.createSessionStatusToolOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionKey: "agent:main:discord:channel:1489550370136129537",
        runSessionKey: "agent:main:discord:channel:1489550370136129537",
        activeDeliveryContext: {
          channel: "webchat",
          to: "webchat:control-ui",
          accountId: "browser",
          threadId: "webchat-thread-1",
        },
      }),
    );
  });
});

describe("createOpenClawTools cron context wiring", () => {
  beforeEach(() => {
    mocks.createCronToolOptions.mockClear();
  });

  it("passes preserved channel delivery context into the cron tool", async () => {
    createOpenClawTools({
      agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
      agentChannel: "matrix",
      agentAccountId: "bot-a",
      agentTo: "room:!FallbackRoom:Example.Org",
      agentThreadId: "$FallbackThread:Example.Org",
      currentChannelId: "room:!AbCdEf1234567890:example.org",
      currentThreadTs: "$RootEvent:Example.Org",
      disableMessageTool: true,
      disablePluginTools: true,
    });

    expect(mocks.createCronToolOptions).toHaveBeenCalledWith({
      agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
      currentDeliveryContext: {
        channel: "matrix",
        to: "room:!AbCdEf1234567890:example.org",
        accountId: "bot-a",
        threadId: "$RootEvent:Example.Org",
      },
    });
  });

  it("uses agent route context when auto-threading context is unavailable", async () => {
    createOpenClawTools({
      agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
      agentChannel: "matrix",
      agentAccountId: "bot-a",
      agentTo: "room:!FallbackRoom:Example.Org",
      agentThreadId: "$FallbackThread:Example.Org",
      disableMessageTool: true,
      disablePluginTools: true,
    });

    expect(mocks.createCronToolOptions).toHaveBeenCalledWith({
      agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
      currentDeliveryContext: {
        channel: "matrix",
        to: "room:!FallbackRoom:Example.Org",
        accountId: "bot-a",
        threadId: "$FallbackThread:Example.Org",
      },
    });
  });

  it("passes self-remove scope into the cron tool", async () => {
    createOpenClawTools({
      agentSessionKey: "agent:main:cron:job-current",
      cronSelfRemoveOnlyJobId: "job-current",
      disableMessageTool: true,
      disablePluginTools: true,
    });

    expect(mocks.createCronToolOptions).toHaveBeenCalledWith({
      agentSessionKey: "agent:main:cron:job-current",
      currentDeliveryContext: {
        channel: undefined,
        to: undefined,
        accountId: undefined,
        threadId: undefined,
      },
      selfRemoveOnlyJobId: "job-current",
    });
  });
});
