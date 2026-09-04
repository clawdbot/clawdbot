// Meta live tests prove muse-spark auth and Responses API completion.
import { createHash } from "node:crypto";
import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import { buildMetaProvider } from "./provider-catalog.js";
import { wrapMetaProviderStream } from "./stream.js";

const MODEL_API_KEY = process.env.MODEL_API_KEY?.trim() ?? "";
const STANDARD_LIVE_MODEL_IDS = ["muse-spark-1.3", "muse-spark-1.2", "muse-spark-1.1"] as const;
const STANDARD_CAP_LIVE_MODEL_IDS = ["muse-spark-1.3", "muse-spark-1.2"] as const;
const CONTRIBUTOR_LIVE_MODEL_IDS = [
  "muse-spark-1.3-contributor",
  "muse-spark-1.2-contributor",
] as const;
// Validated 96x96 PNG: white background with a 20x72 green vertical center bar.
const GREEN_VERTICAL_CENTER_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAMAAADVRocKAAAABlBMVEUAsUD///8TauZEAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAQklEQVRo3u3ZMQEAAAjDsOHfNAY44SI1EAFNHRcAAABYAzIEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHwHymoEAACXNba4HmGuMYsrAAAAAElFTkSuQmCC";
const GREEN_VERTICAL_CENTER_DATA_URL = `data:image/png;base64,${GREEN_VERTICAL_CENTER_PNG_BASE64}`;
// This bounds the live request; it is not an advertised model limit.
const LIVE_TEST_MAX_OUTPUT_TOKENS = 4_000;
const LIVE =
  isLiveTestEnabled(["META_LIVE_TEST", "MODEL_API_LIVE_TEST"]) && MODEL_API_KEY.length > 0;
// Contributor prompts and completions may train future Meta models, so sending live
// test content requires deliberate opt-in even though the fixture is synthetic.
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

function containsExpectedImagePayload(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsExpectedImagePayload);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "input_image" && record.image_url === GREEN_VERTICAL_CENTER_DATA_URL) {
    return true;
  }
  return Object.values(record).some(containsExpectedImagePayload);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function expectLiveCompletion(params: {
  modelId: string;
  context: Context;
  expectedText: string | RegExp;
  expectImagePayload?: boolean;
  useZeroMaxTokens?: boolean;
  emitRedactedCapProof?: boolean;
  emitRedactedImageProof?: boolean;
}): Promise<void> {
  const {
    modelId,
    context,
    expectedText,
    expectImagePayload = false,
    useZeroMaxTokens = false,
    emitRedactedCapProof = false,
    emitRedactedImageProof = false,
  } = params;
  const model = resolveLiveModel(modelId);
  let capturedPayload: Record<string, unknown> | undefined;
  let responseStatus: number | undefined;
  const stream = await resolveLiveStreamFn(modelId)(model, context, {
    apiKey: MODEL_API_KEY,
    maxTokens: useZeroMaxTokens ? 0 : LIVE_TEST_MAX_OUTPUT_TOKENS,
    reasoning: "high",
    onPayload: (payload) => {
      capturedPayload = payload as Record<string, unknown>;
    },
    onResponse: (response) => {
      responseStatus = response.status;
    },
  });
  const result = await stream.result();

  if (result.stopReason === "error") {
    throw new Error(result.errorMessage || "Meta returned an error");
  }

  expect(capturedPayload?.store).toBe(false);
  expect(capturedPayload?.include).toEqual(expect.arrayContaining(["reasoning.encrypted_content"]));
  const reasoning = capturedPayload?.reasoning as { effort?: string } | undefined;
  expect(reasoning?.effort).toBe("high");
  if (expectImagePayload) {
    expect(containsExpectedImagePayload(capturedPayload)).toBe(true);
  }
  const assistantText = extractNonEmptyAssistantText(result.content).trim();
  if (typeof expectedText === "string") {
    expect(assistantText).toBe(expectedText);
  } else {
    expect(assistantText).toMatch(expectedText);
  }
  if (useZeroMaxTokens) {
    expect(model.maxTokens).toBe(131072);
    expect(capturedPayload?.max_output_tokens).toBe(model.maxTokens);
    expect(responseStatus).toBe(200);
    expect(result.stopReason).toBe("stop");
  }
  if (emitRedactedCapProof) {
    console.info(
      `[meta:catalog-cap:live] ${JSON.stringify({
        model: modelId,
        callerMaxTokens: 0,
        requestedMaxOutputTokens: model.maxTokens,
        observedMaxOutputTokens: capturedPayload?.max_output_tokens,
        httpStatus: responseStatus,
        completion: "completed",
        semanticMatch: true,
        requestPayloadSha256: sha256(JSON.stringify(capturedPayload)),
        responseTextSha256: sha256(assistantText),
        claimScope: "request cap and short semantic completion only",
      })}`,
    );
  }
  if (emitRedactedImageProof) {
    expect(responseStatus).toBe(200);
    expect(result.stopReason).toBe("stop");
    console.info(
      `[meta:image:live] ${JSON.stringify({
        model: modelId,
        imageFixtureSha256: sha256(Buffer.from(GREEN_VERTICAL_CENTER_PNG_BASE64, "base64")),
        requestPayloadSha256: sha256(JSON.stringify(capturedPayload)),
        httpStatus: responseStatus,
        completion: "completed",
        semanticMatch: true,
        responseTextSha256: sha256(assistantText),
        claimScope: "image request encoding and short semantic completion only",
      })}`,
    );
  }
}

