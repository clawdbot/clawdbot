import { describe, expect, it } from "vitest";
import { testing as promptProbeTesting } from "../../scripts/anthropic-prompt-probe.ts";
import { testing as claudeUsageTesting } from "../../scripts/debug-claude-usage.ts";
import { testing as discordSmokeTesting } from "../../scripts/dev/discord-acp-plain-language-smoke.ts";
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
});
