/** Tests block streaming behavior for auto-reply output delivery. */
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { withFastReplyConfig } from "./reply/get-reply-fast-path.test-support.js";
import { loadGetReplyModuleForTest } from "./reply/get-reply.test-loader.js";
import { createModelSelectionStateFixture } from "./reply/model-selection.test-support.js";
import { createMockTypingController } from "./reply/reply.test-helpers.js";
import type { MsgContext } from "./templating.js";

const mocks = vi.hoisted(() => ({
  runPreparedReply: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/agent-scope.js")>(
    "../agents/agent-scope.js",
  );
  return {
    ...actual,
    resolveSessionAgentId: vi.fn(() => "main"),
    resolveAgentSkillsFilter: vi.fn(() => undefined),
  };
});
vi.mock("../agents/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/model-selection.js")>(
    "../agents/model-selection.js",
  );
  return {
    ...actual,
    resolveModelRefFromString: vi.fn(() => null),
  };
});
vi.mock("../agents/timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn(() => 60_000),
}));
vi.mock("../channels/model-overrides.js", () => ({
  resolveChannelModelOverride: vi.fn(() => undefined),
}));
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
}));
vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("./command-auth.js", () => ({
  resolveCommandAuthorization: vi.fn(() => ({ isAuthorizedSender: true })),
}));
vi.mock("./reply/directive-handling.defaults.js", () => ({
  resolveDefaultModel: vi.fn(() => ({
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
  })),
}));
vi.mock("./reply/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply/model-selection.js")>()),
  createModelSelectionState: vi.fn<
    typeof import("./reply/model-selection.js").createModelSelectionState
  >(async (params) => createModelSelectionStateFixture(params)),
}));
vi.mock("./reply/session-reset-model.runtime.js", () => ({
  applyResetModelOverride: vi.fn(async () => undefined),
}));
vi.mock("./reply/stage-sandbox-media.runtime.js", () => ({
  stageSandboxMedia: vi.fn(async () => undefined),
}));
vi.mock("./reply/typing.js", () => ({
  createTypingController: vi.fn(() => createMockTypingController()),
}));

vi.mock("./reply/get-reply-run.js", () => ({
  runPreparedReply: (...args: unknown[]) => mocks.runPreparedReply(...args),
}));

let getReplyFromConfig: typeof import("./reply/get-reply.js").getReplyFromConfig;
let resolveAgentWorkspaceDirMock: typeof import("../agents/agent-scope.js").resolveAgentWorkspaceDir;

async function loadFreshGetReplyModuleForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock } =
    await import("../agents/agent-scope.js"));
}

function createTelegramMessage(messageSid: string): MsgContext {
  return {
    Body: "ping",
    From: "+1004",
    To: "+2000",
    MessageSid: messageSid,
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
  };
}

function createReplyConfig(state: OpenClawTestState, streamMode?: "block"): OpenClawConfig {
  return withFastReplyConfig({
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        workspace: state.workspaceDir,
      },
    },
    channels: {
      telegram: {
        allowFrom: ["*"],
        ...(streamMode ? { streaming: { mode: streamMode } } : {}),
      },
    },
    session: { store: path.join(state.sessionsDir("main"), "sessions.json") },
  } satisfies OpenClawConfig);
}

describe("block streaming", () => {
  beforeAll(async () => {
    await loadFreshGetReplyModuleForTest();
  });

  beforeEach(() => {
    mocks.runPreparedReply.mockReset();
  });

  it("handles ordering, timeout fallback, and telegram streamMode block", async () => {
    await withOpenClawTestState(
      { label: "reply-block-streaming", env: { OPENCLAW_TEST_FAST: "1" } },
      async (state) => {
        const cfg = createReplyConfig(state);
        const streamModeCfg = createReplyConfig(state, "block");

        // Check both configs with pure resolvers before either reply can mkdir or probe SQLite.
        for (const config of [cfg, streamModeCfg]) {
          const storePath = expectDefined(config.session?.store, "block-streaming session store");
          const sqliteTarget = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
          expect(isPathInside(state.root, sqliteTarget.path)).toBe(true);
          expect(isPathInside(state.root, resolveAgentWorkspaceDirMock(config, "main"))).toBe(true);
        }

        const onReplyStart = vi.fn().mockResolvedValue(undefined);
        const onBlockReply = vi.fn().mockResolvedValue(undefined);

        mocks.runPreparedReply.mockImplementationOnce(async (params) => {
          await params.opts?.onReplyStart?.();
          await params.opts?.onBlockReply?.({ text: "first\n\nsecond" });
          return undefined;
        });

        const res = await getReplyFromConfig(
          createTelegramMessage("msg-123"),
          {
            onReplyStart,
            onBlockReply,
            disableBlockStreaming: false,
          },
          cfg,
        );

        expect(res).toBeUndefined();
        expect(mocks.runPreparedReply).toHaveBeenCalledTimes(1);
        expect(onReplyStart).toHaveBeenCalledTimes(1);
        expect(onBlockReply).toHaveBeenCalledWith({ text: "first\n\nsecond" });

        const onBlockReplyStreamMode = vi.fn().mockResolvedValue(undefined);
        mocks.runPreparedReply.mockImplementationOnce(async () => [{ text: "final" }]);

        const resStreamMode = await getReplyFromConfig(
          createTelegramMessage("msg-127"),
          {
            onBlockReply: onBlockReplyStreamMode,
          },
          streamModeCfg,
        );

        const streamPayload = Array.isArray(resStreamMode) ? resStreamMode[0] : resStreamMode;
        expect(streamPayload?.text).toBe("final");
        expect(onBlockReplyStreamMode).not.toHaveBeenCalled();
      },
    );
  });
});
