import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import type { AssistantMessage, Model } from "@openclaw/llm-core";
import { createDeferred } from "../../../test/helpers/promise.js";
import { Agent } from "./agent.js";
import type { AgentMessage } from "./types.js";

export type ContextRetentionResult = {
  calls: number;
  replacements: number;
  observedHistories: number;
  retained: number[];
  completed: boolean;
};

const gc = globalThis.gc;
assert.ok(gc, "The retention child requires --expose-gc");
const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 1000,
};
const histories: WeakRef<AgentMessage>[] = [];
function history(): AgentMessage {
  const message: AgentMessage = {
    role: "user",
    content: `old-history-${histories.length}:` + "x".repeat(1024 * 1024),
    timestamp: 0,
  };
  histories.push(new WeakRef(message));
  return message;
}
function finalMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "complete" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
const held = createDeferred();
const parked = createAssistantMessageEventStream();
let calls = 0;
let replacements = 0;
let runSignal: AbortSignal | undefined;
const agent = new Agent({
  initialState: { model, messages: [history()] },
  streamFn: () => {
    if (++calls === 5) {
      held.resolve();
      return parked;
    }
    const response = createAssistantMessageEventStream();
    response.push({ type: "done", reason: "stop", message: finalMessage() });
    response.end();
    return response;
  },
  prepareNextTurnWithContext: (turn, signal) => {
    if (runSignal) {
      assert.equal(signal, runSignal);
    } else {
      runSignal = signal;
    }
    if (replacements === 4) {
      return undefined;
    }
    replacements += 1;
    const summary: AgentMessage =
      replacements < 4 ? history() : { role: "user", content: "compact summary", timestamp: 0 };
    const messages = [summary, ...turn.newMessages];
    // The transcript owner must release history too; ordinary compaction runs after the core.
    agent.state.messages = messages;
    agent.steer({ role: "user", content: "continue", timestamp: replacements });
    return { context: { ...turn.context, messages } };
  },
});
const run = agent.prompt("begin");
let retained: number[] = [];
try {
  await Promise.race([
    held.promise,
    run.then(() => {
      throw new Error(
        `Run ended before its retention checkpoint: ${agent.state.errorMessage ?? "no error"}`,
      );
    }),
  ]);
  // Do not dereference during collection: WeakRef.deref keeps its target alive for that job.
  for (let pass = 0; pass < 8; pass += 1) {
    gc();
    await setImmediate();
  }
  retained = histories.flatMap((reference, index) => (reference.deref() ? [index] : []));
} finally {
  parked.push({ type: "done", reason: "stop", message: finalMessage() });
  parked.end();
  await run;
}
assert.equal(agent.state.errorMessage, undefined);
const result: ContextRetentionResult = {
  calls,
  replacements,
  observedHistories: histories.length,
  retained,
  completed: true,
};
process.stdout.write(JSON.stringify(result));
