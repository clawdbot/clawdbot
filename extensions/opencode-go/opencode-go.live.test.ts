import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import {
  buildStaticOpencodeGoProviderConfig,
  listOpencodeGoModelCatalogEntries,
} from "./provider-catalog.js";

const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
const OPENCODE_API_KEY =
  process.env.OPENCODE_API_KEY?.trim() || process.env.OPENCODE_ZEN_API_KEY?.trim() || "";
const LIVE = isLiveTestEnabled(["OPENCODE_GO_LIVE_TEST"]) && OPENCODE_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

type ModelsResponse = { data?: Array<{ id?: unknown; object?: unknown }> };

describeLive("OpenCode Go live catalog drift", () => {
  it("classifies every live id as active, deprecated, or preview", async () => {
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
    const trustedRows = listOpencodeGoModelCatalogEntries();
    const trustedIds = new Set(trustedRows.map((row) => row.id));
    const activeIds = buildStaticOpencodeGoProviderConfig().models.map((model) => model.id);

    expect(liveIds.filter((id) => !trustedIds.has(id))).toEqual([]);
    expect(new Set(activeIds).size).toBe(activeIds.length);
    expect(activeIds.toSorted()).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "glm-5.1",
      "glm-5.2",
      "gpt-5.6-luna",
      "grok-4.5",
      "hy3",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "kimi-k3",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "minimax-m2.7",
      "minimax-m3",
      "qwen3.6-plus",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.8-max",
    ]);
    expect(
      trustedRows
        .filter((row) => row.status === "deprecated")
        .map((row) => row.id)
        .toSorted(),
    ).toEqual([
      "glm-5",
      "kimi-k2.5",
      "mimo-v2-omni",
      "mimo-v2-pro",
      "minimax-m2.5",
      "qwen3.5-plus",
    ]);
    expect(trustedRows.find((row) => row.id === "hy3-preview")?.status).toBe("preview");
  }, 30_000);
});
