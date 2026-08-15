import { expect } from "vitest";
import { convertResponsesMessages } from "../../packages/ai/src/providers/openai-responses-shared.js";
import { captureOpenAIResponsesCompaction } from "../../packages/ai/src/transports/openai-responses-compaction-replay.js";
import type { WorkerTranscriptMessage } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceStartParams,
  WorkerInferenceTerminalOutcome,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { validateWorkerInferenceTerminalOutcome } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { Context, Model } from "../../packages/llm-core/src/types.js";
import { SessionManager } from "../../src/agents/sessions/session-manager.js";
import { windowInitialMessages } from "../../src/gateway/worker-environments/worker-turn-payload.js";
import type { WorkerLaunchDescriptor } from "../../src/worker/launch-descriptor.js";
import { runWorkerDescriptor } from "../../src/worker/worker.runtime.js";

type DescriptorOptions = {
  baseLeafId?: string | null;
  initialSeq?: number;
  initialAckedSeq?: number;
  runId?: string;
};

type RoundTripHarness = {
  createDescriptor(options?: DescriptorOptions): WorkerLaunchDescriptor;
  requestParams(method: string): unknown[];
  sessionTarget: Parameters<typeof SessionManager.open>[0];
  setOutcome(outcome: WorkerInferenceTerminalOutcome): void;
};
type WorkerDoneMessage = Extract<WorkerInferenceTerminalOutcome, { type: "done" }>["message"];

function doneMessage(
  model: Model<"openai-responses">,
  content: WorkerDoneMessage["content"],
): WorkerDoneMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
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

export async function runWorkerProviderReplayRoundTrip(harness: RoundTripHarness): Promise<void> {
  const baseDescriptor = harness.createDescriptor({ runId: "replay-run-1" });
  const model = {
    id: baseDescriptor.assignment.modelRef.model,
    name: "Fault replay model",
    api: "openai-responses",
    provider: baseDescriptor.assignment.modelRef.provider,
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 8_192,
  } satisfies Model<"openai-responses">;
  const ciphertext = "gAAAAworkerReplayCiphertextExact_123";
  const captured = doneMessage(model, [
    { type: "text", text: "before checkpoint" },
    { type: "text", text: "after checkpoint" },
  ]);
  captureOpenAIResponsesCompaction(
    captured,
    { type: "compaction", id: "cmp_worker_roundtrip", encrypted_content: ciphertext },
    1,
    model,
  );
  expect(validateWorkerInferenceTerminalOutcome({ type: "done", message: captured })).toBe(true);
  harness.setOutcome({ type: "done", message: captured });
  baseDescriptor.assignment.turnId = "replay-turn-1";
  baseDescriptor.assignment.prompt = "capture replay";

  const first = await runWorkerDescriptor(baseDescriptor);
  expect(first.status).toBe("completed");
  if (first.status !== "completed") {
    throw new Error("expected completed first worker turn");
  }
  const committed = (
    harness.requestParams("worker.transcript.commit") as Array<{
      messages: WorkerTranscriptMessage[];
    }>
  ).flatMap((request) => request.messages);
  const committedReplay = committed.find(
    (message) => message.role === "assistant" && message.providerReplay,
  );
  expect(
    committedReplay?.role === "assistant" ? committedReplay.providerReplay?.data : undefined,
  ).toBe(ciphertext);

  const canonicalMessages = SessionManager.open(harness.sessionTarget)
    .getBranch()
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  const replayOwner = canonicalMessages.find(
    (message) => message.role === "assistant" && message.providerReplay,
  );
  expect(replayOwner?.role === "assistant" ? replayOwner.providerReplay?.data : undefined).toBe(
    ciphertext,
  );
  const initial = windowInitialMessages(canonicalMessages);
  if (initial.kind !== "complete") {
    throw new Error("expected replayable canonical history");
  }

  harness.setOutcome({
    type: "done",
    message: doneMessage(model, [{ type: "text", text: "next reply" }]),
  });
  const liveAckedSeq = Math.max(
    ...(harness.requestParams("worker.live-event") as Array<{ seq: number }>).map(
      (request) => request.seq,
    ),
  );
  const secondDescriptor = harness.createDescriptor({
    runId: "replay-run-2",
    baseLeafId: first.transcriptLeafId,
    initialSeq: first.transcriptNextSeq,
    initialAckedSeq: liveAckedSeq,
  });
  secondDescriptor.assignment.turnId = "replay-turn-2";
  secondDescriptor.assignment.prompt = "next worker turn";
  secondDescriptor.assignment.initialMessages = initial.messages;
  await expect(runWorkerDescriptor(secondDescriptor)).resolves.toMatchObject({
    status: "completed",
  });

  const requests = harness.requestParams("worker.inference.start") as WorkerInferenceStartParams[];
  const nextContext = requests[1]?.context;
  if (!nextContext) {
    throw new Error("missing next worker inference context");
  }
  const converted = convertResponsesMessages(
    model,
    nextContext as Context,
    new Set([model.provider]),
  );
  const compactionIndex = converted.findIndex((item) => item.type === "compaction");
  expect(converted[compactionIndex]).toEqual({
    type: "compaction",
    id: "cmp_worker_roundtrip",
    encrypted_content: ciphertext,
  });
  const suffixIndex = converted.findIndex(
    (item) =>
      item.type === "message" &&
      item.role === "assistant" &&
      Array.isArray(item.content) &&
      item.content.some(
        (content) => content.type === "output_text" && content.text === "after checkpoint",
      ),
  );
  expect(suffixIndex).toBeGreaterThan(compactionIndex);
  expect(converted).toContainEqual(
    expect.objectContaining({
      type: "message",
      role: "user",
      content: [expect.objectContaining({ type: "input_text", text: "next worker turn" })],
    }),
  );
}
