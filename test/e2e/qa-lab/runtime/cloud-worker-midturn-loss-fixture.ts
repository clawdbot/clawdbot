import { createServer, type ServerResponse } from "node:http";

export const MODEL_REF = "mock-openai/gpt-5.6-luna";
export const BASELINE_PROMPT = "Reply exactly: CLOUD-MIDTURN-BASELINE";
export const BASELINE_REPLY = "CLOUD-MIDTURN-BASELINE";
export const WORKER_PERMISSION_PROMPT =
  "WORKER-PERMISSION-PROOF: run the requested workspace and exec checks.";
export const WORKER_PERMISSION_REPLY = "WORKER-PERMISSION-PROOF-OK";
export const MIDTURN_PROMPT =
  "CLOUD-MIDTURN-KILL: persist two checkpoints, then stream the final reply.";
export const CONTEXT_PROMPT =
  "CLOUD-MIDTURN-CONTEXT: prove the committed checkpoints are in context.";
export const CONTEXT_REPLY = "CLOUD-MIDTURN-CONTEXT-OK";
export const VOLATILE_TEXT = "CLOUD-MIDTURN-VOLATILE-PARTIAL";
export const COMMITTED_MARKERS = [
  "CLOUD-MIDTURN-ASSISTANT-1",
  "CLOUD-MIDTURN-TOOL-1",
  "CLOUD-MIDTURN-ASSISTANT-2",
  "CLOUD-MIDTURN-TOOL-2",
] as const;
export const PROOF_TIMEOUT_MS = 180_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitFor<T>(
  label: string,
  read: () => T | undefined | Promise<T | undefined>,
) {
  const deadline = Date.now() + PROOF_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function createDeferred() {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function writeSseEvent(response: ServerResponse, event: unknown): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function assistantItem(id: string, text: string, phase: "commentary" | "final_answer") {
  return {
    type: "message",
    id,
    role: "assistant",
    phase,
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function toolCallItem(index: number, file: string) {
  const args = JSON.stringify({ path: file });
  return {
    args,
    item: {
      type: "function_call",
      id: `fc_cloud_midturn_${index}`,
      call_id: `call_cloud_midturn_${index}`,
      name: "read",
      arguments: args,
    },
  };
}

function writeFunctionCall(
  response: ServerResponse,
  params: { callId: string; name: string; arguments: Record<string, unknown> },
): void {
  const args = JSON.stringify(params.arguments);
  const item = {
    type: "function_call",
    id: `fc_${params.callId}`,
    call_id: params.callId,
    name: params.name,
    arguments: args,
  };
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  writeSseEvent(response, {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...item, arguments: "" },
  });
  writeSseEvent(response, {
    type: "response.function_call_arguments.delta",
    item_id: item.id,
    output_index: 0,
    delta: args,
  });
  writeSseEvent(response, { type: "response.output_item.done", output_index: 0, item });
  writeSseEvent(response, {
    type: "response.completed",
    response: {
      id: `resp_${params.callId}`,
      status: "completed",
      output: [item],
      usage: { input_tokens: 32, output_tokens: 12, total_tokens: 44 },
    },
  });
  response.end("data: [DONE]\n\n");
}

function findFunctionCallOutput(raw: string, callId: string): string | undefined {
  const body = JSON.parse(raw) as { input?: unknown[] };
  const item = body.input?.find(
    (candidate): candidate is { call_id: string; output: unknown; type: string } =>
      typeof candidate === "object" &&
      candidate !== null &&
      "type" in candidate &&
      candidate.type === "function_call_output" &&
      "call_id" in candidate &&
      candidate.call_id === callId &&
      "output" in candidate,
  );
  return item
    ? typeof item.output === "string"
      ? item.output
      : JSON.stringify(item.output)
    : undefined;
}

function writeCompletedAssistant(response: ServerResponse, text: string, id: string): void {
  const item = assistantItem(id, text, "final_answer");
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  writeSseEvent(response, {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...item, status: "in_progress", content: [] },
  });
  writeSseEvent(response, {
    type: "response.output_text.delta",
    item_id: id,
    output_index: 0,
    content_index: 0,
    delta: text,
  });
  writeSseEvent(response, {
    type: "response.output_text.done",
    item_id: id,
    output_index: 0,
    content_index: 0,
    text,
  });
  writeSseEvent(response, { type: "response.output_item.done", output_index: 0, item });
  writeSseEvent(response, {
    type: "response.completed",
    response: {
      id: `resp_${id}`,
      status: "completed",
      output: [item],
      usage: { input_tokens: 32, output_tokens: 8, total_tokens: 40 },
    },
  });
  response.end("data: [DONE]\n\n");
}

function writeCheckpointToolCall(response: ServerResponse, index: 1 | 2): void {
  const text = `CLOUD-MIDTURN-ASSISTANT-${index}`;
  const message = assistantItem(`msg_cloud_midturn_${index}`, text, "commentary");
  const call = toolCallItem(index, `checkpoint-${index}.txt`);
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  writeSseEvent(response, {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...message, status: "in_progress", content: [] },
  });
  writeSseEvent(response, {
    type: "response.output_text.delta",
    item_id: message.id,
    output_index: 0,
    content_index: 0,
    delta: text,
  });
  writeSseEvent(response, {
    type: "response.output_text.done",
    item_id: message.id,
    output_index: 0,
    content_index: 0,
    text,
  });
  writeSseEvent(response, { type: "response.output_item.done", output_index: 0, item: message });
  writeSseEvent(response, {
    type: "response.output_item.added",
    output_index: 1,
    item: { ...call.item, arguments: "" },
  });
  writeSseEvent(response, {
    type: "response.function_call_arguments.delta",
    item_id: call.item.id,
    output_index: 1,
    delta: call.args,
  });
  writeSseEvent(response, { type: "response.output_item.done", output_index: 1, item: call.item });
  writeSseEvent(response, {
    type: "response.completed",
    response: {
      id: `resp_cloud_midturn_${index}`,
      status: "completed",
      output: [message, call.item],
      usage: { input_tokens: 64, output_tokens: 24, total_tokens: 88 },
    },
  });
  response.end("data: [DONE]\n\n");
}

async function readRequestBody(request: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startMidturnProvider() {
  let midturnRequestCount = 0;
  let contextRequest = "";
  const partialStarted = createDeferred();
  const releasePartial = createDeferred();
  const requests: string[] = [];
  let outsideWriteOutput = "";
  let execOutput = "";
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const raw = await readRequestBody(request);
      requests.push(raw);
      if (raw.includes(WORKER_PERMISSION_PROMPT)) {
        const insideOutput = findFunctionCallOutput(raw, "call_worker_permission_inside");
        if (insideOutput === undefined) {
          writeFunctionCall(response, {
            callId: "call_worker_permission_inside",
            name: "write",
            arguments: {
              path: "worker-permission-in-root.txt",
              content: "worker permission proof\n",
            },
          });
          return;
        }
        const outsideOutput = findFunctionCallOutput(raw, "call_worker_permission_outside");
        if (outsideOutput === undefined) {
          writeFunctionCall(response, {
            callId: "call_worker_permission_outside",
            name: "write",
            arguments: { path: "../worker-permission-outside.txt", content: "escaped\n" },
          });
          return;
        }
        outsideWriteOutput = outsideOutput;
        const deniedExecOutput = findFunctionCallOutput(raw, "call_worker_permission_exec");
        if (deniedExecOutput === undefined) {
          writeFunctionCall(response, {
            callId: "call_worker_permission_exec",
            name: "exec",
            arguments: {
              command: "printf WORKER_EXEC_ESCAPED > worker-exec-escaped.txt",
            },
          });
          return;
        }
        execOutput = deniedExecOutput;
        const visibleDenial = [
          /workspace/iu,
          /approval_required/iu,
          /run this command locally/iu,
          /interactive approval/iu,
          /administrator/iu,
          /clear the session permission mode/iu,
        ].every((pattern) => pattern.test(execOutput));
        const outsideRejected = /escape|outside|containment|workspace/iu.test(outsideWriteOutput);
        writeCompletedAssistant(
          response,
          visibleDenial && outsideRejected
            ? `${WORKER_PERMISSION_REPLY}\n${execOutput}`
            : `WORKER-PERMISSION-PROOF-FAILED\noutside=${outsideWriteOutput}\nexec=${execOutput}`,
          "msg_worker_permission_proof",
        );
        return;
      }
      if (raw.includes(CONTEXT_PROMPT)) {
        contextRequest = raw;
        const missing = COMMITTED_MARKERS.filter((marker) => !raw.includes(marker));
        writeCompletedAssistant(
          response,
          missing.length === 0 ? CONTEXT_REPLY : `MISSING-CONTEXT:${missing.join(",")}`,
          "msg_cloud_midturn_context",
        );
        return;
      }
      if (raw.includes(MIDTURN_PROMPT)) {
        midturnRequestCount += 1;
        if (midturnRequestCount <= 2) {
          writeCheckpointToolCall(response, midturnRequestCount as 1 | 2);
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        const item = assistantItem("msg_cloud_midturn_volatile", VOLATILE_TEXT, "final_answer");
        writeSseEvent(response, {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        });
        for (const deltaText of ["CLOUD-MIDTURN-", "VOLATILE-", "PARTIAL"]) {
          writeSseEvent(response, {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: deltaText,
          });
          await delay(50);
        }
        partialStarted.resolve();
        await releasePartial.promise;
        if (!response.destroyed) {
          writeSseEvent(response, {
            type: "response.output_text.done",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            text: VOLATILE_TEXT,
          });
          writeSseEvent(response, { type: "response.output_item.done", output_index: 0, item });
          writeSseEvent(response, {
            type: "response.completed",
            response: {
              id: "resp_cloud_midturn_volatile",
              status: "completed",
              output: [item],
              usage: { input_tokens: 64, output_tokens: 12, total_tokens: 76 },
            },
          });
          response.end("data: [DONE]\n\n");
        }
        return;
      }
      writeCompletedAssistant(response, BASELINE_REPLY, "msg_cloud_midturn_baseline");
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mid-turn provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    partialStarted: partialStarted.promise,
    get contextRequest() {
      return contextRequest;
    },
    get requestCount() {
      return requests.length;
    },
    get outsideWriteOutput() {
      return outsideWriteOutput;
    },
    get execOutput() {
      return execOutput;
    },
    async stop() {
      releasePartial.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
