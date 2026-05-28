import { describe, expect, it } from "vitest";
import { testing as promptProbeTesting } from "../../scripts/anthropic-prompt-probe.ts";
import { testing as claudeUsageTesting } from "../../scripts/debug-claude-usage.ts";
import { testing as discordSmokeTesting } from "../../scripts/dev/discord-acp-plain-language-smoke.ts";
import { testing as realtimeSmokeTesting } from "../../scripts/dev/realtime-talk-live-smoke.ts";
import {
  maskIdentifier,
  parseBooleanEnv,
  parseStrictIntegerOption,
  previewForDevToolLog,
  redactHomePath,
  redactJsonValueForDevToolLog,
} from "../../scripts/lib/dev-tooling-safety.ts";

describe("dev tooling safety helpers", () => {
  it("redacts secrets before truncating script log previews", () => {
    const token = "sk-test1234567890abcdefghijklmnop"; // pragma: allowlist secret
    const preview = previewForDevToolLog(`prefix OPENAI_API_KEY=${token} suffix`, 80);

    expect(preview).not.toContain(token);
    expect(preview).toContain("OPENAI_API_KEY=");
  });

  it("recursively redacts JSON-ish detail values before printing smoke results", () => {
    const token = "sk-test1234567890abcdefghijklmnop"; // pragma: allowlist secret
    const redacted = redactJsonValueForDevToolLog({
      nested: [{ message: `Authorization: Bearer ${token}` }],
    }) as { nested: Array<{ message: string }> };

    expect(redacted.nested[0].message).not.toContain(token);
    expect(redacted.nested[0].message).toContain("Authorization");
  });

  it("parses boolean env values explicitly", () => {
    expect(parseBooleanEnv({ fallback: false, name: "FLAG", raw: "yes" })).toBe(true);
    expect(parseBooleanEnv({ fallback: true, name: "FLAG", raw: "0" })).toBe(false);
    expect(() => parseBooleanEnv({ fallback: false, name: "FLAG", raw: "maybe" })).toThrow(
      /FLAG must be one of/u,
    );
  });

  it("rejects partial numeric option parses", () => {
    expect(parseStrictIntegerOption({ fallback: 3, label: "--runs", min: 1, raw: undefined })).toBe(
      3,
    );
    expect(() =>
      parseStrictIntegerOption({ fallback: 3, label: "--runs", min: 1, raw: "2abc" }),
    ).toThrow(/--runs must be an integer/u);
  });

  it("redacts home paths and masks opaque ids", () => {
    expect(redactHomePath("/home/alice/.openclaw/state.json", "/home/alice")).toBe(
      "~/.openclaw/state.json",
    );
    expect(maskIdentifier("session-key-abcdef123456")).toBe("sessio...3456");
  });
});

