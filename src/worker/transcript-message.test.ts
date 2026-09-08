import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { projectProviderError } from "../../packages/ai/src/utils/provider-error.js";
import {
  validateWorkerTranscriptCommitParams,
  WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES,
  WorkerTranscriptMessageSchema,
} from "../../packages/gateway-protocol/src/index.js";
import { WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import type { AssistantMessage } from "../llm/types.js";
import {
  createWorkerTranscriptRuntime,
  toAgentMessage,
} from "./embedded-agent-transcript.runtime.js";
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
  it.each(["computer", "browser"])(
    "preserves %s image bytes while retaining the non-image transcript budget",
    async (toolName) => {
      const message = {
        role: "toolResult" as const,
        toolCallId: "capture",
        toolName,
        content: [{ type: "image" as const, data: "a".repeat(128 * 1024), mimeType: "image/png" }],
        isError: false,
        timestamp: 1,
      };
      const commit = vi.fn(async () => {});
      const runtime = createWorkerTranscriptRuntime({ commit });
      runtime.onMessagePersisted(message);
      await runtime.withSessionWriteSettlement(() => undefined);
      expect(commit).toHaveBeenCalledWith([message]);
      expect(isWorkerTranscriptMessageFrameSafe(message)).toBe(true);
      expect(
        isWorkerTranscriptMessageFrameSafe({
          ...message,
          details: { text: "x".repeat(64 * 1024) },
        }),
      ).toBe(false);
      const oversized = {
        ...message,
        content: [
          { ...message.content[0]!, data: "a".repeat(WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES) },
        ],
      };
      expect(() => runtime.onMessagePersisted(oversized)).toThrow(
        "Worker transcript message exceeds the protocol payload limit",
      );
    },
  );
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

  it("redacts diagnostic media while preserving conversation text and replay ciphertext", () => {
    const message = assistantWithReplay();
    message.content = [
      { type: "text", text: "keep data:video/mp4;base64,QUJDRA== byte-identical" },
    ];
    message.diagnostics = [
      {
        type: "provider_transport_failure",
        timestamp: 1,
        error: { message: "failed data:video/mp4;base64,QUJDRA==" },
        details: { type: "audio", data: "QUJDRA==" },
      },
    ];

    const result = toWorkerTranscriptMessage(message, "transcript");
    if (!result || result.kind !== "complete" || result.message.role !== "assistant") {
      throw new Error("expected projected assistant message");
    }

    expect(result.message.content[0]).toEqual(message.content[0]);
    expect(result.message.providerReplay?.data).toBe(providerReplay.data);
    expect(JSON.stringify(result.message.diagnostics)).not.toContain("QUJDRA==");
    expect(Value.Check(WorkerTranscriptMessageSchema, result.message)).toBe(true);
  });

  it("keeps assistant projection valid when one optional diagnostic leaf is unreadable", () => {
    const message = assistantWithReplay();
    const details = new Proxy(
      { type: "video", data: "QUJDRA==" },
      {
        ownKeys: () => {
          throw new Error("details keys unavailable");
        },
      },
    );
    message.diagnostics = [
      {
        type: "provider_transport_failure",
        timestamp: 1,
        error: Object.assign(new Error("provider failed"), { unexpected: "drop me" }),
        details,
      },
    ];

    const result = toWorkerTranscriptMessage(message, "transcript");
    if (!result || result.kind !== "complete" || result.message.role !== "assistant") {
      throw new Error("expected projected assistant message");
    }

    expect(Array.isArray(result.message.diagnostics)).toBe(true);
    expect(Value.Check(WorkerTranscriptMessageSchema, result.message)).toBe(true);
  });

  it("redacts media bytes from tool-result diagnostic details only", () => {
    const result = toWorkerTranscriptMessage(
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "video_generate",
        content: [{ type: "text", text: "keep data:video/mp4;base64,QUJDRA==" }],
        details: { type: "video", blob: Buffer.from([1, 2, 3]) },
        isError: false,
        timestamp: 1,
      },
      "transcript",
    );
    if (!result || result.kind !== "complete" || result.message.role !== "toolResult") {
      throw new Error("expected projected tool result");
    }

    expect(result.message.content[0]).toEqual({
      type: "text",
      text: "keep data:video/mp4;base64,QUJDRA==",
    });
    expect(JSON.stringify(result.message.details)).not.toContain("QUJDRA==");
    expect(JSON.stringify(result.message.details)).not.toMatch(/"[0-9]+":(?:[0-9]+|\{)/u);
    expect(Value.Check(WorkerTranscriptMessageSchema, result.message)).toBe(true);
  });

  it("caps provider terminal fields through schema-valid transcript settlement", async () => {
    const terminal = projectProviderError({
      message: "provider failed",
      code: "c".repeat(320),
      type: "t".repeat(320),
    });
    expect(terminal.errorCode?.length).toBeLessThanOrEqual(256);
    expect(terminal.errorType?.length).toBeLessThanOrEqual(256);

    const message = Object.assign(assistantWithReplay(), terminal);
    const projected = toWorkerTranscriptMessage(message, "transcript");
    if (!projected || projected.kind !== "complete") {
      throw new Error("expected projected assistant message");
    }
    expect(Value.Check(WorkerTranscriptMessageSchema, projected.message)).toBe(true);
    expect(projected.message).toMatchObject({ providerReplay });

    const commit = vi.fn(async ([entry]) => {
      if (!entry || !Value.Check(WorkerTranscriptMessageSchema, entry)) {
        throw new Error("invalid worker transcript message");
      }
    });
    const runtime = createWorkerTranscriptRuntime({ commit });
    runtime.onMessagePersisted(message);

    await expect(runtime.withSessionWriteSettlement(() => undefined)).resolves.toBeUndefined();
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
