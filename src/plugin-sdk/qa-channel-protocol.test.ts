import { describe, expect, it } from "vitest";
import { sanitizeQaBusToolCalls } from "./qa-channel-protocol.js";

describe("qa-channel protocol", () => {
  it("sanitizes QA bus tool-call arguments before persistence", () => {
    const toolCalls = sanitizeQaBusToolCalls([
      null,
      { name: 123 },
      {
        name: " exec ",
        arguments: {
          command: "cat README.md",
          apiToken: "secret-token",
          headers: {
            Authorization: "Bearer sk_test_12345678901234567890",
          },
          notes: "raw key sk-proj-12345678901234567890",
          commandLine: "curl --password hunter2 -H 'x-api-key: abc123' https://example.test",
          hyphenFlagCommand: "cmd --client-secret abc123 --ok yes",
          envCommand: "NPM_TOKEN=secret GITHUB_TOKEN=secret pnpm test",
          authCommand: "curl -H 'Authorization: Bearer eyJ1234567890abcd' https://example.test",
          cookieCommand: "curl -H 'Cookie: a=b; c=d' https://example.test",
          debugText: "token=abc123; keep going",
          headerPairs: [
            ["X-API-Key", "secret"],
            ["Accept", "application/json"],
          ],
          argv: ["gh", "api", "--token", "secret-token", "repos/openclaw/openclaw"],
          hyphenArgv: ["cmd", "--access-token", "abc123", "--ok"],
          values: ["ok", { password: "hunter2" }],
        },
      },
    ]);

    expect(toolCalls).toEqual([
      {
        name: "exec",
        arguments: {
          command: "[redacted]",
          apiToken: "[redacted]",
          headers: {
            Authorization: "[redacted]",
          },
          notes: "[redacted]",
          commandLine: "[redacted]",
          hyphenFlagCommand: "[redacted]",
          envCommand: "[redacted]",
          authCommand: "[redacted]",
          cookieCommand: "[redacted]",
          debugText: "[redacted]",
          headerPairs: [
            ["[redacted]", "[redacted]"],
            ["[redacted]", "[redacted]"],
          ],
          argv: ["[redacted]", "[redacted]", "[redacted]", "[redacted]", "[redacted]"],
          hyphenArgv: ["[redacted]", "[redacted]", "[redacted]", "[redacted]"],
          values: ["[redacted]", { password: "[redacted]" }],
        },
      },
    ]);
  });

  it("caps QA bus tool-call sanitization before processing the tail", () => {
    const toolCalls = Array.from({ length: 50 }, (_, index) => ({
      name: `tool-${index}`,
    }));
    toolCalls.push({
      get name(): string {
        throw new Error("tail should not be sanitized");
      },
    });

    expect(sanitizeQaBusToolCalls(toolCalls)?.map((toolCall) => toolCall.name)).toHaveLength(50);
  });
});
