import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "../agents/auth-profiles.js";
import {
  formatUsageReportLines,
  formatUsageSummaryLine,
  loadProviderUsageSummary,
  type UsageSummary,
} from "./provider-usage.js";

describe("provider usage formatting", () => {
  it("returns null when no usage is available", () => {
    const summary: UsageSummary = { updatedAt: 0, providers: [] };
    expect(formatUsageSummaryLine(summary)).toBeNull();
  });

  it("picks the most-used window for summary line", () => {
    const summary: UsageSummary = {
      updatedAt: 0,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [
            { label: "5h", usedPercent: 10 },
            { label: "Week", usedPercent: 60 },
          ],
        },
      ],
    };
    const line = formatUsageSummaryLine(summary, { now: 0 });
    expect(line).toContain("Claude");
    expect(line).toContain("40% left");
    expect(line).toContain("(Week");
  });

  it("prints provider errors in report output", () => {
    const summary: UsageSummary = {
      updatedAt: 0,
      providers: [
        {
          provider: "openai-codex",
          displayName: "Codex",
          windows: [],
          error: "Token expired",
        },
      ],
    };
    const lines = formatUsageReportLines(summary);
    expect(lines.join("\n")).toContain("Codex: Token expired");
  });

  it("includes reset countdowns in report lines", () => {
    const now = Date.UTC(2026, 0, 7, 0, 0, 0);
    const summary: UsageSummary = {
      updatedAt: now,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [{ label: "5h", usedPercent: 20, resetAt: now + 60_000 }],
        },
      ],
    };
    const lines = formatUsageReportLines(summary, { now });
    expect(lines.join("\n")).toContain("resets 1m");
  });
});