describe("script-specific dev tooling hardening", () => {
  it("rejects unknown Discord smoke drivers instead of silently using token mode", () => {
    expect(discordSmokeTesting.parseDriverMode("webhook")).toBe("webhook");
    expect(() => discordSmokeTesting.parseDriverMode("curl")).toThrow(/Invalid --driver/u);
  });

  it("redacts Discord webhook tokens from API paths", () => {
    const token = "webhook-secret-token-abcdef123456"; // pragma: allowlist secret
    const path = `/webhooks/123/${token}?wait=true`;

    expect(discordSmokeTesting.redactDiscordApiPath(path)).not.toContain(token);
    expect(discordSmokeTesting.redactDiscordApiPath(path)).toContain("/webhooks/123/");
  });

  it("computes the remaining Discord smoke timeout budget", () => {
    expect(discordSmokeTesting.remainingTimeoutMs(1_500, 1_000)).toBe(500);
    expect(() => discordSmokeTesting.remainingTimeoutMs(1_000, 1_000)).toThrow(
      /exceeded total timeout/u,
    );
  });

  it("aborts stalled Discord smoke fetches at the request timeout", async () => {
    let signal: AbortSignal | undefined;
    const request = discordSmokeTesting.requestDiscordJson({
      method: "GET",
      path: "/users/@me",
      headers: {},
      retries: 0,
      timeoutMs: 5,
      errorPrefix: "Discord API",
      fetchImpl: ((_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => {});
      }) as typeof fetch,
    });

    await expect(request).rejects.toThrow(/Discord API GET \/users\/@me exceeded timeout/u);
    expect(signal?.aborted).toBe(true);
  });

  it("times out stalled Discord smoke response body reads", async () => {
    const response = {
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => new Promise(() => {}),
    } as Response;
    const request = discordSmokeTesting.requestDiscordJson({
      method: "GET",
      path: "/channels/123/messages",
      headers: {},
      retries: 0,
      timeoutMs: 5,
      errorPrefix: "Discord API",
      fetchImpl: (() => Promise.resolve(response)) as typeof fetch,
    });

    await expect(request).rejects.toThrow(
      /Discord API GET \/channels\/123\/messages exceeded timeout/u,
    );
  });

  it("does not launch another Discord smoke retry after the timeout budget expires", async () => {
    let calls = 0;
    const response = {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      json: async () => ({ retry_after: 1 }),
    } as Response;

    await expect(
      discordSmokeTesting.requestDiscordJson({
        method: "GET",
        path: "/channels/123/messages",
        headers: {},
        retries: 1,
        timeoutMs: 5,
        errorPrefix: "Discord API",
        fetchImpl: (() => {
          calls += 1;
          return Promise.resolve(response);
        }) as typeof fetch,
      }),
    ).rejects.toThrow(/exceeded total timeout/u);
    expect(calls).toBe(1);
  });

  it("aborts stalled OpenAI realtime smoke fetches at the request timeout", async () => {
    let signal: AbortSignal | undefined;
    const request = realtimeSmokeTesting.createOpenAIClientSecret("test-key", {
      timeoutMs: 5,
      fetchImpl: ((_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => {});
      }) as typeof fetch,
    });

    await expect(request).rejects.toThrow(
      /OpenAI Realtime client secret request exceeded timeout/u,
    );
    expect(signal?.aborted).toBe(true);
  });

  it("times out stalled OpenAI realtime smoke response body reads", async () => {
    const response = {
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => new Promise(() => {}),
    } as Response;
    const request = realtimeSmokeTesting.createOpenAIClientSecret("test-key", {
      timeoutMs: 5,
      fetchImpl: (() => Promise.resolve(response)) as typeof fetch,
    });

    await expect(request).rejects.toThrow(
      /OpenAI Realtime client secret request exceeded timeout/u,
    );
  });

  it("rejects invalid OpenAI realtime smoke timeout values", () => {
    expect(realtimeSmokeTesting.resolveOpenAIHttpTimeoutMs("42")).toBe(42);
    expect(() => realtimeSmokeTesting.resolveOpenAIHttpTimeoutMs("2s")).toThrow(
      /OPENCLAW_REALTIME_OPENAI_HTTP_TIMEOUT_MS must be an integer/u,
    );
  });

  it("rejects absolute-form URLs in the Anthropic capture proxy", () => {
    expect(
      promptProbeTesting.resolveAnthropicUpstreamUrl(
        "/v1/messages?anthropic-version=2023-06-01",
        "https://api.anthropic.com",
      ),
    ).toBe("https://api.anthropic.com/v1/messages?anthropic-version=2023-06-01");
    expect(() =>
      promptProbeTesting.resolveAnthropicUpstreamUrl(
        "http://169.254.169.254/latest/meta-data",
        "https://api.anthropic.com",
      ),
    ).toThrow(/refusing non-origin proxy request URL/u);
  });

  it("uses exact Claude cookie host matchers instead of broad substring matches", () => {
    expect(claudeUsageTesting.CLAUDE_COOKIE_HOST_SQL).toContain("host_key = 'claude.ai'");
    expect(claudeUsageTesting.CLAUDE_COOKIE_HOST_SQL).toContain("LIKE '%.claude.ai'");
    expect(claudeUsageTesting.CLAUDE_COOKIE_HOST_SQL).not.toContain("%claude.ai%");
  });

  it("aborts stalled Claude usage fetches at the request timeout", async () => {
    let signal: AbortSignal | undefined;
    const request = claudeUsageTesting.fetchAnthropicOAuthUsage("test-token", {
      timeoutMs: 5,
      fetchImpl: ((_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => {});
      }) as typeof fetch,
    });

    await expect(request).rejects.toThrow(/Anthropic OAuth usage request exceeded timeout/u);
    expect(signal?.aborted).toBe(true);
  });

  it("times out stalled Claude usage response body reads", async () => {
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: () => new Promise(() => {}),
    } as Response;
    const request = claudeUsageTesting.fetchAnthropicOAuthUsage("test-token", {
      timeoutMs: 5,
      fetchImpl: (() => Promise.resolve(response)) as typeof fetch,
    });

    await expect(request).rejects.toThrow(/Anthropic OAuth usage request exceeded timeout/u);
  });

  it("rejects invalid Claude usage timeout values", () => {
    expect(claudeUsageTesting.resolveFetchTimeoutMs("123")).toBe(123);
    expect(() => claudeUsageTesting.resolveFetchTimeoutMs("1.5")).toThrow(
      /OPENCLAW_DEBUG_CLAUDE_USAGE_FETCH_TIMEOUT_MS must be an integer/u,
    );
  });
});
