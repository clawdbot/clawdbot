import { describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchMinimaxUsage } from "./provider-usage.fetch.minimax.js";

async function expectMinimaxUsageResult(params: {
  payload: unknown;
  expected: {
    plan?: string;
    windows: Array<{ label: string; usedPercent: number; resetAt?: number }>;
  };
}) {
  const mockFetch = createProviderUsageFetch(async (_url, init) => {
    const headers = (init?.headers as Record<string, string> | undefined) ?? {};
    expect(headers.Authorization).toBe("Bearer key");
    expect(headers["MM-API-Source"]).toBe("OpenClaw");
    return makeResponse(200, params.payload);
  });

  const result = await fetchMinimaxUsage("key", 5000, mockFetch);
  expect(result.plan).toBe(params.expected.plan);
  expect(result.windows).toEqual(params.expected.windows);
}

describe("fetchMinimaxUsage", () => {
  it.each([
    {
      name: "uses the CN usage endpoint by default",
      baseUrl: undefined,
      expectedUrl: "https://api.minimaxi.com/v1/token_plan/remains",
    },
    {
      name: "derives the global usage endpoint from an Anthropic-compatible base URL",
      baseUrl: "https://api.minimax.io/anthropic",
      expectedUrl: "https://api.minimax.io/v1/token_plan/remains",
    },
    {
      name: "derives the usage endpoint from a configured origin",
      baseUrl: "https://api.minimaxi.com",
      expectedUrl: "https://api.minimaxi.com/v1/token_plan/remains",
    },
    {
      name: "falls back to CN when the configured base URL is malformed",
      baseUrl: "not a url",
      expectedUrl: "https://api.minimaxi.com/v1/token_plan/remains",
    },
  ])("$name", async ({ baseUrl, expectedUrl }) => {
    const mockFetch = createProviderUsageFetch(async (url) => {
      expect(url).toBe(expectedUrl);
      return makeResponse(200, {
        data: {
          current_interval_total_count: 100,
          current_interval_usage_count: 98,
        },
      });
    });

    const result = await fetchMinimaxUsage("key", 5000, mockFetch, { baseUrl });
    expect(result.windows).toEqual([{ label: "5h", usedPercent: 2, resetAt: undefined }]);
  });

  it.each([
    {
      name: "returns HTTP errors for failed requests",
      response: () => makeResponse(502, "bad gateway"),
      expectedError: "HTTP 502",
    },
    {
      name: "returns invalid JSON when payload cannot be parsed",
      response: () => makeResponse(200, "{not-json"),
      expectedError: "Invalid JSON",
    },
    {
      name: "returns trimmed API errors from base_resp",
      response: () =>
        makeResponse(200, {
          base_resp: {
            status_code: 1007,
            status_msg: "  auth denied  ",
          },
        }),
      expectedError: "auth denied",
    },
    {
      name: "falls back to a generic API error when base_resp message is blank",
      response: () =>
        makeResponse(200, {
          base_resp: {
            status_code: 1007,
            status_msg: "   ",
          },
        }),
      expectedError: "API error",
    },
  ])("$name", async ({ response, expectedError }) => {
    const mockFetch = createProviderUsageFetch(async () => response());
    const result = await fetchMinimaxUsage("key", 5000, mockFetch);
    expect(result.error).toBe(expectedError);
    expect(result.windows).toHaveLength(0);
  });

  it.each([
    {
      name: "derives usage from used/total fields and includes reset + plan",
      payload: {
        data: {
          used: 35,
          total: 100,
          window_hours: 3,
          reset_at: 1_700_000_000,
          plan_name: "Pro Max",
        },
      },
      expected: {
        plan: "Pro Max",
        windows: [{ label: "3h", usedPercent: 35, resetAt: 1_700_000_000_000 }],
      },
    },
    {
      name: "supports usage ratio strings with minute windows and ISO reset strings",
      payload: {
        data: {
          nested: [
            {
              usage_ratio: "0.25",
              window_minutes: "30",
              reset_time: "2026-01-08T00:00:00Z",
              plan: "Starter",
            },
          ],
        },
      },
      expected: {
        plan: "Starter",
        windows: [
          { label: "30m", usedPercent: 25, resetAt: new Date("2026-01-08T00:00:00Z").getTime() },
        ],
      },
    },
    {
      name: "derives used from total and remaining counts",
      payload: {
        data: {
          total: "200",
          remaining: "50",
          usage_percent: 75,
          reset_at: 1_700_000_000_000,
          plan_name: "Team",
        },
      },
      expected: {
        plan: "Team",
        windows: [{ label: "5h", usedPercent: 75, resetAt: 1_700_000_000_000 }],
      },
    },
    {
      name: "treats MiniMax current_interval_usage_count as remaining quota (not consumed)",
      payload: {
        data: {
          current_interval_total_count: 100,
          current_interval_usage_count: 98,
          plan_name: "Coding Plan",
        },
      },
      expected: {
        plan: "Coding Plan",
        windows: [{ label: "5h", usedPercent: 2, resetAt: undefined }],
      },
    },
    {
      name: "inverts usage_percent when no count fields are present (remaining to used)",
      payload: {
        data: {
          usage_percent: 98,
          plan_name: "Coding Plan",
        },
      },
      expected: {
        plan: "Coding Plan",
        windows: [{ label: "5h", usedPercent: 2, resetAt: undefined }],
      },
    },
    {
      name: "falls back to payload-level reset and plan when nested usage records omit them",
      payload: {
        data: {
          plan_name: "Payload Plan",
          reset_at: 1_700_000_100,
          nested: [{ usage_ratio: 0.4, window_hours: 2 }],
        },
      },
      expected: {
        plan: "Payload Plan",
        windows: [{ label: "2h", usedPercent: 40, resetAt: 1_700_000_100_000 }],
      },
    },
    {
      name: "prefers chat model entries from model_remains and derives window labels from timestamps",
      payload: {
        data: {
          model_remains: [
            {
              model_name: "speech-hd",
              current_interval_total_count: 0,
              current_interval_usage_count: 0,
              start_time: 1_774_180_800_000,
              end_time: 1_774_195_200_000,
            },
            {
              model_name: "MiniMax-M*",
              current_interval_total_count: 600,
              current_interval_usage_count: 595,
              start_time: 1_774_180_800_000,
              end_time: 1_774_195_200_000,
            },
            {
              model_name: "image-01",
              current_interval_total_count: 0,
              current_interval_usage_count: 0,
              start_time: 1_774_180_800_000,
              end_time: 1_774_195_200_000,
            },
          ],
        },
      },
      expected: {
        plan: "Coding Plan · MiniMax-M*",
        windows: [{ label: "4h", usedPercent: 0.8333333333333334, resetAt: 1_774_195_200_000 }],
      },
    },
    {
      name: "falls back to the first non-zero model_remains record when no MiniMax chat entry exists",
      payload: {
        data: {
          model_remains: [
            {
              model_name: "speech-hd",
              current_interval_total_count: 0,
              current_interval_usage_count: 0,
            },
            {
              model_name: "video-01",
              current_interval_total_count: 200,
              current_interval_usage_count: 150,
              start_time: 1_774_180_800_000,
              end_time: 1_774_195_200_000,
            },
          ],
        },
      },
      expected: {
        plan: "Coding Plan · video-01",
        windows: [{ label: "4h", usedPercent: 25, resetAt: 1_774_195_200_000 }],
      },
    },
  ])("$name", async ({ payload, expected }) => {
    await expectMinimaxUsageResult({ payload, expected });
  });

  it("returns unsupported response shape when no usage fields are present", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, { data: { foo: "bar" } }),
    );
    const result = await fetchMinimaxUsage("key", 5000, mockFetch);

    expect(result.error).toBe("Unsupported response shape");
    expect(result.windows).toHaveLength(0);
  });

  it("handles repeated nested records while scanning usage candidates", async () => {
    const sharedUsage = {
      total: 100,
      used: 20,
      usage_percent: 90,
      window_hours: 1,
    };
    const dataWithSharedReference = {
      first: sharedUsage,
      nested: [sharedUsage],
    };
    const mockFetch = createProviderUsageFetch(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ data: dataWithSharedReference }),
        }) as Response,
    );

    const result = await fetchMinimaxUsage("key", 5000, mockFetch);
    expect(result.windows).toEqual([{ label: "1h", usedPercent: 20, resetAt: undefined }]);
  });
});