describe("provider usage loading", () => {
  it("loads usage snapshots with injected auth", async () => {
    const makeResponse = (status: number, body: unknown): Response => {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      const headers = typeof body === "string" ? undefined : { "Content-Type": "application/json" };
      return new Response(payload, { status, headers });
    };

    const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.anthropic.com")) {
        return makeResponse(200, {
          five_hour: { utilization: 20, resets_at: "2026-01-07T01:00:00Z" },
        });
      }
      if (url.includes("api.z.ai")) {
        return makeResponse(200, {
          success: true,
          code: 200,
          data: {
            planName: "Pro",
            limits: [
              {
                type: "TOKENS_LIMIT",
                percentage: 25,
                unit: 3,
                number: 6,
                nextResetTime: "2026-01-07T06:00:00Z",
              },
            ],
          },
        });
      }
      if (url.includes("api.minimaxi.com/v1/api/openplatform/coding_plan/remains")) {
        return makeResponse(200, {
          base_resp: { status_code: 0, status_msg: "ok" },
          data: {
            total: 200,
            remain: 50,
            reset_at: "2026-01-07T05:00:00Z",
            plan_name: "Coding Plan",
          },
        });
      }
      return makeResponse(404, "not found");
    });

    const summary = await loadProviderUsageSummary({
      now: Date.UTC(2026, 0, 7, 0, 0, 0),
      auth: [
        { provider: "anthropic", token: "token-1" },
        { provider: "minimax", token: "token-1b" },
        { provider: "zai", token: "token-2" },
      ],
      fetch: mockFetch,
    });

    expect(summary.providers).toHaveLength(3);
    const claude = summary.providers.find((p) => p.provider === "anthropic");
    const minimax = summary.providers.find((p) => p.provider === "minimax");
    const zai = summary.providers.find((p) => p.provider === "zai");
    expect(claude?.windows[0]?.label).toBe("5h");
    expect(minimax?.windows[0]?.usedPercent).toBe(75);
    expect(zai?.plan).toBe("Pro");
    expect(mockFetch).toHaveBeenCalled();
  });

  it("handles nested MiniMax usage payloads", async () => {
    const makeResponse = (status: number, body: unknown): Response => {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      const headers = typeof body === "string" ? undefined : { "Content-Type": "application/json" };
      return new Response(payload, { status, headers });
    };

    const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.minimaxi.com/v1/api/openplatform/coding_plan/remains")) {
        return makeResponse(200, {
          base_resp: { status_code: 0, status_msg: "ok" },
          data: {
            plan_name: "Coding Plan",
            usage: {
              prompt_limit: 200,
              prompt_remain: 50,
              next_reset_time: "2026-01-07T05:00:00Z",
            },
          },
        });
      }
      return makeResponse(404, "not found");
    });

    const summary = await loadProviderUsageSummary({
      now: Date.UTC(2026, 0, 7, 0, 0, 0),
      auth: [{ provider: "minimax", token: "token-1b" }],
      fetch: mockFetch,
    });

    const minimax = summary.providers.find((p) => p.provider === "minimax");
    expect(minimax?.windows[0]?.usedPercent).toBe(75);
    expect(minimax?.plan).toBe("Coding Plan");
    expect(mockFetch).toHaveBeenCalled();
  });

  it("prefers MiniMax count-based usage when percent looks inverted", async () => {
    const makeResponse = (status: number, body: unknown): Response => {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      const headers = typeof body === "string" ? undefined : { "Content-Type": "application/json" };
      return new Response(payload, { status, headers });
    };

    const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.minimaxi.com/v1/api/openplatform/coding_plan/remains")) {
        return makeResponse(200, {
          base_resp: { status_code: 0, status_msg: "ok" },
          data: {
            prompt_limit: 200,
            prompt_remain: 150,
            usage_percent: 75,
            next_reset_time: "2026-01-07T05:00:00Z",
          },
        });
      }
      return makeResponse(404, "not found");
    });

    const summary = await loadProviderUsageSummary({
      now: Date.UTC(2026, 0, 7, 0, 0, 0),
      auth: [{ provider: "minimax", token: "token-1b" }],
      fetch: mockFetch,
    });

    const minimax = summary.providers.find((p) => p.provider === "minimax");
    expect(minimax?.windows[0]?.usedPercent).toBe(25);
    expect(mockFetch).toHaveBeenCalled();
  });

  it("handles MiniMax model_remains usage payloads", async () => {
    const makeResponse = (status: number, body: unknown): Response => {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      const headers = typeof body === "string" ? undefined : { "Content-Type": "application/json" };
      return new Response(payload, { status, headers });
    };

    const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.minimaxi.com/v1/api/openplatform/coding_plan/remains")) {
        return makeResponse(200, {
          base_resp: { status_code: 0, status_msg: "ok" },
          model_remains: [
            {
              start_time: 1736217600,
              end_time: 1736235600,
              remains_time: 600,
              current_interval_total_count: 120,
              current_interval_usage_count: 30,
              model_name: "MiniMax-M2.1",
            },
          ],
        });
      }
      return makeResponse(404, "not found");
    });

    const summary = await loadProviderUsageSummary({
      now: Date.UTC(2026, 0, 7, 0, 0, 0),
      auth: [{ provider: "minimax", token: "token-1b" }],
      fetch: mockFetch,
    });

    const minimax = summary.providers.find((p) => p.provider === "minimax");
    expect(minimax?.windows[0]?.usedPercent).toBe(25);
    expect(mockFetch).toHaveBeenCalled();
  });

  it("discovers Claude usage from token auth profiles", async () => {
    await withTempHome(
      async (tempHome) => {
        const agentDir = path.join(
          process.env.CLAWDBOT_STATE_DIR ?? path.join(tempHome, ".clawdbot"),
          "agents",
          "main",
          "agent",
        );
        fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          path.join(agentDir, "auth-profiles.json"),
          `${JSON.stringify(
            {
              version: 1,
              order: { anthropic: ["anthropic:default"] },
              profiles: {
                "anthropic:default": {
                  type: "token",
                  provider: "anthropic",
                  token: "token-1",
                  expires: Date.UTC(2100, 0, 1, 0, 0, 0),
                },
              },
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        const store = ensureAuthProfileStore(agentDir, {
          allowKeychainPrompt: false,
        });
        expect(listProfilesForProvider(store, "anthropic")).toContain("anthropic:default");

        const makeResponse = (status: number, body: unknown): Response => {
          const payload = typeof body === "string" ? body : JSON.stringify(body);
          const headers =
            typeof body === "string" ? undefined : { "Content-Type": "application/json" };
          return new Response(payload, { status, headers });
        };

        const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(
          async (input, init) => {
            const url =
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : input.url;
            if (url.includes("api.anthropic.com/api/oauth/usage")) {
              const headers = (init?.headers ?? {}) as Record<string, string>;
              expect(headers.Authorization).toBe("Bearer token-1");
              return makeResponse(200, {
                five_hour: {
                  utilization: 20,
                  resets_at: "2026-01-07T01:00:00Z",
                },
              });
            }
            return makeResponse(404, "not found");
          },
        );

        const summary = await loadProviderUsageSummary({
          now: Date.UTC(2026, 0, 7, 0, 0, 0),
          providers: ["anthropic"],
          agentDir,
          fetch: mockFetch,
        });

        expect(summary.providers).toHaveLength(1);
        const claude = summary.providers[0];
        expect(claude?.provider).toBe("anthropic");
        expect(claude?.windows[0]?.label).toBe("5h");
        expect(mockFetch).toHaveBeenCalled();
      },
      {
        env: {
          CLAWDBOT_STATE_DIR: (home) => path.join(home, ".clawdbot"),
        },
        prefix: "moltbot-provider-usage-",
      },
    );
  });

  it("falls back to claude.ai web usage when OAuth scope is missing", async () => {
    const cookieSnapshot = process.env.CLAUDE_AI_SESSION_KEY;
    process.env.CLAUDE_AI_SESSION_KEY = "sk-ant-web-1";
    try {
      const makeResponse = (status: number, body: unknown): Response => {
        const payload = typeof body === "string" ? body : JSON.stringify(body);
        const headers =
          typeof body === "string" ? undefined : { "Content-Type": "application/json" };
        return new Response(payload, { status, headers });
      };

      const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("api.anthropic.com/api/oauth/usage")) {
          return makeResponse(403, {
            type: "error",
            error: {
              type: "permission_error",
              message: "OAuth token does not meet scope requirement user:profile",
            },
          });
        }
        if (url.includes("claude.ai/api/organizations/org-1/usage")) {
          return makeResponse(200, {
            five_hour: { utilization: 20, resets_at: "2026-01-07T01:00:00Z" },
            seven_day: { utilization: 40, resets_at: "2026-01-08T01:00:00Z" },
            seven_day_opus: { utilization: 5 },
          });
        }
        if (url.includes("claude.ai/api/organizations")) {
          return makeResponse(200, [{ uuid: "org-1", name: "Test" }]);
        }
        return makeResponse(404, "not found");
      });

      const summary = await loadProviderUsageSummary({
        now: Date.UTC(2026, 0, 7, 0, 0, 0),
        auth: [{ provider: "anthropic", token: "sk-ant-oauth-1" }],
        fetch: mockFetch,
      });

      expect(summary.providers).toHaveLength(1);
      const claude = summary.providers[0];
      expect(claude?.provider).toBe("anthropic");
      expect(claude?.windows.some((w) => w.label === "5h")).toBe(true);
      expect(claude?.windows.some((w) => w.label === "Week")).toBe(true);
    } finally {
      if (cookieSnapshot === undefined) delete process.env.CLAUDE_AI_SESSION_KEY;
      else process.env.CLAUDE_AI_SESSION_KEY = cookieSnapshot;
    }
  });
});
