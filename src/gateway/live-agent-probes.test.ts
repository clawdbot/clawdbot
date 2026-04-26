import { describe, expect, it } from "vitest";
import {
  assertCronJobMatches,
  assertLiveImageProbeReply,
  buildLiveCronProbeMessage,
  createLiveCronProbeSpec,
  isClaudeLikeLiveAgent,
} from "./live-agent-probes.js";

describe("live-agent-probes", () => {
  it("only special-cases Claude-like retry prompts", () => {
    expect(isClaudeLikeLiveAgent("claude")).toBe(true);
    expect(isClaudeLikeLiveAgent("claude-cli")).toBe(true);
    expect(isClaudeLikeLiveAgent("codex")).toBe(false);
    expect(isClaudeLikeLiveAgent("google-gemini-cli")).toBe(false);
    expect(isClaudeLikeLiveAgent("opencode-ai")).toBe(false);
    expect(isClaudeLikeLiveAgent("future-agent")).toBe(false);
  });

  it("accepts only cat for the shared image probe reply", () => {
    expect(() => assertLiveImageProbeReply("cat")).not.toThrow();
    expect(() =>
      assertLiveImageProbeReply(
        "model metadata for `gpt-5.5` not found. defaulting to fallback metadata; this can degrade performance and cause issues.cat",
      ),
    ).not.toThrow();
    expect(() => assertLiveImageProbeReply("horse")).toThrow("image probe expected 'cat'");
    expect(() => assertLiveImageProbeReply("caterpillar")).toThrow("image probe expected 'cat'");
  });

  it("builds a retryable cron prompt with provider-specific fallback wording", () => {
    const spec = createLiveCronProbeSpec({
      agentId: "codex",
      sessionKey: "agent:codex:acp:test",
    });
    expect(
      buildLiveCronProbeMessage({
        agent: "claude-cli",
        argsJson: spec.argsJson,
        attempt: 1,
        exactReply: spec.name,
      }),
    ).toContain("Preserve job.sessionTarget and job.sessionKey exactly as provided.");
    expect(
      buildLiveCronProbeMessage({
        agent: "future-agent",
        argsJson: spec.argsJson,
        attempt: 1,
        exactReply: spec.name,
      }),
    ).toContain("ask me to retry");
    expect(
      buildLiveCronProbeMessage({
        agent: "codex",
        argsJson: spec.argsJson,
        attempt: 1,
        exactReply: spec.name,
      }),
    ).toContain("previous OpenClaw cron MCP tool call was cancelled");
    expect(JSON.parse(spec.argsJson)).toEqual(
      expect.objectContaining({
        job: expect.objectContaining({
          sessionTarget: "session:agent:codex:acp:test",
          agentId: "codex",
          sessionKey: "agent:codex:acp:test",
        }),
      }),
    );
  });

  it("validates cron cli job shape for the shared live probe", () => {
    expect(() =>
      assertCronJobMatches({
        job: {
          name: "live-mcp-abc",
          sessionTarget: "session:agent:dev:test",
          agentId: "dev",
          sessionKey: "agent:dev:test",
          payload: { kind: "agentTurn", message: "probe-abc" },
        },
        expectedName: "live-mcp-abc",
        expectedMessage: "probe-abc",
        expectedSessionKey: "agent:dev:test",
      }),
    ).not.toThrow();
  });
});
