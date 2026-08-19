// Tests usage-line formatting for agent runner completion summaries.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { appendUsageLine, resolveResponseUsageLine } from "./agent-runner-usage-line.js";

describe("appendUsageLine", () => {
  it("marks a standalone usage footer as non-terminal status", () => {
    expect(
      appendUsageLine([{ mediaUrl: "file:///tmp/result.png" }], "Usage: 12 in / 3 out"),
    ).toEqual([
      { mediaUrl: "file:///tmp/result.png" },
      { text: "Usage: 12 in / 3 out", isStatusNotice: true },
    ]);
  });

  it("prices response usage for the selected agent in an explicit fleet", () => {
    const line = resolveResponseUsageLine({
      config: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, other: {} },
        },
        messages: { responseUsage: "full" },
        models: {
          providers: {
            fixture: {
              baseUrl: "https://fixture.invalid",
              models: [
                {
                  id: "priced",
                  name: "Priced",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1,
                  maxTokens: 1,
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
      agentDir: "/tmp/openclaw-main-agent",
      usage: { input: 1_000_000, output: 0 },
      provider: "fixture",
      model: "priced",
    });

    expect(line).toContain("est $1");
  });

  it("preserves reply payload metadata when appending usage text", () => {
    const payload = setReplyPayloadMetadata(
      { text: "message tool reply" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main:telegram:direct:123",
          agentId: "main",
          text: "message tool reply",
          idempotencyKey: "run-1:internal-source-reply:0",
        },
      },
    );

    const [updated] = appendUsageLine([payload], "Usage: 12 in / 3 out");

    expect(updated).toEqual({ text: "message tool reply\nUsage: 12 in / 3 out" });
    expect(getReplyPayloadMetadata(expectDefined(updated, "updated test invariant"))).toMatchObject(
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main:telegram:direct:123",
          idempotencyKey: "run-1:internal-source-reply:0",
          text: "message tool reply\nUsage: 12 in / 3 out",
        },
      },
    );
  });
});
