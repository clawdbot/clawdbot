import { describe, expect, it } from "vitest";
import {
  validateWorkerTranscriptCommitParams,
  WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES,
} from "../../packages/gateway-protocol/src/index.js";
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

function assistantWithReplay(
  replay: AssistantMessage["providerReplay"] = structuredClone(providerReplay),
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "visible" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.6-luna",
    ...(replay ? { providerReplay: replay } : {}),
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
}

describe("worker transcript provider replay", () => {
  it("projects and restores opaque replay state within frame limits", () => {
    const message = assistantWithReplay();
    Object.assign(message.providerReplay!, { providerScratch: "private" });

    const result = toWorkerTranscriptMessage(message, "transcript");
    expect(result?.kind).toBe("complete");
    if (!result || result.kind !== "complete" || result.message.role !== "assistant") {
      throw new Error("expected projected assistant message");
    }
    const projected = result.message;
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

  it("keeps replay above 48 KiB whole when the complete commit frame fits", () => {
    const ciphertext = `cipher-${"x".repeat(60 * 1024)}-€`;
    const message = assistantWithReplay({
      ...providerReplay,
      data: ciphertext,
    });

    const result = toWorkerTranscriptMessage(message, "transcript");

    expect(result?.kind).toBe("complete");
    if (!result || result.kind !== "complete" || result.message.role !== "assistant") {
      throw new Error("expected projected assistant message");
    }
    expect(result.message.providerReplay?.data).toBe(ciphertext);
    expect(isWorkerTranscriptMessageFrameSafe(result.message)).toBe(true);
  });

  it.each([
    {
      name: "raw UTF-8 data over the replay field budget",
      replay: { ...providerReplay, data: "x".repeat(WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES + 1) },
      reason: "provider-replay-data-budget" as const,
    },
    {
      name: "multibyte data whose complete frame is over budget",
      replay: { ...providerReplay, data: "€".repeat(21_845) },
      reason: "transcript-commit-frame-budget" as const,
    },
    {
      name: "JSON-escaped data over the complete frame budget",
      replay: { ...providerReplay, data: "\0".repeat(12_000) },
      reason: "transcript-commit-frame-budget" as const,
    },
    {
      name: "a schema-valid id over the complete frame budget",
      replay: { ...providerReplay, id: "i".repeat(65_536), data: "opaque" },
      reason: "transcript-commit-frame-budget" as const,
    },
  ])("degrades without ciphertext for $name", ({ replay, reason }) => {
    const result = toWorkerTranscriptMessage(assistantWithReplay(replay), "transcript");

    if (!result || result.kind !== "provider-replay-unavailable") {
      throw new Error("expected degraded replay projection");
    }
    expect(result.details).toMatchObject({ reason });
    expect(JSON.stringify(result.details)).not.toContain(replay.data);
  });
});
