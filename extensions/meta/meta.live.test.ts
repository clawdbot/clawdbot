// Meta live tests prove muse-spark auth and Responses API completion.
import { streamSimple, type Model } from "openclaw/plugin-sdk/llm";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import { buildMetaProvider } from "./provider-catalog.js";
import { wrapMetaProviderStream } from "./stream.js";

const MODEL_API_KEY = process.env.MODEL_API_KEY?.trim() ?? "";
const STANDARD_LIVE_MODEL_IDS = ["muse-spark-1.1", "muse-spark-1.2"] as const;
const CONTRIBUTOR_LIVE_MODEL_ID = "muse-spark-1.2-contributor";
// This bounds the live request; it is not an advertised model limit.
const LIVE_TEST_MAX_OUTPUT_TOKENS = 4_000;
const LIVE =
  isLiveTestEnabled(["META_LIVE_TEST", "MODEL_API_LIVE_TEST"]) && MODEL_API_KEY.length > 0;
const CONTRIBUTOR_LIVE = LIVE && process.env.OPENCLAW_LIVE_META_CONTRIBUTOR === "1";
const describeLive = LIVE ? describe : describe.skip;
const describeContributorLive = CONTRIBUTOR_LIVE ? describe : describe.skip;

function resolveLiveModel(modelId: string): Model<"openai-responses"> {
  const provider = buildMetaProvider();
  const catalogModel = provider.models?.find((entry) => entry.id === modelId);
  if (!catalogModel) {
    throw new Error(`Meta catalog does not include ${modelId}`);
  }
  return {
    provider: "meta",
    baseUrl: provider.baseUrl,
    ...catalogModel,
    api: "openai-responses",
  } as Model<"openai-responses">;
}

function resolveLiveStreamFn(modelId: string) {
  const model = resolveLiveModel(modelId);
  return (
    wrapMetaProviderStream({
      provider: "meta",
      modelId: model.id,
      model,
      streamFn: streamSimple,
    }) ?? streamSimple
  );
}

async function fetchLiveModelIds(): Promise<string[]> {
  const provider = buildMetaProvider();
  const response = await fetch(`${provider.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${MODEL_API_KEY}` },
  });
  expect(response.ok).toBe(true);
  const body = (await response.json()) as { data?: Array<{ id: string }> };
  return (body.data ?? []).map((entry) => entry.id);
}

async function expectLiveCompletion(modelId: string): Promise<void> {
  const model = resolveLiveModel(modelId);
  let capturedPayload: Record<string, unknown> | undefined;
  const stream = await resolveLiveStreamFn(modelId)(
    model,
    {
      messages: [
        {
          role: "user",
          content: "Reply with exactly: PATCH_OK",
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: MODEL_API_KEY,
      maxTokens: LIVE_TEST_MAX_OUTPUT_TOKENS,
      reasoning: "high",
      onPayload: (payload) => {
        capturedPayload = payload as Record<string, unknown>;
      },
    },
  );
  const result = await stream.result();

  if (result.stopReason === "error") {
    throw new Error(result.errorMessage || "Meta returned an error");
  }

  expect(capturedPayload?.store).toBe(false);
  expect(capturedPayload?.include).toEqual(expect.arrayContaining(["reasoning.encrypted_content"]));
  const reasoning = capturedPayload?.reasoning as { effort?: string } | undefined;
  expect(reasoning?.effort).toBe("high");
  expect(extractNonEmptyAssistantText(result.content)).toMatch(/PATCH_OK/i);
}

describeLive("meta plugin live", () => {
  it("lists the standard catalog models via the /models endpoint", async () => {
    const ids = await fetchLiveModelIds();
    for (const modelId of STANDARD_LIVE_MODEL_IDS) {
      expect(ids).toContain(modelId);
    }
  }, 30_000);

  it.each(STANDARD_LIVE_MODEL_IDS)(
    "completes a %s Responses API turn with high reasoning effort",
    async (modelId) => {
      await expectLiveCompletion(modelId);
    },
    120_000,
  );
});

describeContributorLive("meta contributor plugin live", () => {
  it("lists the contributor model via the /models endpoint", async () => {
    const ids = await fetchLiveModelIds();
    expect(ids).toContain(CONTRIBUTOR_LIVE_MODEL_ID);
  }, 30_000);

  it("completes a contributor Responses API turn with high reasoning effort", async () => {
    await expectLiveCompletion(CONTRIBUTOR_LIVE_MODEL_ID);
  }, 120_000);
});
