import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import {
  buildOpencodeGoLiveProviderConfig,
  buildStaticOpencodeGoProviderConfig,
  listOpencodeGoModelCatalogEntries,
} from "./provider-catalog.js";

const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
const OPENCODE_API_KEY =
  process.env.OPENCODE_API_KEY?.trim() || process.env.OPENCODE_ZEN_API_KEY?.trim() || "";
const LIVE = isLiveTestEnabled(["OPENCODE_GO_LIVE_TEST"]) && OPENCODE_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

type ModelsResponse = { data?: Array<{ id?: unknown; object?: unknown }> };

describeLive("OpenCode Go live dynamic catalog", () => {
  it("loads authorized current models from upstream metadata without expanding its offline seed", async () => {
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
    const offlineIds = new Set(
      buildStaticOpencodeGoProviderConfig().models.map((model) => model.id),
    );
    const live = await buildOpencodeGoLiveProviderConfig({
      apiKey: OPENCODE_API_KEY,
      discoveryApiKey: OPENCODE_API_KEY,
    });
    const discoveredIds = live.models.map((model) => model.id);
    const advertisedIds = new Set(liveIds);
    const trustedRows = listOpencodeGoModelCatalogEntries();

    expect(discoveredIds.length).toBeGreaterThan(0);
    expect(discoveredIds.every((id) => advertisedIds.has(id))).toBe(true);
    expect(new Set(discoveredIds).size).toBe(discoveredIds.length);
    expect(discoveredIds.some((id) => !offlineIds.has(id))).toBe(true);
    expect(discoveredIds).not.toContain("hy3-preview");
    expect(trustedRows.find((row) => row.id === "hy3-preview")?.status).toBe("preview");
    if (advertisedIds.has("ox-alpha-free")) {
      expect(live.models.find((model) => model.id === "ox-alpha-free")).toMatchObject({
        api: "openai-completions",
        baseUrl: "https://opencode.ai/zen/go/v1",
        contextWindow: 1_000_000,
        maxTokens: 131_072,
        input: ["text", "image"],
      });
    }
  }, 30_000);
});
