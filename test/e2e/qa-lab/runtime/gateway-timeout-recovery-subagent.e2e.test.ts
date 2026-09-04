import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  startQaBusServer,
} from "../../../../extensions/qa-lab/api.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const MODEL = "mock-openai/gpt-5.6-luna";
const CHILD_MODEL = "mock-openai/gpt-5.6-luna-alt";
const CONVERSATION = { id: "timeout-recovery", kind: "direct" as const };
const PROMPT =
  "Subagent terminal reply QA check: visible. Spawn one native worker, then finish the parent turn without waiting. Do not use ACP.";
const CHILD_MARKER = "QA-TIMEOUT-RECOVERY-CHILD-OK";
const PARENT_READY = "QA-TIMEOUT-RECOVERY-PARENT-READY";
const RECOVERY_PROMPT = "Continue while the existing worker finishes. Do not spawn another worker.";
type SseEvent = {
  type: string;
  response?: Record<string, unknown>;
  [key: string]: unknown;
};

let responseSequence = 0;

function buildAssistantEvents(text: string): SseEvent[] {
  const sequence = ++responseSequence;
  const responseId = `resp_qa_timeout_recovery_${sequence}`;
  const itemId = `msg_qa_timeout_recovery_${sequence}`;
  const part = { type: "output_text", text, annotations: [] };
  const item = {
    type: "message",
    id: itemId,
    role: "assistant",
    status: "completed",
    content: [part],
  };
  const position = { item_id: itemId, output_index: 0, content_index: 0 };
  return [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        created_at: Math.floor(Date.now() / 1_000),
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, content: [], status: "in_progress" },
    },
    {
      type: "response.content_part.added",
      ...position,
      part: { ...part, text: "" },
    },
    { type: "response.output_text.delta", ...position, delta: text },
    { type: "response.output_text.done", ...position, text },
    { type: "response.content_part.done", ...position, part },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 64, output_tokens: 24, total_tokens: 88 },
      },
    },
  ];
}

function buildToolCallEventsWithArgs(name: string, args: Record<string, unknown>): SseEvent[] {
  const sequence = ++responseSequence;
  const responseId = `resp_qa_timeout_recovery_tool_${sequence}`;
  const itemId = `fc_qa_timeout_recovery_${sequence}`;
  const callId = `call_qa_timeout_recovery_${sequence}`;
  const argumentsText = JSON.stringify(args);
  const item = {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name,
    arguments: argumentsText,
  };
  return [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        created_at: Math.floor(Date.now() / 1_000),
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      output_index: 0,
      delta: argumentsText,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: 0,
      name,
      arguments: argumentsText,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 64, output_tokens: 16, total_tokens: 80 },
      },
    },
  ];
}

