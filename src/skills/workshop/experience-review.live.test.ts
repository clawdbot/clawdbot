import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../agents/live-test-helpers.js";
import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import { SessionManager } from "../../agents/sessions/index.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../agents/test-helpers/agent-message-fixtures.js";
import { createSessionEntryWithTranscript } from "../../config/sessions/session-accessor.js";
import type { Message } from "../../llm/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { runSkillExperienceReview, type ExperienceReviewCandidate } from "./experience-review.js";
import { listSkillProposals } from "./service.js";

const LIVE =
  isLiveTestEnabled(["OPENCLAW_LIVE_SKILL_EXPERIENCE_REVIEW"]) &&
  Boolean(process.env.OPENAI_API_KEY?.trim());
const describeLive = LIVE ? describe : describe.skip;
const modelId = process.env.OPENCLAW_LIVE_SKILL_EXPERIENCE_MODEL ?? "gpt-5.6-luna";
const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
let workspaceDir = "";

function assistantText(text: string) {
  return makeAgentAssistantMessage({ model: modelId, content: [{ type: "text", text }] });
}

function toolRound(
  id: string,
  name: string,
  args: Record<string, unknown>,
  text: string,
  isError = false,
): Message[] {
  return [
    makeAgentAssistantMessage({
      model: modelId,
      stopReason: "toolUse",
      content: [{ type: "toolCall", id, name, arguments: args }],
    }),
    {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text }],
      isError,
      timestamp: 0,
    },
  ];
}

beforeAll(async () => {
  // Full home isolation: the embedded review resolves the shared-main auth
  // store via HOME, and a real ~/.openclaw with pending doctor migration
  // must never leak into (or fail) this live run.
  testState = await createOpenClawTestState({
    layout: "home",
    prefix: "openclaw-live-skill-review-state-",
  });
  workspaceDir = await tempDirs.make("openclaw-live-skill-review-workspace-");
});

