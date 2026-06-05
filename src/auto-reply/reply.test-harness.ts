/** Shared reply test harness with mocked agent/runtime dependencies and temp HOME isolation. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, vi, type Mock } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { withFastReplyConfig } from "./reply/get-reply-fast-path.js";

type ReplyRuntimeMocks = {
  runEmbeddedAgent: Mock;
  loadModelCatalog: Mock;
  webAuthExists: Mock;
  getWebAuthAgeMs: Mock;
  readWebSelfId: Mock;
};

const replyRuntimeMockState = vi.hoisted(() => ({
  mocks: {
    runEmbeddedAgent: vi.fn(),
    loadModelCatalog: vi.fn(),
    webAuthExists: vi.fn().mockResolvedValue(true),
    getWebAuthAgeMs: vi.fn().mockReturnValue(120_000),
    readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
  } as ReplyRuntimeMocks,
}));

vi.mock("../agents/embedded-agent.js", () => ({
  abortEmbeddedAgentRun: vi.fn().mockReturnValue(false),
  runEmbeddedAgent: (...args: unknown[]) => replyRuntimeMockState.mocks.runEmbeddedAgent(...args),
  queueEmbeddedAgentMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedAgentRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedAgentRunStreaming: vi.fn().mockReturnValue(false),
}));

vi.mock("../agents/model-catalog.runtime.js", () => ({
  loadModelCatalog: (...args: unknown[]) => replyRuntimeMockState.mocks.loadModelCatalog(...args),
}));

vi.mock("../agents/auth-profiles/session-override.js", () => ({
  clearSessionAuthProfileOverride: vi.fn(),
  resolveSessionAuthProfileOverride: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../commands-registry.runtime.js", () => ({
  listChatCommands: () => [],
}));

vi.mock("../skills/discovery/chat-commands.runtime.js", () => ({
  listSkillCommandsForWorkspace: () => [],
}));

vi.mock("../plugins/runtime/runtime-web-channel-plugin.js", () => ({
  webAuthExists: (...args: unknown[]) => replyRuntimeMockState.mocks.webAuthExists(...args),
  getWebAuthAgeMs: (...args: unknown[]) => replyRuntimeMockState.mocks.getWebAuthAgeMs(...args),
  readWebSelfId: (...args: unknown[]) => replyRuntimeMockState.mocks.readWebSelfId(...args),
}));

vi.mock("../agents/embedded-agent.runtime.js", () => ({
  abortEmbeddedAgentRun: vi.fn().mockReturnValue(false),
  isEmbeddedAgentRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedAgentRunStreaming: vi.fn().mockReturnValue(false),
  resolveActiveEmbeddedRunSessionId: vi.fn().mockReturnValue(undefined),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  waitForEmbeddedAgentRunEnd: vi.fn(async () => undefined),
}));

vi.mock("./reply/agent-runner.runtime.js", () => ({
  runReplyAgent: async (params: {
    commandBody: string;
    followupRun: {
      prompt: string;
      run: {
        agentDir: string;
        agentId: string;
        config: unknown;
        execOverrides?: unknown;
        inputProvenance?: unknown;
        messageProvider?: string;
        model: string;
        ownerNumbers?: string[];
        provider: string;
        reasoningLevel?: unknown;
        senderIsOwner?: boolean;
        sessionFile: string;
        sessionId: string;
        sessionKey: string;
        skillsSnapshot?: unknown;
        thinkLevel?: unknown;
        timeoutMs?: number;
        verboseLevel?: unknown;
        workspaceDir: string;
        bashElevated?: unknown;
      };
    };
  }) => {
    const result = await replyRuntimeMockState.mocks.runEmbeddedAgent({
      prompt: params.followupRun.prompt || params.commandBody,
      agentDir: params.followupRun.run.agentDir,
      agentId: params.followupRun.run.agentId,
      config: params.followupRun.run.config,
      execOverrides: params.followupRun.run.execOverrides,
      inputProvenance: params.followupRun.run.inputProvenance,
      messageProvider: params.followupRun.run.messageProvider,
      model: params.followupRun.run.model,
      ownerNumbers: params.followupRun.run.ownerNumbers,
      provider: params.followupRun.run.provider,
      reasoningLevel: params.followupRun.run.reasoningLevel,
      senderIsOwner: params.followupRun.run.senderIsOwner,
      sessionFile: params.followupRun.run.sessionFile,
      sessionId: params.followupRun.run.sessionId,
      sessionKey: params.followupRun.run.sessionKey,
      skillsSnapshot: params.followupRun.run.skillsSnapshot,
      thinkLevel: params.followupRun.run.thinkLevel,
      timeoutMs: params.followupRun.run.timeoutMs,
      verboseLevel: params.followupRun.run.verboseLevel,
      workspaceDir: params.followupRun.run.workspaceDir,
      bashElevated: params.followupRun.run.bashElevated,
    });
    return result?.payloads?.[0];
  },
}));

/** Creates a per-test HOME fixture and restores environment variables after each case. */
export function createTempHomeHarness(options: { prefix: string; beforeEachCase?: () => void }) {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), options.prefix));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = path.join(fixtureRoot, `case-${++caseId}`);
    await fs.mkdir(path.join(home, ".openclaw", "agents", "main", "sessions"), { recursive: true });
    const env: Record<string, string | undefined> = {
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
      OPENCLAW_AGENT_DIR: path.join(home, ".openclaw", "agent"),
    };
    if (process.platform === "win32") {
      const match = home.match(/^([A-Za-z]:)(.*)$/);
      if (match) {
        env.HOMEDRIVE = match[1];
        env.HOMEPATH = match[2] || "\\";
      }
    }

    return await withEnvAsync(env, async () => {
      options.beforeEachCase?.();
      return await fn(home);
    });
  }

  return { withTempHome };
}

/** Builds a minimal reply config rooted in a temp HOME fixture. */
export function makeReplyConfig(home: string) {
  return withFastReplyConfig({
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-6",
        workspace: path.join(home, "openclaw"),
      },
    },
    channels: {
      whatsapp: {
        allowFrom: ["*"],
      },
    },
    session: { store: path.join(home, "sessions.json") },
  });
}

/** Creates fresh runtime mocks for reply tests. */
export function createReplyRuntimeMocks(): ReplyRuntimeMocks {
  return {
    runEmbeddedAgent: vi.fn(),
    loadModelCatalog: vi.fn(),
    webAuthExists: vi.fn().mockResolvedValue(true),
    getWebAuthAgeMs: vi.fn().mockReturnValue(120_000),
    readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
  };
}

/** Installs runtime mocks into the hoisted Vitest module state. */
export function installReplyRuntimeMocks(mocks: ReplyRuntimeMocks) {
  replyRuntimeMockState.mocks = mocks;
}

/** Resets mock call history and default model catalog responses. */
export function resetReplyRuntimeMocks(mocks: ReplyRuntimeMocks) {
  mocks.runEmbeddedAgent.mockClear();
  mocks.loadModelCatalog.mockClear();
  mocks.loadModelCatalog.mockResolvedValue([
    { id: "claude-opus-4-6", name: "Opus 4.5", provider: "anthropic" },
  ]);
}

/** Builds the minimal embedded-agent text result consumed by reply tests. */
export function makeEmbeddedTextResult(text: string) {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  };
}
