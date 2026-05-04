import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { __testing as cliBackendsTesting } from "../cli-backends.js";
import { hashCliSessionText } from "../cli-session.js";
import { buildActiveMusicGenerationTaskPromptContextForSession } from "../music-generation-task-status.js";
import { buildActiveVideoGenerationTaskPromptContextForSession } from "../video-generation-task-status.js";
import {
  prepareCliRunContext,
  setCliRunnerPrepareTestDeps,
  shouldSkipLocalCliCredentialEpoch,
} from "./prepare.js";

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../../plugin-sdk/anthropic-cli.js", () => ({
  CLAUDE_CLI_BACKEND_ID: "claude-cli",
  isClaudeCliProvider: (providerId: string) => providerId === "claude-cli",
}));

vi.mock("../../tts/tts.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
}));

vi.mock("../video-generation-task-status.js", () => ({
  VIDEO_GENERATION_TASK_KIND: "video_generation",
  buildActiveVideoGenerationTaskPromptContextForSession: vi.fn(() => undefined),
  buildVideoGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildVideoGenerationTaskStatusText: vi.fn(() => ""),
  findActiveVideoGenerationTaskForSession: vi.fn(() => undefined),
  getVideoGenerationTaskProviderId: vi.fn(() => undefined),
  isActiveVideoGenerationTask: vi.fn(() => false),
}));

vi.mock("../music-generation-task-status.js", () => ({
  MUSIC_GENERATION_TASK_KIND: "music_generation",
  buildActiveMusicGenerationTaskPromptContextForSession: vi.fn(() => undefined),
  buildMusicGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildMusicGenerationTaskStatusText: vi.fn(() => ""),
  findActiveMusicGenerationTaskForSession: vi.fn(() => undefined),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const mockBuildActiveVideoGenerationTaskPromptContextForSession = vi.mocked(
  buildActiveVideoGenerationTaskPromptContextForSession,
);
const mockBuildActiveMusicGenerationTaskPromptContextForSession = vi.mocked(
  buildActiveMusicGenerationTaskPromptContextForSession,
);

function createTestMcpLoopbackServerConfig(port: number) {
  return {
    mcpServers: {
      openclaw: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: {
          Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
          "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
          "x-openclaw-agent-id": "${OPENCLAW_MCP_AGENT_ID}",
          "x-openclaw-account-id": "${OPENCLAW_MCP_ACCOUNT_ID}",
          "x-openclaw-message-channel": "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
        },
      },
    },
  };
}

async function createTestMcpLoopbackServer(port = 0) {
  return {
    port,
    close: vi.fn(async () => undefined),
  };
}

function createCliBackendConfig(
  params: { systemPromptOverride?: string | null; bundleMcp?: boolean } = {},
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        ...(params.systemPromptOverride !== null
          ? { systemPromptOverride: params.systemPromptOverride ?? "test system prompt" }
          : {}),
        cliBackends: {
          "test-cli": {
            command: "test-cli",
            args: ["--print"],
            systemPromptArg: "--system-prompt",
            systemPromptWhen: "first",
            sessionMode: "existing",
            output: "text",
            input: "arg",
            ...(params.bundleMcp
              ? { bundleMcp: true, bundleMcpMode: "claude-config-file" as const }
              : {}),
          },
        },
      },
    },
  } satisfies OpenClawConfig;
}

function createSessionFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-prepare-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  const sessionFile = path.join(dir, "agents", "main", "sessions", "session-test.jsonl");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: "session-test",
      timestamp: new Date(0).toISOString(),
      cwd: dir,
    })}\n`,
    "utf-8",
  );
  return { dir, sessionFile };
}

function appendTranscriptEntry(
  sessionFile: string,
  entry: {
    id: string;
    parentId: string | null;
    timestamp: string;
    message: unknown;
  },
): void {
  fs.appendFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "message",
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp,
      message: entry.message,
    })}\n`,
    "utf-8",
  );
}

