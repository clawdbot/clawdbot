import { describe, expect, it } from "vitest";
import { createXSearchTool } from "./x-search.js";

const liveEnabled =
  process.env.OPENCLAW_LIVE_TEST === "1" && (process.env.XAI_API_KEY ?? "").trim().length > 0;

const describeLive = liveEnabled ? describe : describe.skip;

describeLive("xai x_search live", () => {
  it("queries X through xAI Responses", async () => {
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                xSearch: {
                  enabled: true,
                  model: "grok-4-1-fast-non-reasoning",
                  maxTurns: 1,
                  timeoutSeconds: 60,
                },
              },
            },
          },
        },
      },
    });

    expect(tool).toBeTruthy();
    const result = await tool!.execute("x-search:live", {
      query: "OpenClaw from:steipete",
      to_date: "2026-03-28",
    });

    const details = (result.details ?? {}) as {
      provider?: string;
      content?: string;
      citations?: string[];
      inlineCitations?: unknown[];
      error?: string;
      message?: string;
    };

    expect(details.error, details.message).toBeUndefined();
    expect(details.provider).toBe("xai");
    expect(details.content?.trim().length ?? 0).toBeGreaterThan(0);

    const citationCount =
      (Array.isArray(details.citations) ? details.citations.length : 0) +
      (Array.isArray(details.inlineCitations) ? details.inlineCitations.length : 0);
    expect(citationCount).toBeGreaterThan(0);
  }, 75_000);
});