afterAll(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

async function candidate(
  runId: string,
  messages: Message[],
  options: { turnAborted?: boolean } = {},
): Promise<ExperienceReviewCandidate> {
  const sessionId = `live-skill-review-${runId}`;
  const sessionKey = `agent:main:${sessionId}`;
  const result: ExperienceReviewCandidate = {
    ctx: {
      agentId: "main",
      runId,
      sessionId,
      sessionKey,
      workspaceDir,
      modelProviderId: "openai",
      modelId,
      foregroundPromptContext: {
        agentId: "main",
        agentDir: workspaceDir,
        workspaceDir,
        cwd: workspaceDir,
        sandboxSessionKey: sessionKey,
        trigger: "user",
      },
    },
    config: {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            agentRuntime: { id: "openclaw" },
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: modelId,
                name: modelId,
                api: "openai-responses",
                agentRuntime: { id: "openclaw" },
                input: ["text"],
                reasoning: true,
                contextWindow: 1_047_576,
                maxTokens: 2_048,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      agents: {
        entries: { main: { default: true } },
        defaults: {
          model: { primary: `openai/${modelId}` },
          models: {
            [`openai/${modelId}`]: {
              agentRuntime: { id: "openclaw" },
              params: { maxTokens: 2_048 },
            },
          },
        },
      },
      skills: { workshop: { autonomous: { mode: "propose" } } },
      // Only the OpenAI provider plugin is needed. A cold unrestricted load
      // compiles all bundled extensions and runs provider discovery inside the
      // review lane, which can exceed the lane's no-progress watchdog.
      plugins: { allow: ["openai"] },
    },
    ...(options.turnAborted === undefined ? {} : { turnAborted: options.turnAborted }),
  };
  const target = await resolveAgentRunSessionTarget({
    agentId: "main",
    config: result.config,
    missingSessionKey: "create",
    sessionId,
    sessionKey,
  });
  const created = await createSessionEntryWithTranscript(
    target,
    () => ({ ok: true, entry: { sessionId, updatedAt: Date.now() } }),
    { cwd: workspaceDir },
  );
  if (!created.ok) {
    throw new Error(`Failed to create live review session: ${created.error}`);
  }
  for (const message of messages) {
    SessionManager.appendMessageToTranscript(target, message, { config: result.config });
  }
  return result;
}

describe("skill experience review transcript fixture", () => {
  it("persists messages through a canonical session", async () => {
    const runId = "transcript-fixture";
    const sessionId = `live-skill-review-${runId}`;
    const sessionKey = `agent:main:${sessionId}`;
    const message = makeAgentUserMessage({ content: "Review this completed task." });
    const seeded = await candidate(runId, [message]);
    const target = await resolveAgentRunSessionTarget({
      agentId: "main",
      config: seeded.config,
      missingSessionKey: "resolve-existing",
      sessionId,
      sessionKey,
    });

    expect(SessionManager.open(target, workspaceDir).buildSessionContext().messages).toEqual([
      message,
    ]);
  });
});

describeLive("skill experience review live OpenAI eval", () => {
  beforeAll(async () => {
    // Warm the plugin runtime outside the review lane: the first load compiles
    // extensions synchronously and can exceed the lane's no-progress watchdog
    // on a loaded machine.
    const { loadAgentRuntimePluginRegistryHandle } =
      await import("../../agents/runtime-plugins.js");
    const warmupCandidate = await candidate("warmup", []);
    loadAgentRuntimePluginRegistryHandle({
      config: warmupCandidate.config ?? {},
      workspaceDir,
    });
  }, 600_000);

  it("proposes a recovered preflight procedure but ignores routine one-off work", async () => {
    const positiveMessages: Message[] = [
      makeAgentUserMessage({
        content:
          "Deploy this repository from its checked-in manifest. Do not ask for values already present there.",
      }),
      ...toolRound("deploy-project", "deploy", {}, "project required", true),
      ...toolRound("deploy-region", "deploy", { project: "app" }, "region required", true),
      ...toolRound(
        "deploy-service",
        "deploy",
        { project: "app", region: "us" },
        "service required",
        true,
      ),
      assistantText("I am still guessing required fields one at a time."),
      ...toolRound(
        "read-manifest",
        "read",
        { path: "deploy.json" },
        "project=app region=us service=api health=/ready",
      ),
      assistantText("The manifest contains all required deployment inputs."),
      ...toolRound(
        "deploy-complete",
        "deploy",
        { project: "app", region: "us", service: "api" },
        "deployed",
      ),
      ...toolRound("fetch-health", "fetch", { path: "/ready" }, "200 ok"),
      assistantText("Deployment verified."),
      assistantText("Next time the manifest should be read before the first deploy call."),
      assistantText("That preflight would remove three failed tool rounds."),
      assistantText("Done."),
    ];

    const positiveCandidate = await candidate("live-positive", positiveMessages);
    await runSkillExperienceReview(positiveCandidate, {
      getCurrentConfig: () => positiveCandidate.config ?? {},
    });
    const afterPositive = await listSkillProposals({ workspaceDir });
    expect(afterPositive.proposals).toHaveLength(1);
    expect(afterPositive.proposals[0]).toMatchObject({ status: "pending" });

    const negativeMessages: Message[] = [
      makeAgentUserMessage({
        content:
          "One-time audit: check these ten unrelated opaque receipts. Policy requires one signed lookup per receipt; no batching or reuse is possible.",
      }),
      ...Array.from({ length: 10 }, (_, index) =>
        toolRound(`receipt-${index + 1}`, "signed_receipt_lookup", { id: index + 1 }, "valid"),
      ).flat(),
      assistantText("All ten one-time receipts are valid."),
    ];

    const negativeCandidate = await candidate("live-negative", negativeMessages);
    await runSkillExperienceReview(negativeCandidate, {
      getCurrentConfig: () => negativeCandidate.config ?? {},
    });
    const afterNegative = await listSkillProposals({ workspaceDir });
    expect(afterNegative.proposals).toEqual(afterPositive.proposals);

    const interruptedMessages: Message[] = [
      makeAgentUserMessage({
        content: "Publish the package. The registry keeps rejecting the token.",
      }),
      ...toolRound("publish-token", "publish", {}, "401 invalid token", true),
      ...toolRound("publish-retry", "publish", { retry: true }, "401 invalid token", true),
      assistantText("Retrying does not help; the stored scope must be wrong."),
      ...toolRound(
        "registry-whoami",
        "exec",
        { command: "registry whoami" },
        "authenticated to legacy-registry.example, expected registry.example",
      ),
      ...toolRound(
        "registry-login",
        "exec",
        { command: "registry login --host registry.example" },
        "login ok",
      ),
      ...toolRound("publish-complete", "publish", {}, "published 1.2.3"),
      assistantText("Publish verified. Moving on to the release notes."),
      makeAgentAssistantMessage({
        model: modelId,
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "read-changelog",
            name: "read",
            arguments: { path: "CHANGELOG.md" },
          },
        ],
      }),
    ];

    const interruptedCandidate = await candidate("live-interrupted", interruptedMessages, {
      turnAborted: true,
    });
    await runSkillExperienceReview(interruptedCandidate, {
      getCurrentConfig: () => interruptedCandidate.config ?? {},
    });
    const afterInterrupted = await listSkillProposals({ workspaceDir });
    expect(afterInterrupted.proposals.length).toBeGreaterThan(afterNegative.proposals.length);
  }, 300_000);
});
