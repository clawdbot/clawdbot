import { describe, expect, it } from "vitest";

import { validateConfigObject } from "./config.js";

describe("web search provider config", () => {
  it("accepts perplexity provider and config", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "perplexity",
            perplexity: {
              apiKey: "test-key",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});
