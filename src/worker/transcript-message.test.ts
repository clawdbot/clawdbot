import { describe, expect, it } from "vitest";
import { validateWorkerTranscriptCommitParams } from "../../packages/gateway-protocol/src/index.js";
import type { AssistantMessage } from "../llm/types.js";
import { toAgentMessage } from "./embedded-agent-transcript.runtime.js";
import {
  isWorkerTranscriptMessageFrameSafe,
  toWorkerTranscriptMessage,
} from "./transcript-message.js";

const providerReplay = {
  v: 1 as const,
  type: "openai-responses-compaction",
  id: "cmp_worker_projection",
  data: "opaque-worker-projection",
  replayIndex: 1,
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.6-luna",
  baseUrlHash: "ozhevd1smnk8s",
  sessionHash: "171dzdv17gum5g",
  authProfileHash: "oe8bkr3r8947",
};

describe("worker transcript provider replay", () => {
  it("projects and restores opaque replay state within frame limits", () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "visible" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.6-luna",
      providerReplay: structuredClone(providerReplay),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    Object.assign(message.providerReplay!, { providerScratch: "private" });

    const projected = toWorkerTranscriptMessage(message);
    expect(projected?.role).toBe("assistant");
    if (!projected || projected.role !== "assistant") {
      throw new Error("expected projected assistant message");
    }
    expect(projected.providerReplay).toEqual(providerReplay);
    expect(JSON.stringify(projected)).not.toContain("providerScratch");
    expect(isWorkerTranscriptMessageFrameSafe(projected)).toBe(true);
    expect(
      validateWorkerTranscriptCommitParams({
        runEpoch: 1,
        seq: 1,
        baseLeafId: null,
        messages: [projected],
      }),
    ).toBe(true);
    expect(toAgentMessage(projected)).toMatchObject({ providerReplay });
  });
});
