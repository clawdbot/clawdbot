import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../agents/live-test-helpers.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { formatSkillExperienceReviewTranscript } from "./experience-review-prompt.js";
import { runSkillExperienceReview, type ExperienceReviewCandidate } from "./experience-review.js";
import { listSkillProposals } from "./service.js";

const LIVE =
  isLiveTestEnabled(["OPENCLAW_LIVE_SKILL_EXPERIENCE_REVIEW"]) &&
  Boolean(process.env.OPENAI_API_KEY?.trim());
const describeLive = LIVE ? describe : describe.skip;
const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
let workspaceDir = "";

function candidate(runId: string, messages: unknown[]): ExperienceReviewCandidate {
  const modelId = process.env.OPENCLAW_LIVE_SKILL_EXPERIENCE_MODEL ?? "gpt-5.6-luna";
  return {
    ctx: {
      agentId: "main",
      runId,
      sessionKey: "agent:main:live-skill-review",
      workspaceDir,
      modelProviderId: "openai",
      modelId,
      trigger: "user",
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
      skills: { workshop: { autonomous: { enabled: true } } },
    },
    transcript: formatSkillExperienceReviewTranscript(messages),
    modelIterations: 10,
  };
}

describeLive("skill experience review live OpenAI eval", () => {
  beforeAll(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-live-skill-review-state-",
    });
    workspaceDir = await tempDirs.make("openclaw-live-skill-review-workspace-");
  });

  afterAll(async () => {
    await testState.cleanup();
    await tempDirs.cleanup();
  });

  it("proposes a recovered preflight procedure but ignores routine one-off work", async () => {
    const positiveMessages = [
      {
        role: "user",
        content:
          "Deploy this repository from its checked-in manifest. Do not ask for values already present there.",
      },
      { role: "assistant", content: [{ type: "toolCall", name: "deploy", arguments: {} }] },
      { role: "toolResult", toolName: "deploy", isError: true, content: "project required" },
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "deploy", arguments: { project: "app" } }],
      },
      { role: "toolResult", toolName: "deploy", isError: true, content: "region required" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "deploy", arguments: { project: "app", region: "us" } },
        ],
      },
      { role: "toolResult", toolName: "deploy", isError: true, content: "service required" },
      { role: "assistant", content: "I am still guessing required fields one at a time." },
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: { path: "deploy.json" } }],
      },
      {
        role: "toolResult",
        toolName: "read",
        content: "project=app region=us service=api health=/ready",
      },
      { role: "assistant", content: "The manifest contains all required deployment inputs." },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "deploy",
            arguments: { project: "app", region: "us", service: "api" },
          },
        ],
      },
      { role: "toolResult", toolName: "deploy", content: "deployed" },
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "fetch", arguments: { path: "/ready" } }],
      },
      { role: "toolResult", toolName: "fetch", content: "200 ok" },
      { role: "assistant", content: "Deployment verified." },
      {
        role: "assistant",
        content: "Next time the manifest should be read before the first deploy call.",
      },
      { role: "assistant", content: "That preflight would remove three failed tool rounds." },
      { role: "assistant", content: "Done." },
    ];

    await runSkillExperienceReview(candidate("live-positive", positiveMessages));
    const afterPositive = await listSkillProposals({ workspaceDir });
    expect(afterPositive.proposals).toHaveLength(1);
    expect(afterPositive.proposals[0]).toMatchObject({ status: "pending" });

    const negativeMessages = [
      {
        role: "user",
        content:
          "One-time audit: check these ten unrelated opaque receipts. Policy requires one signed lookup per receipt; no batching or reuse is possible.",
      },
      ...Array.from({ length: 10 }, (_, index) => [
        {
          role: "assistant",
          content: [
            { type: "toolCall", name: "signed_receipt_lookup", arguments: { id: index + 1 } },
          ],
        },
        { role: "toolResult", toolName: "signed_receipt_lookup", content: "valid" },
      ]).flat(),
      { role: "assistant", content: "All ten one-time receipts are valid." },
    ];

    await runSkillExperienceReview(candidate("live-negative", negativeMessages));
    const afterNegative = await listSkillProposals({ workspaceDir });
    expect(afterNegative.proposals).toEqual(afterPositive.proposals);
  }, 180_000);
});