function writeSse(response: ServerResponse, events: SseEvent[]) {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

async function streamAssistantReply(response: ServerResponse, text: string, durationMs: number) {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
  for (const event of withUsage(buildAssistantEvents(text), 20)) {
    if (event.type === "response.output_text.delta") {
      // Successful child/compaction requests stay live while the parent's
      // silent continuation alone crosses the provider's idle deadline.
      for (const delta of text) {
        await sleep(durationMs / text.length);
        response.write(`data: ${JSON.stringify({ ...event, delta })}\n\n`);
      }
    } else {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }
  response.end("data: [DONE]\n\n");
}

function withUsage(events: SseEvent[], inputTokens: number): SseEvent[] {
  return events.map((event) => {
    if (event.type !== "response.completed" || !event.response) {
      return event;
    }
    return {
      ...event,
      response: {
        ...event.response,
        usage: { input_tokens: inputTokens, output_tokens: 8, total_tokens: inputTokens + 8 },
      },
    };
  });
}

async function startProofProvider() {
  let parentContinuationStartedAt: number | undefined;
  let childReleasedAt: number | undefined;
  let compactionStartedAt: number | undefined;
  let compactionReleasedAt: number | undefined;
  let parentContinuationSeen = false;
  let childRequestSeen = false;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const inputText = JSON.stringify(body.input ?? body);
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      // A distinct configured model identifies child requests without matching
      // the worker task also present in the parent's tool-call history.
      if (body.model === CHILD_MODEL.split("/")[1]) {
        if (!childRequestSeen) {
          childRequestSeen = true;
          await streamAssistantReply(response, CHILD_MARKER, 6_000);
          childReleasedAt = Date.now();
        } else {
          // Follow-up model calls must not overwrite the original worker's
          // completion time used to prove the recovery window.
          writeSse(response, withUsage(buildAssistantEvents(CHILD_MARKER), 20));
        }
        return;
      }
      // Compaction serializes history into one tool-free summary request; its
      // quoted tool calls are not a fresh request to spawn another worker.
      if (!Array.isArray(body.tools) || body.tools.length === 0) {
        compactionStartedAt = Date.now();
        await streamAssistantReply(response, "QA-TIMEOUT-RECOVERY-SUMMARY", 10_000);
        compactionReleasedAt = Date.now();
        return;
      }
      if (parentContinuationSeen) {
        // Compaction changes history representation. Do not interpret missing
        // tool-output items as a request to spawn again or invent a child reply.
        const hasChildCompletion =
          inputText.includes("Agent steering queue items arrived since your last turn.") &&
          inputText.includes("qa-timeout-recovery-child") &&
          inputText.includes(CHILD_MARKER);
        writeSse(
          response,
          withUsage(
            buildAssistantEvents(
              hasChildCompletion ? CHILD_MARKER : "QA-TIMEOUT-RECOVERY-PARENT-OK",
            ),
            20,
          ),
        );
        return;
      }
      if (!inputText.includes(PROMPT)) {
        writeSse(response, withUsage(buildAssistantEvents("QA-TIMEOUT-RECOVERY-ANNOUNCE-OK"), 20));
        return;
      }
      if (!inputText.includes("function_call_output")) {
        writeSse(
          response,
          withUsage(
            buildToolCallEventsWithArgs("sessions_spawn", {
              task: `Subagent terminal reply QA worker: visible. Return exactly ${CHILD_MARKER}.`,
              label: "qa-timeout-recovery-child",
              thread: false,
              mode: "run",
              model: CHILD_MODEL,
            }),
            90_000,
          ),
        );
        return;
      }
      if (!inputText.includes(RECOVERY_PROMPT)) {
        writeSse(response, withUsage(buildAssistantEvents(PARENT_READY), 90_000));
        return;
      }
      parentContinuationSeen = true;
      parentContinuationStartedAt = Date.now();
      await sleep(12_000);
      writeSse(response, withUsage(buildAssistantEvents("NO_REPLY"), 90_000));
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("proof provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    proof: {
      get parentContinuationStartedAt() {
        return parentContinuationStartedAt;
      },
      get childReleasedAt() {
        return childReleasedAt;
      },
      get compactionReleasedAt() {
        return compactionReleasedAt;
      },
      get compactionStartedAt() {
        return compactionStartedAt;
      },
    },
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

function withTimeoutConfig(config: OpenClawConfig): OpenClawConfig {
  const provider = config.models?.providers?.["mock-openai"];
  if (!provider) {
    throw new Error("mock-openai provider missing from QA config");
  }
  return {
    ...config,
    agents: {
      ...config.agents,
      // The alternate model identifies the child, not a parent fallback.
      defaults: { ...config.agents?.defaults, model: { primary: MODEL } },
      entries: {
        ...config.agents?.entries,
        qa: { ...config.agents?.entries?.qa, model: { primary: MODEL } },
      },
    },
    // Exercise recoverable model silence, not the terminal whole-run deadline.
    models: {
      ...config.models,
      providers: { ...config.models?.providers, "mock-openai": { ...provider, timeoutSeconds: 4 } },
    },
  };
}

describe("Gateway timeout recovery subagent delivery", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });

  it("delivers a child completion once while parent timeout recovery is active", async () => {
    const provider = await startProofProvider();
    cleanups.push(() => provider.stop());
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const bus = await startQaBusServer({ state });
    cleanups.push(() => bus.stop());
    const owner = createQaGatewayChild();
    cleanups.push(async () => expect((await owner.stop()).errors).toEqual([]));
    const gateway = await owner.start({
      repoRoot: REPO_ROOT,
      useRepoCli: true,
      providerBaseUrl: `${provider.baseUrl}/v1`,
      providerMode: "mock-openai",
      primaryModel: MODEL,
      alternateModel: CHILD_MODEL,
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
      mutateConfig: withTimeoutConfig,
    });
    await transport.waitReady({ gateway });
    const sinceIndex = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound").length;
    await transport.sendInbound({
      accountId: "default",
      conversation: CONVERSATION,
      senderId: CONVERSATION.id,
      text: PROMPT,
    });
    await transport.waitForOutbound({
      conversation: CONVERSATION,
      sinceIndex,
      textIncludes: PARENT_READY,
      timeoutMs: 90_000,
    });
    // Spawning is a committed side effect and cannot be replayed after timeout.
    // Recover the next turn while the already-started child is still running.
    await transport.sendInbound({
      accountId: "default",
      conversation: CONVERSATION,
      senderId: CONVERSATION.id,
      text: RECOVERY_PROMPT,
    });
    const completion = await transport.waitForOutbound({
      conversation: CONVERSATION,
      sinceIndex,
      textIncludes: CHILD_MARKER,
      timeoutMs: 90_000,
    });
    expect(completion.accountId).toBe("default");
    expect(provider.proof.parentContinuationStartedAt).toBeTypeOf("number");
    expect(provider.proof.childReleasedAt).toBeTypeOf("number");
    expect(provider.proof.compactionStartedAt).toBeTypeOf("number");
    expect(provider.proof.compactionReleasedAt).toBeTypeOf("number");
    expect(provider.proof.compactionStartedAt!).toBeLessThan(provider.proof.childReleasedAt!);
    expect(provider.proof.childReleasedAt!).toBeLessThan(provider.proof.compactionReleasedAt!);
    expect(gateway.logs()).toContain("attempting compaction before retry");
    expect(gateway.logs()).toContain("compaction succeeded");
    const listing = (await gateway.call("tasks.list", { agentId: "qa", limit: 100 })) as {
      tasks?: Array<Record<string, unknown>>;
    };
    const tasks = listing.tasks?.filter((entry) => entry.title === "qa-timeout-recovery-child");
    expect(tasks).toHaveLength(1);
    const task = tasks?.[0];
    expect(task?.runId).toBeTypeOf("string");
    expect(task?.taskId).toBeTypeOf("string");
    // Read completion through the serving Gateway's durable task projection.
    // The terminal reply can precede its delivery-state commit.
    await expect
      .poll(
        async () => {
          const result = (await gateway.call("tasks.get", { taskId: task?.taskId })) as {
            task: Record<string, unknown>;
          };
          return result.task;
        },
        { timeout: 10_000 },
      )
      .toMatchObject({ status: "completed", deliveryStatus: "delivered" });
    const matching = state
      .getSnapshot()
      .messages.filter(
        (message) =>
          message.direction === "outbound" &&
          !message.deleted &&
          message.text.includes(CHILD_MARKER),
      );
    expect(matching, JSON.stringify(matching)).toHaveLength(1);
    console.log(
      JSON.stringify({
        phase: "gateway-timeout-recovery-subagent",
        stateDir: gateway.runtimeEnv.OPENCLAW_STATE_DIR,
        childRunId: task?.runId,
        outboundCompletionCount: matching.length,
        childReleasedAt: provider.proof.childReleasedAt,
        compactionReleasedAt: provider.proof.compactionReleasedAt,
      }),
    );
  }, 180_000);
});
