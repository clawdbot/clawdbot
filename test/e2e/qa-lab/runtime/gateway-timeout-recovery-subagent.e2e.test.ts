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
import { readSubagentRun } from "../../../../src/agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../../../../src/state/openclaw-state-db.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const MODEL = "mock-openai/gpt-5.6-luna";
const CONVERSATION = { id: "timeout-recovery", kind: "direct" as const };
const PROMPT =
  "Subagent terminal reply QA check: visible. Spawn one native worker, then finish the parent turn without waiting. Do not use ACP.";
const CHILD_MARKER = "QA-TIMEOUT-RECOVERY-CHILD-OK";
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
  let compactionReleasedAt: number | undefined;
  let parentContinuationSeen = false;
  let compactionSeen = false;
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
      if (inputText.includes("Subagent terminal reply QA worker:")) {
        await sleep(6_000);
        childReleasedAt = Date.now();
        writeSse(response, withUsage(buildAssistantEvents(CHILD_MARKER), 20));
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
            }),
            160_000,
          ),
        );
        return;
      }
      if (!parentContinuationSeen) {
        parentContinuationSeen = true;
        parentContinuationStartedAt = Date.now();
        await sleep(12_000);
        writeSse(response, withUsage(buildAssistantEvents("NO_REPLY"), 160_000));
        return;
      }
      if (!compactionSeen) {
        compactionSeen = true;
        await sleep(10_000);
        compactionReleasedAt = Date.now();
        writeSse(response, withUsage(buildAssistantEvents("QA-TIMEOUT-RECOVERY-SUMMARY"), 20));
        return;
      }
      writeSse(response, withUsage(buildAssistantEvents(CHILD_MARKER), 20));
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
      defaults: { ...config.agents?.defaults, timeoutSeconds: 4 },
    },
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
      alternateModel: MODEL,
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
    const completion = await transport.waitForOutbound({
      conversation: CONVERSATION,
      sinceIndex,
      textIncludes: CHILD_MARKER,
      timeoutMs: 90_000,
    });
    const matching = state
      .getSnapshot()
      .messages.filter(
        (message) => message.direction === "outbound" && message.text.includes(CHILD_MARKER),
      );
    expect(completion.accountId).toBe("default");
    expect(matching).toHaveLength(1);
    expect(provider.proof.parentContinuationStartedAt).toBeTypeOf("number");
    expect(provider.proof.childReleasedAt).toBeTypeOf("number");
    expect(provider.proof.compactionReleasedAt).toBeTypeOf("number");
    expect(provider.proof.childReleasedAt!).toBeLessThan(provider.proof.compactionReleasedAt!);
    expect(gateway.logs()).toContain("attempting compaction before retry");
    expect(gateway.logs()).toContain("compaction succeeded");
    const listing = (await gateway.call("tasks.list", { agentId: "qa", limit: 100 })) as {
      tasks?: Array<Record<string, unknown>>;
    };
    const task = listing.tasks?.find((entry) => entry.title === "qa-timeout-recovery-child");
    expect(task?.runId).toBeTypeOf("string");
    const database = openOpenClawStateDatabase({ env: gateway.runtimeEnv });
    cleanups.push(async () => {
      closeOpenClawStateDatabaseByPath(database.path);
    });
    const ledger = readSubagentRun(database, String(task?.runId));
    expect(ledger?.execution.outcome?.status).toBe("ok");
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
