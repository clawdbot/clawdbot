// #85203: exercise production assembly so live media facts cannot rewrite history's prefix.
import {
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  splitSystemPromptCacheBoundary,
} from "@openclaw/ai/internal/shared";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createHookRunner } from "../../../plugins/hooks.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import * as mediaTaskStatus from "../../media-generation-task-status.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import {
  prepareEmbeddedAttemptPromptAssembly,
  prepareEmbeddedAttemptPromptContext,
} from "./attempt-prompt-build.js";
import { forgetPromptBuildDrainCacheForRun } from "./attempt-prompt-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

vi.mock("../../../plugins/host-hook-state.js", () => ({
  drainPluginNextTurnInjectionContext: vi.fn(async () => ({ queuedInjections: [] })),
}));

registerAgentSessionLoopTestLifecycle();

beforeEach(() => {
  vi.spyOn(
    mediaTaskStatus,
    "buildActiveImageGenerationTaskPromptContextForSession",
  ).mockReturnValue(undefined);
  vi.spyOn(
    mediaTaskStatus,
    "buildActiveVideoGenerationTaskPromptContextForSession",
  ).mockReturnValue(undefined);
  vi.spyOn(
    mediaTaskStatus,
    "buildActiveMusicGenerationTaskPromptContextForSession",
  ).mockReturnValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

const HOOK = "Static plugin guidance";
const BASE = `Stable workspace prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic channel guidance`;
const OVERRIDE = "Custom hook system prompt without a cache boundary";

async function createTurnFixture(systemPromptOverride?: string) {
  const { session, sessionManager, modelRegistry } = await createTestSession();
  const runId = `media-cache-${systemPromptOverride ? "override" : "base"}`;
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "media-cache-test");
  onTestFinished(() => {
    admission.close();
    forgetPromptBuildDrainCacheForRun(runId);
  });
  const attempt: EmbeddedRunAttemptParams = {
    admittedRunContext: await admission.admit("embedded"),
    authStorage: modelRegistry.authStorage,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry,
    config: {},
    model: testModel,
    modelId: testModel.id,
    provider: testModel.provider,
    thinkLevel: "off",
    prompt: "How is the image progressing?",
    transcriptPrompt: "How is the image progressing?",
    runId,
    sessionId: runId,
    sessionKey: `agent:main:${runId}`,
    sessionFile: "",
    sessionPersistence: "detached",
    trigger: "user",
    timeoutMs: 10_000,
    workspaceDir: "/tmp/media-cache-test",
  };
  const hookRunner = createHookRunner({
    hooks: [],
    plugins: [],
    typedHooks: [
      {
        pluginId: "cache-test",
        hookName: "before_prompt_build",
        source: "test",
        handler: async () => ({
          systemPrompt: systemPromptOverride,
          prependSystemContext: HOOK,
        }),
      },
    ],
  });
  return async (progress?: string) => {
    vi.mocked(
      mediaTaskStatus.buildActiveImageGenerationTaskPromptContextForSession,
    ).mockReturnValue(
      progress
        ? `- tool=image_generate; task=task-1; status=running; progress_json="${progress}"`
        : undefined,
    );
    let systemPromptText = BASE;
    const setActiveSessionSystemPrompt = (next: string) => {
      systemPromptText = next;
      session.agent.state.systemPrompt = next;
    };
    const prompt = await prepareEmbeddedAttemptPromptAssembly({
      attempt,
      activeSession: session,
      sessionManager,
      hookRunner,
      hookAgentId: "main",
      diagnosticTrace: { traceId: "11111111111111111111111111111111" },
      isRawModelRun: false,
      sessionAgentId: "main",
      runtimeModel: testModel.id,
      systemPromptText,
      applyPromptBuildToolsAllow: () => ["image_generate"],
      setActiveSessionSystemPrompt,
      setLeasedSteering: vi.fn(),
    });
    return prepareEmbeddedAttemptPromptContext({
      attempt,
      capabilityToolNames: new Set(["image_generate"]),
      messages: session.messages,
      prompt,
      replaceSessionMessages: (messages) => {
        session.agent.state.messages = messages;
      },
      includeBoundaryTimestamp: false,
      isRawModelRun: false,
      sessionAgentId: "main",
      setActiveSessionSystemPrompt,
      systemPromptText,
      toolResultPromptProjectionState: {
        replacements: new Map(),
        frozen: new Set(),
        ambiguousBaseKeys: new Set(),
        restoredCacheTtl: new Map(),
        sourceHashByKey: new Map(),
      },
    });
  };
}

describe("#85203 media facts preserve the complete assembled system prompt", () => {
  it.each([
    { scenario: "existing boundary", override: undefined },
    { scenario: "marker-free hook override", override: OVERRIDE },
  ])("keeps static hooks and model identity stable with $scenario", async ({ override }) => {
    const prepareTurn = await createTurnFixture(override);
    const rendering = await prepareTurn("Rendering image");
    const encoding = await prepareTurn("Encoding image");
    const idle = await prepareTurn();

    expect(encoding.systemPromptForHook).toBe(rendering.systemPromptForHook);
    expect(idle.systemPromptForHook).toBe(rendering.systemPromptForHook);
    expect(rendering.runtimeContextMessageForCurrentTurn?.content).toContain(
      'progress_json="Rendering image"',
    );
    expect(encoding.runtimeContextMessageForCurrentTurn?.content).toContain(
      'progress_json="Encoding image"',
    );
    expect(idle.runtimeContextMessageForCurrentTurn?.content).toContain(
      "tool=image_generate; none",
    );
    expect(rendering.systemPromptForHook).not.toContain("task=task-1");

    const split = splitSystemPromptCacheBoundary(idle.systemPromptForHook);
    expect(split).toBeDefined();
    expect(split?.stablePrefix).toContain(HOOK);
    expect(split?.stablePrefix).toContain(override ?? "Stable workspace prefix");
    expect(split?.stablePrefix).not.toContain("Current model identity:");
    expect(split?.dynamicSuffix).toContain("Current model identity:");
  });
});