async function expectLiveTextCompletion(modelId: string): Promise<void> {
  await expectLiveCompletion({
    modelId,
    context: {
      messages: [
        {
          role: "user",
          content: "Reply with exactly: PATCH_OK",
          timestamp: Date.now(),
        },
      ],
    },
    expectedText: /PATCH_OK/i,
  });
}

async function expectLiveCatalogCapCompletion(modelId: string): Promise<void> {
  await expectLiveCompletion({
    modelId,
    context: {
      messages: [
        {
          role: "user",
          content: "Reply with exactly: CATALOG_CAP_OK",
          timestamp: Date.now(),
        },
      ],
    },
    expectedText: /CATALOG_CAP_OK/i,
    useZeroMaxTokens: true,
    emitRedactedCapProof: true,
  });
}

async function expectLiveImageCompletion(modelId: string): Promise<void> {
  await expectLiveCompletion({
    modelId,
    context: {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Inspect the image and identify the colored bar's basic color. Reply only with COLOR=<COLOR> in uppercase.",
            },
            {
              type: "image",
              data: GREEN_VERTICAL_CENTER_PNG_BASE64,
              mimeType: "image/png",
            },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    expectedText: "COLOR=GREEN",
    expectImagePayload: true,
    emitRedactedImageProof: true,
  });
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
      await expectLiveTextCompletion(modelId);
    },
    120_000,
  );

  it.each(STANDARD_CAP_LIVE_MODEL_IDS)(
    "uses the 131072 catalog output cap for %s when maxTokens is zero",
    async (modelId) => {
      await expectLiveCatalogCapCompletion(modelId);
    },
    120_000,
  );

  it.each(STANDARD_LIVE_MODEL_IDS)(
    "accepts image input for %s",
    async (modelId) => {
      await expectLiveImageCompletion(modelId);
    },
    120_000,
  );
});

describeContributorLive("meta contributor plugin live", () => {
  it("lists the contributor models via the /models endpoint", async () => {
    const ids = await fetchLiveModelIds();
    for (const modelId of CONTRIBUTOR_LIVE_MODEL_IDS) {
      expect(ids).toContain(modelId);
    }
  }, 30_000);

  it.each(CONTRIBUTOR_LIVE_MODEL_IDS)(
    "completes a %s Responses API turn with high reasoning effort",
    async (modelId) => {
      await expectLiveTextCompletion(modelId);
    },
    120_000,
  );

  it.each(CONTRIBUTOR_LIVE_MODEL_IDS)(
    "uses the 131072 catalog output cap for %s when maxTokens is zero",
    async (modelId) => {
      await expectLiveCatalogCapCompletion(modelId);
    },
    120_000,
  );

  it.each(CONTRIBUTOR_LIVE_MODEL_IDS)(
    "accepts image input for %s",
    async (modelId) => {
      await expectLiveImageCompletion(modelId);
    },
    120_000,
  );
});
