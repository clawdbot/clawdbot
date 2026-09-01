import { completeSimple, type Model } from "openclaw/plugin-sdk/llm";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import {
  buildOpencodeGoLiveProviderConfig,
  listOpencodeGoModelCatalogEntries,
} from "./provider-catalog.js";

const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
const OPENCODE_API_KEY =
  process.env.OPENCODE_API_KEY?.trim() || process.env.OPENCODE_ZEN_API_KEY?.trim() || "";
const LIVE = isLiveTestEnabled(["OPENCODE_GO_LIVE_TEST"]) && OPENCODE_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

type ModelsResponse = { data?: Array<{ id?: unknown; object?: unknown }> };

describeLive("OpenCode Go live dynamic catalog", () => {
  it("discovers the active advertised models with trusted upstream metadata", async () => {
    const response = await fetch(OPENCODE_GO_MODELS_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${OPENCODE_API_KEY}`,
        "accept-encoding": "identity",
      },
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as ModelsResponse;
    const liveIds = (body.data ?? [])
      .filter((row) => row.object === undefined || row.object === "model")
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim().toLowerCase())
      .toSorted();
    const live = await buildOpencodeGoLiveProviderConfig({
      apiKey: OPENCODE_API_KEY,
      discoveryApiKey: OPENCODE_API_KEY,
    });
    const discoveredIds = live.models.map((model) => model.id).toSorted();
    const trustedRows = listOpencodeGoModelCatalogEntries();
    const activeIds = new Set(
      trustedRows.filter((row) => !row.status).map((row) => row.id.toLowerCase()),
    );

    expect(discoveredIds.length).toBeGreaterThan(0);
    expect(new Set(discoveredIds).size).toBe(discoveredIds.length);
    expect(discoveredIds).toEqual([...new Set(liveIds)].filter((id) => activeIds.has(id)));
  }, 30_000);

  it("runs a discovered Go model with the account credential", async () => {
    const provider = await buildOpencodeGoLiveProviderConfig({ apiKey: OPENCODE_API_KEY });
    const row = provider.models.find((model) => model.id === "gpt-5.6-luna");
    if (!row || row.api !== "openai-responses" || !row.contextWindow) {
      throw new Error("OpenCode Go catalog lacks the GPT 5.6 Luna Responses route");
    }
    const input = row.input.filter((kind) => kind === "text" || kind === "image");
    expect(input).toEqual(row.input);
    const model: Model<"openai-responses"> = {
      ...row,
      api: row.api,
      contextWindow: row.contextWindow,
      provider: "opencode-go",
      baseUrl: row.baseUrl ?? provider.baseUrl,
      input,
    };
    const result = await completeSimple(
      model,
      { messages: [{ role: "user", content: "Reply with exactly: ok", timestamp: Date.now() }] },
      { apiKey: OPENCODE_API_KEY, maxTokens: 128 },
    );
    if (result.stopReason === "error") {
      throw new Error(result.errorMessage || "OpenCode Go inference returned an error");
    }
    expect(extractNonEmptyAssistantText(result.content)).toMatch(/^ok[.!]?$/i);
  }, 120_000);
});
