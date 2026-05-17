import { describe, expect, it } from "vitest";
import {
  assertNoGatewayLogSentinels,
  formatGatewayLogSentinelSummary,
  scanDirectReplyTranscriptSentinels,
  scanGatewayLogSentinels,
} from "./gateway-log-sentinel.js";

describe("gateway log sentinels", () => {
  it("classifies May 13 beta.5 operational failure signatures", () => {
    const findings = scanGatewayLogSentinels(
      [
        "2026-05-13T00:00:01Z plugin before_prompt_build hook failed: TypeError: boom",
        "2026-05-13T00:00:02Z plugin before_tool_call crashed while evaluating policy",
        "2026-05-13T00:00:03Z plugin manifest invalid: missing contracts.tools registration",
        "2026-05-13T00:00:04Z codex app-server attempt timed out after 180000ms",
        "2026-05-13T00:00:05Z codex_app_server progress stalled for run abc123",
        "2026-05-13T00:00:06Z cron payload model openai/gpt-5.4 is not in model allowlist",
        "2026-05-13T00:00:07Z OpenAI quota exceeded for live-frontier request",
      ].join("\n"),
    );

    expect(findings.map((finding) => finding.kind)).toEqual([
      "plugin-hook-failure",
      "plugin-hook-failure",
      "plugin-contract-error",
      "codex-app-server-timeout",
      "stalled-agent-run",
      "cron-model-allowlist",
      "live-quota-or-subscription",
    ]);
    expect(findings.find((finding) => finding.kind === "plugin-hook-failure")).toMatchObject({
      verdict: "qa-harness-bug",
      owner: "plugin",
      productImpact: "P1",
    });
    expect(findings.find((finding) => finding.kind === "live-quota-or-subscription")).toMatchObject(
      {
        verdict: "environment-blocked",
        owner: "environment",
        productImpact: "P4",
      },
    );
  });

  it("honors log cursors while preserving absolute line numbers", () => {
    const prefix = "safe line\n";
    const findings = scanGatewayLogSentinels(`${prefix}codex app-server attempt timed out`, {
      since: prefix.length,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "codex-app-server-timeout",
      line: 2,
    });
  });

  it("throws actionable summaries unless only environment blockers are allowed", () => {
    expect(() => assertNoGatewayLogSentinels("codex_app_server progress stalled")).toThrow(
      "stalled-agent-run",
    );
    expect(() =>
      assertNoGatewayLogSentinels("OpenAI quota exceeded", { allowEnvironmentBlocked: true }),
    ).not.toThrow();
    expect(formatGatewayLogSentinelSummary(scanGatewayLogSentinels("OpenAI quota exceeded"))).toBe(
      "live-quota-or-subscription@1 environment-blocked owner=environment: OpenAI quota exceeded",
    );
  });

  it("detects direct reply self-message transcripts separately from gateway logs", () => {
    const findings = scanDirectReplyTranscriptSentinels(
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: "message",
                input: { action: "send", conversationId: "qa-operator", text: "hello" },
              },
            ],
          },
        }),
        JSON.stringify({ message: { role: "assistant", content: "Sent." } }),
      ].join("\n"),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "direct-reply-self-message",
      verdict: "product-bug",
      owner: "openclaw-routing",
    });
  });

  it("detects OpenAI function_call-shaped direct reply transcripts", () => {
    const findings = scanDirectReplyTranscriptSentinels(
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              {
                type: "function_call",
                name: "message",
                arguments: JSON.stringify({
                  action: "send",
                  target: "current",
                  text: "hello",
                }),
              },
            ],
          },
        }),
        JSON.stringify({ message: { role: "assistant", content: "Sent." } }),
      ].join("\n"),
    );

    expect(findings.map((finding) => finding.kind)).toEqual(["direct-reply-self-message"]);
  });
});
