// Meta live tests prove muse-spark-1.1 auth and Responses API completion.
import { streamSimple, type Model } from "openclaw/plugin-sdk/llm";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import { buildMetaProvider } from "./provider-catalog.js";
import { wrapMetaProviderStream } from "./stream.js";

const MODEL_API_KEY = process.env.MODEL_API_KEY?.trim() ?? "";
const LIVE_MODEL_ID = "muse-spark-1.1";
const LIVE =
  isLiveTestEnabled(["META_LIVE_TEST", "MODEL_API_LIVE_TEST"]) && MODEL_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

function resolveLiveModel(): Model<"openai-responses"> {
  const provider = buildMetaProvider();
  const catalogModel = provider.models?.find((entry) => entry.id === LIVE_MODEL_ID);
  if (!catalogModel) {
    throw new Error(`Meta catalog does not include ${LIVE_MODEL_ID}`);
  }
  return {
    provider: "meta",
    baseUrl: provider.baseUrl,
    ...catalogModel,
    api: "openai-responses",
  } as Model<"openai-responses">;
}

function resolveLiveStreamFn() {
  const model = resolveLiveModel();
  return (
    wrapMetaProviderStream({
      provider: "meta",
      modelId: model.id,
      model,
      streamFn: streamSimple,
    }) ?? streamSimple
  );
}

describeLive("meta plugin live", () => {
  it("lists muse-spark-1.1 via the /models endpoint", async () => {
    const provider = buildMetaProvider();
    const response = await fetch(`${provider.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${MODEL_API_KEY}` },
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { data?: Array<{ id: string }> };
    const ids = (body.data ?? []).map((entry) => entry.id);
    expect(ids).toContain(LIVE_MODEL_ID);
  }, 30_000);

  it("completes a muse-spark-1.1 Responses API turn with high reasoning effort", async () => {
    const model = resolveLiveModel();
    let capturedPayload: Record<string, unknown> | undefined;
    const stream = await resolveLiveStreamFn()(
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
        maxTokens: 4000, // fix: high reasoning needs ~300 tokens
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
    expect(capturedPayload?.include).toEqual(
      expect.arrayContaining(["reasoning.encrypted_content"]),
    );
    const reasoning = capturedPayload?.reasoning as { effort?: string } | undefined;
    expect(reasoning?.effort).toBe("high");
    expect(extractNonEmptyAssistantText(result.content)).toMatch(/PATCH_OK/i);
  }, 120_000);
});
