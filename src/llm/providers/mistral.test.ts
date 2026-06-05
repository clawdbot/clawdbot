// Mistral provider tests cover request mapping and stream conversion.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";

const mistralMockState = vi.hoisted(() => ({
  payloads: [] as unknown[],
}));

vi.mock("@mistralai/mistralai", () => ({
  Mistral: class MockMistral {
    chat = {
      stream: vi.fn(async (payload: unknown) => {
        mistralMockState.payloads.push(payload);
        throw new Error("stop before network");
      }),
    };
  },
}));

import { streamSimpleMistral } from "./mistral.js";

function makeMistralModel(): Model<"mistral-conversations"> {
  return {
    id: "mistral-large-latest",
    name: "Mistral Large",
    api: "mistral-conversations",
    provider: "mistral",
    baseUrl: "https://api.mistral.ai",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
} satisfies Context;

describe("Mistral provider", () => {
  beforeEach(() => {
    mistralMockState.payloads = [];
  });

  it("forwards simple stop sequences to Mistral stop", async () => {
    const stream = streamSimpleMistral(makeMistralModel(), context, {
      apiKey: "sk-mistral-provider",
      stop: ["STOP"],
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect((mistralMockState.payloads[0] as { stop?: unknown }).stop).toEqual(["STOP"]);
  });
});