describe("shouldSkipLocalCliCredentialEpoch", () => {
  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [],
    });
    setCliRunnerPrepareTestDeps({
      makeBootstrapWarn: vi.fn(() => () => undefined),
      resolveBootstrapContextForRun: vi.fn(async () => ({
        bootstrapFiles: [],
        contextFiles: [],
      })),
      getActiveMcpLoopbackRuntime: vi.fn(() => undefined),
      ensureMcpLoopbackServer: vi.fn(createTestMcpLoopbackServer),
      createMcpLoopbackServerConfig: vi.fn(createTestMcpLoopbackServerConfig),
      resolveOpenClawReferencePaths: vi.fn(async () => ({ docsPath: null, sourcePath: null })),
    });
    mockGetGlobalHookRunner.mockReturnValue(null);
    mockBuildActiveVideoGenerationTaskPromptContextForSession.mockReturnValue(undefined);
    mockBuildActiveMusicGenerationTaskPromptContextForSession.mockReturnValue(undefined);
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    mockGetGlobalHookRunner.mockReset();
    mockBuildActiveVideoGenerationTaskPromptContextForSession.mockReset();
    mockBuildActiveMusicGenerationTaskPromptContextForSession.mockReset();
    vi.unstubAllEnvs();
  });

  it("skips local cli auth only when a profile-owned execution was prepared", () => {
    expect(
      shouldSkipLocalCliCredentialEpoch({
        authEpochMode: "profile-only",
        authProfileId: "openai-codex:default",
        authCredential: {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
        preparedExecution: {
          env: {
            CODEX_HOME: "/tmp/codex-home",
          },
        },
      }),
    ).toBe(true);
  });

  it("keeps local cli auth in the epoch when the selected profile has no bridgeable execution", () => {
    expect(
      shouldSkipLocalCliCredentialEpoch({
        authEpochMode: "profile-only",
        authProfileId: "openai-codex:default",
        authCredential: undefined,
        preparedExecution: null,
      }),
    ).toBe(false);
  });

  it("applies prompt-build hook context to Claude-style CLI preparation", async () => {
    const { dir, sessionFile } = createSessionFile();
    try {
      appendTranscriptEntry(sessionFile, {
        id: "msg-1",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: { role: "user", content: "earlier context", timestamp: 1 },
      });
      appendTranscriptEntry(sessionFile, {
        id: "msg-2",
        parentId: "msg-1",
        timestamp: new Date(2).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "earlier reply" }],
          api: "responses",
          provider: "test-cli",
          model: "test-model",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
        },
      });
      const hookRunner = {
        hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
        runBeforePromptBuild: vi.fn(async ({ messages }: { messages: unknown[] }) => ({
          prependContext: `history:${messages.length}`,
          systemPrompt: "hook system",
          prependSystemContext: "prepend system",
          appendSystemContext: "append system",
        })),
        runBeforeAgentStart: vi.fn(),
      };
      mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);

      const context = await prepareCliRunContext({
        sessionId: "session-test",
        sessionKey: "agent:main:test",
        agentId: "main",
        trigger: "user",
        sessionFile,
        workspaceDir: dir,
        prompt: "latest ask",
        provider: "test-cli",
        model: "test-model",
        timeoutMs: 1_000,
        runId: "run-test",
        messageChannel: "telegram",
        messageProvider: "acp",
        config: {
          ...createCliBackendConfig(),
        },
      });

      expect(context.params.prompt).toBe("history:2\n\nlatest ask");
      expect(context.systemPrompt).toBe("prepend system\n\nhook system\n\nappend system");
      expect(hookRunner.runBeforePromptBuild).toHaveBeenCalledWith(
        {
          prompt: "latest ask",
          messages: [
            { role: "user", content: "earlier context", timestamp: 1 },
            {
              role: "assistant",
              content: [{ type: "text", text: "earlier reply" }],
              api: "responses",
              provider: "test-cli",
              model: "test-model",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: 2,
            },
          ],
        },
        expect.objectContaining({
          runId: "run-test",
          agentId: "main",
          sessionKey: "agent:main:test",
          sessionId: "session-test",
          workspaceDir: dir,
          modelProviderId: "test-cli",
          modelId: "test-model",
          messageProvider: "acp",
          trigger: "user",
          channelId: "telegram",
        }),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks inter-session prompts after CLI prompt-build hook context is applied", async () => {
    const { dir, sessionFile } = createSessionFile();
    try {
      const hookRunner = {
        hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
        runBeforePromptBuild: vi.fn(async () => ({
          prependContext: "trusted hook context",
        })),
        runBeforeAgentStart: vi.fn(),
      };
      mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);

      const context = await prepareCliRunContext({
        sessionId: "session-test",
        sessionKey: "agent:main:test",
        agentId: "main",
        trigger: "user",
        sessionFile,
        workspaceDir: dir,
        prompt: "foreign reply text",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:slack:dm:U123",
          sourceChannel: "slack",
          sourceTool: "sessions_send",
        },
        provider: "test-cli",
        model: "test-model",
        timeoutMs: 1_000,
        runId: "run-test",
        config: createCliBackendConfig(),
      });

      expect(context.params.prompt).toMatch(/^\[Inter-session message/);
      expect(context.params.prompt).toContain("sourceSession=agent:main:slack:dm:U123");
      expect(context.params.prompt).toContain("isUser=false");
      expect(context.params.prompt).toContain("trusted hook context");
      expect(context.params.prompt).toContain("foreign reply text");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies agent_turn_prepare-only context on the CLI path", async () => {
    const { dir, sessionFile } = createSessionFile();
    try {
      const hookRunner = {
        hasHooks: vi.fn((hookName: string) => hookName === "agent_turn_prepare"),
        runAgentTurnPrepare: vi.fn(async () => ({
          prependContext: "turn prepend",
          appendContext: "turn append",
        })),
        runBeforePromptBuild: vi.fn(),
        runBeforeAgentStart: vi.fn(),
      };
      mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);

      const context = await prepareCliRunContext({
        sessionId: "session-test",
        sessionKey: "agent:main:test",
        agentId: "main",
        trigger: "user",
        sessionFile,
        workspaceDir: dir,
        prompt: "latest ask",
        provider: "test-cli",
        model: "test-model",
        timeoutMs: 1_000,
        runId: "run-test-turn-prepare",
        config: createCliBackendConfig(),
      });

      expect(context.params.prompt).toBe("turn prepend\n\nlatest ask\n\nturn append");
      expect(hookRunner.runAgentTurnPrepare).toHaveBeenCalledWith(
        {
          prompt: "latest ask",
          messages: [],
          queuedInjections: [],
        },
        expect.objectContaining({
          runId: "run-test-turn-prepare",
          sessionKey: "agent:main:test",
        }),
      );
      expect(hookRunner.runBeforePromptBuild).not.toHaveBeenCalled();
      expect(hookRunner.runBeforeAgentStart).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges before_prompt_build and legacy before_agent_start hook context for CLI preparation", async () => {
    const { dir, sessionFile } = createSessionFile();
    try {
      const hookRunner = {
        hasHooks: vi.fn((_hookName: string) => true),
        runBeforePromptBuild: vi.fn(async () => ({
          prependContext: "prompt prepend",
          systemPrompt: "prompt system",
          prependSystemContext: "prompt prepend system",
          appendSystemContext: "prompt append system",
        })),
        runBeforeAgentStart: vi.fn(async () => ({
          prependContext: "legacy prepend",
          systemPrompt: "legacy system",
          prependSystemContext: "legacy prepend system",
          appendSystemContext: "legacy append system",
        })),
      };
      mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);

      const context = await prepareCliRunContext({
        sessionId: "session-test",
        sessionFile,
        workspaceDir: dir,
        prompt: "latest ask",
        provider: "test-cli",
        model: "test-model",
        timeoutMs: 1_000,
        runId: "run-test-legacy-merge",
        config: createCliBackendConfig({ systemPromptOverride: null }),
      });

      expect(context.params.prompt).toBe("prompt prepend\n\nlegacy prepend\n\nlatest ask");
      expect(context.systemPrompt).toBe(
        "prompt prepend system\n\nlegacy prepend system\n\nprompt system\n\nprompt append system\n\nlegacy append system",
      );
      expect(hookRunner.runBeforePromptBuild).toHaveBeenCalledOnce();
      expect(hookRunner.runBeforeAgentStart).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves the base prompt when prompt-build hooks fail", async () => {
    const { dir, sessionFile } = createSessionFile();
    try {
      const hookRunner = {
        hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
        runBeforePromptBuild: vi.fn(async () => {
          throw new Error("hook exploded");
        }),
        runBeforeAgentStart: vi.fn(),
      };
      mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);

      const context = await prepareCliRunContext({
        sessionId: "session-test",
        sessionFile,
        workspaceDir: dir,
        prompt: "latest ask",
        provider: "test-cli",
        model: "test-model",
        timeoutMs: 1_000,
        runId: "run-test-hook-failure",
        config: createCliBackendConfig({ systemPromptOverride: "base extra system" }),
      });

      expect(context.params.prompt).toBe("latest ask");
      expect(context.systemPrompt).toBe("base extra system");
      expect(context.systemPrompt).not.toContain("hook exploded");
      expect(hookRunner.runBeforePromptBuild).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses explicit static prompt text for CLI session reuse hashing", async () => {
    const { dir, sessionFile } = createSessionFile();
    try {
      const context = await prepareCliRunContext({
        sessionId: "session-test",
        sessionFile,
        workspaceDir: dir,
        prompt: "latest ask",
        provider: "test-cli",
        model: "test-model",
        timeoutMs: 1_000,
        runId: "run-test-static-prompt",
        extraSystemPrompt: "## Inbound Context\nchannel=telegram",
        extraSystemPromptStatic: "",
        cliSessionBinding: {
          sessionId: "cli-session",
        },
        config: createCliBackendConfig({ systemPromptOverride: null }),
      });

      expect(context.systemPrompt).toContain("## Inbound Context\nchannel=telegram");
      expect(context.extraSystemPromptHash).toBeUndefined();
      expect(context.reusableCliSession).toEqual({ sessionId: "cli-session" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores volatile prompt text when static prompt text matches", async () => {
    const { dir, sessionFile } = createSessionFile();
    try {
      const staticPrompt = "## Direct Context\nYou are in a Telegram direct conversation.";
      const context = await prepareCliRunContext({
        sessionId: "session-test",
        sessionFile,
        workspaceDir: dir,
        prompt: "latest ask",
        provider: "test-cli",
        model: "test-model",
        timeoutMs: 1_000,
        runId: "run-test-volatile-prompt",
        extraSystemPrompt: `## Inbound Context\nchannel=heartbeat\n\n${staticPrompt}`,
        extraSystemPromptStatic: staticPrompt,
        cliSessionBinding: {
          sessionId: "cli-session",
          extraSystemPromptHash: hashCliSessionText(staticPrompt),
        },
        config: createCliBackendConfig(),
      });

      expect(context.extraSystemPromptHash).toBe(hashCliSessionText(staticPrompt));
      expect(context.reusableCliSession).toEqual({ sessionId: "cli-session" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies direct-run prepend system context helpers on the CLI path", async () => {
    const { dir, sessionFile } = createSessionFile();
    try {
      mockBuildActiveVideoGenerationTaskPromptContextForSession.mockReturnValue(
        "active video task",
      );
      const hookRunner = {
        hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
        runBeforePromptBuild: vi.fn(async () => ({
          systemPrompt: "hook system",
          prependSystemContext: "hook prepend system",
        })),
        runBeforeAgentStart: vi.fn(),
      };
      mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);

      const context = await prepareCliRunContext({
        sessionId: "session-test",
        sessionKey: "agent:main:test",
        trigger: "user",
        sessionFile,
        workspaceDir: dir,
        prompt: "latest ask",
        provider: "test-cli",
        model: "test-model",
        timeoutMs: 1_000,
        runId: "run-test-prepend-helper",
        config: createCliBackendConfig(),
      });

      expect(context.systemPrompt).toBe("active video task\n\nhook prepend system\n\nhook system");
      expect(mockBuildActiveVideoGenerationTaskPromptContextForSession).toHaveBeenCalledWith(
        "agent:main:test",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips bundle MCP preparation when tools are disabled", async () => {
    const { dir, sessionFile } = createSessionFile();
    try {
      const getActiveMcpLoopbackRuntime = vi.fn(() => ({
        port: 31783,
        ownerToken: "owner-token",
        nonOwnerToken: "non-owner-token",
      }));
      const ensureMcpLoopbackServer = vi.fn(createTestMcpLoopbackServer);
      const createMcpLoopbackServerConfig = vi.fn(createTestMcpLoopbackServerConfig);
      setCliRunnerPrepareTestDeps({
        getActiveMcpLoopbackRuntime,
        ensureMcpLoopbackServer,
        createMcpLoopbackServerConfig,
      });

      const context = await prepareCliRunContext({
        sessionId: "session-test",
        sessionFile,
        workspaceDir: dir,
        prompt: "latest ask",
        provider: "test-cli",
        model: "test-model",
        timeoutMs: 1_000,
        runId: "run-test-disable-tools",
        config: createCliBackendConfig({ bundleMcp: true }),
        disableTools: true,
      });

      expect(getActiveMcpLoopbackRuntime).not.toHaveBeenCalled();
      expect(ensureMcpLoopbackServer).not.toHaveBeenCalled();
      expect(createMcpLoopbackServerConfig).not.toHaveBeenCalled();
      expect(context.preparedBackend.mcpConfigHash).toBeUndefined();
      expect(context.preparedBackend.env).toBeUndefined();
      expect(context.preparedBackend.backend.args).toEqual(["--print"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for native tool-capable CLI backends when tools are disabled", async () => {
    const { dir, sessionFile } = createSessionFile();
    try {
      const getActiveMcpLoopbackRuntime = vi.fn(() => ({
        port: 31783,
        ownerToken: "owner-token",
        nonOwnerToken: "non-owner-token",
      }));
      setCliRunnerPrepareTestDeps({
        getActiveMcpLoopbackRuntime,
      });
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [
          {
            id: "native-cli",
            pluginId: "native-plugin",
            bundleMcp: true,
            bundleMcpMode: "codex-config-overrides",
            nativeToolMode: "always-on",
            config: {
              command: "native-cli",
              args: ["exec", "--sandbox", "workspace-write"],
              resumeArgs: ["exec", "resume", "{sessionId}"],
              output: "jsonl",
              input: "arg",
              sessionMode: "existing",
            },
          },
        ],
      });

      await expect(
        prepareCliRunContext({
          sessionId: "session-test",
          sessionFile,
          workspaceDir: dir,
          prompt: "latest ask",
          provider: "native-cli",
          model: "test-model",
          timeoutMs: 1_000,
          runId: "run-test-disable-native-tools",
          config: createCliBackendConfig(),
          disableTools: true,
        }),
      ).rejects.toThrow(
        "CLI backend native-cli cannot run with tools disabled because it exposes native tools",
      );

      expect(getActiveMcpLoopbackRuntime).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops the claude-cli sessionId when the on-disk transcript is missing (#77011)", async () => {
    const { dir, sessionFile } = createSessionFile();
    try {
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [
          {
            id: "claude-cli",
            pluginId: "anthropic",
            bundleMcp: false,
            config: {
              command: "claude",
              args: ["--print"],
              resumeArgs: ["--resume", "{sessionId}"],
              output: "jsonl",
              input: "stdin",
              sessionMode: "existing",
            },
          },
        ],
      });
      const transcriptCheck = vi.fn(async () => false);
      setCliRunnerPrepareTestDeps({
        claudeCliSessionTranscriptHasContent: transcriptCheck,
      });

      const context = await prepareCliRunContext({
        sessionId: "session-test",
        sessionKey: "agent:main:telegram:direct:peer",
        sessionFile,
        workspaceDir: dir,
        prompt: "follow-up",
        provider: "claude-cli",
        model: "opus",
        timeoutMs: 1_000,
        runId: "run-77011-missing",
        cliSessionBinding: { sessionId: "stale-claude-sid" },
        cliSessionId: "stale-claude-sid",
        config: createCliBackendConfig({ systemPromptOverride: null }),
      });

      expect(transcriptCheck).toHaveBeenCalledWith({ sessionId: "stale-claude-sid" });
      expect(context.reusableCliSession).toEqual({ invalidatedReason: "missing-transcript" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the claude-cli sessionId when the on-disk transcript is present", async () => {
    const { dir, sessionFile } = createSessionFile();
    try {
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [
          {
            id: "claude-cli",
            pluginId: "anthropic",
            bundleMcp: false,
            config: {
              command: "claude",
              args: ["--print"],
              resumeArgs: ["--resume", "{sessionId}"],
              output: "jsonl",
              input: "stdin",
              sessionMode: "existing",
            },
          },
        ],
      });
      const transcriptCheck = vi.fn(async () => true);
      setCliRunnerPrepareTestDeps({
        claudeCliSessionTranscriptHasContent: transcriptCheck,
      });

      const context = await prepareCliRunContext({
        sessionId: "session-test",
        sessionKey: "agent:main:telegram:direct:peer",
        sessionFile,
        workspaceDir: dir,
        prompt: "follow-up",
        provider: "claude-cli",
        model: "opus",
        timeoutMs: 1_000,
        runId: "run-77011-present",
        cliSessionBinding: { sessionId: "live-claude-sid" },
        cliSessionId: "live-claude-sid",
        config: createCliBackendConfig({ systemPromptOverride: null }),
      });

      expect(transcriptCheck).toHaveBeenCalledWith({ sessionId: "live-claude-sid" });
      expect(context.reusableCliSession).toEqual({ sessionId: "live-claude-sid" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not probe the transcript for non-claude-cli providers", async () => {
    const { dir, sessionFile } = createSessionFile();
    try {
      const transcriptCheck = vi.fn(async () => false);
      setCliRunnerPrepareTestDeps({
        claudeCliSessionTranscriptHasContent: transcriptCheck,
      });

      const context = await prepareCliRunContext({
        sessionId: "session-test",
        sessionFile,
        workspaceDir: dir,
        prompt: "latest ask",
        provider: "test-cli",
        model: "test-model",
        timeoutMs: 1_000,
        runId: "run-77011-other-provider",
        cliSessionBinding: { sessionId: "test-cli-sid" },
        config: createCliBackendConfig({ systemPromptOverride: null }),
      });

      expect(transcriptCheck).not.toHaveBeenCalled();
      expect(context.reusableCliSession).toEqual({ sessionId: "test-cli-sid" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
