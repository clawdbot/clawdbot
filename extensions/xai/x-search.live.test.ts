import { isBillingErrorMessage } from "openclaw/plugin-sdk/test-env";
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

    if (!tool) {
      throw new Error("expected x_search tool to be registered");
    }
    let result: Awaited<ReturnType<typeof tool.execute>>;
    try {
      result = await tool.execute("x-search:live", {
        query: "OpenClaw from:steipete",
        to_date: "2026-03-28",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isBillingErrorMessage(message)) {
        console.warn(`[xai:x-search:live] skip: billing drift: ${message}`);
        return;
      }
      throw error;
    }

    const details = (result.details ?? {}) as {
      provider?: string;
      content?: string;
      citations?: string[];
      inlineCitations?: unknown[];
      error?: string;
      message?: string;
    };

    const errorMessage =
      details.error && details.message
        ? `${details.error} ${details.message}`
        : details.error || details.message || "";
    if (isBillingErrorMessage(errorMessage)) {
      console.warn(`[xai:x-search:live] skip: billing drift: ${errorMessage}`);
      return;
    }

    expect(details.error, details.message).toBeUndefined();
    expect(details.provider).toBe("xai");
    expect(details.content?.trim().length ?? 0).toBeGreaterThan(0);

    const citationCount =
      (Array.isArray(details.citations) ? details.citations.length : 0) +
      (Array.isArray(details.inlineCitations) ? details.inlineCitations.length : 0);
    expect(citationCount).toBeGreaterThan(0);
  }, 75_000);
});
