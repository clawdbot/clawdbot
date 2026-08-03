import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import {
  createQaBusState,
  startQaBusServer,
  startQaGatewayChild,
} from "../../../../extensions/qa-lab/api.js";

type CapturedSpan = {
  attributes: Record<string, string | number | boolean>;
  name: string;
  parentSpanId: string;
  spanId: string;
  statusCode: number;
  traceId: string;
};

class ProtoReader {
  private offset = 0;

  constructor(private readonly buffer: Uint8Array) {}

  done() {
    return this.offset >= this.buffer.length;
  }

  tag() {
    const raw = this.varint();
    return { field: raw >>> 3, wire: raw & 7 };
  }

  varint() {
    let result = 0;
    let shift = 0;
    while (this.offset < this.buffer.length) {
      const byte = this.buffer[this.offset++];
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        return result;
      }
      shift += 7;
    }
    throw new Error("truncated protobuf varint");
  }

  bytes() {
    const length = this.varint();
    const end = this.offset + length;
    if (end > this.buffer.length) {
      throw new Error("truncated protobuf bytes");
    }
    const value = this.buffer.subarray(this.offset, end);
    this.offset = end;
    return value;
  }

  string() {
    return new TextDecoder().decode(this.bytes());
  }

  skip(wire: number) {
    if (wire === 0) {
      this.varint();
      return;
    }
    const bytes = wire === 1 ? 8 : wire === 5 ? 4 : undefined;
    if (bytes !== undefined) {
      this.offset += bytes;
      return;
    }
    if (wire === 2) {
      this.bytes();
      return;
    }
    throw new Error(`unsupported protobuf wire type ${wire}`);
  }
}

function decodeAnyValue(message: Uint8Array): string | number | boolean {
  const reader = new ProtoReader(message);
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      return reader.string();
    }
    if (field === 2 && wire === 0) {
      return reader.varint() !== 0;
    }
    if (field === 3 && wire === 0) {
      return reader.varint();
    }
    reader.skip(wire);
  }
  return "";
}

function decodeAttribute(message: Uint8Array) {
  const reader = new ProtoReader(message);
  let key = "";
  let value: string | number | boolean = "";
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      key = reader.string();
    } else if (field === 2 && wire === 2) {
      value = decodeAnyValue(reader.bytes());
    } else {
      reader.skip(wire);
    }
  }
  return { key, value };
}

function decodeStatus(message: Uint8Array) {
  const reader = new ProtoReader(message);
  let code = 0;
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 3 && wire === 0) {
      code = reader.varint();
    } else {
      reader.skip(wire);
    }
  }
  return code;
}

function decodeSpan(message: Uint8Array): CapturedSpan {
  const reader = new ProtoReader(message);
  const span: CapturedSpan = {
    attributes: {},
    name: "",
    parentSpanId: "",
    spanId: "",
    statusCode: 0,
    traceId: "",
  };
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      span.traceId = Buffer.from(reader.bytes()).toString("hex");
    } else if (field === 2 && wire === 2) {
      span.spanId = Buffer.from(reader.bytes()).toString("hex");
    } else if (field === 4 && wire === 2) {
      span.parentSpanId = Buffer.from(reader.bytes()).toString("hex");
    } else if (field === 5 && wire === 2) {
      span.name = reader.string();
    } else if (field === 9 && wire === 2) {
      const attribute = decodeAttribute(reader.bytes());
      if (attribute.key) {
        span.attributes[attribute.key] = attribute.value;
      }
    } else if (field === 15 && wire === 2) {
      span.statusCode = decodeStatus(reader.bytes());
    } else {
      reader.skip(wire);
    }
  }
  return span;
}

function decodeScopeSpans(message: Uint8Array) {
  const reader = new ProtoReader(message);
  const spans: CapturedSpan[] = [];
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 2 && wire === 2) {
      spans.push(decodeSpan(reader.bytes()));
    } else {
      reader.skip(wire);
    }
  }
  return spans;
}

function decodeResourceSpans(message: Uint8Array) {
  const reader = new ProtoReader(message);
  const spans: CapturedSpan[] = [];
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 2 && wire === 2) {
      spans.push(...decodeScopeSpans(reader.bytes()));
    } else {
      reader.skip(wire);
    }
  }
  return spans;
}

function decodeTraceRequest(body: Buffer) {
  const reader = new ProtoReader(body);
  const spans: CapturedSpan[] = [];
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      spans.push(...decodeResourceSpans(reader.bytes()));
    } else {
      reader.skip(wire);
    }
  }
  return spans;
}

async function startOtlpReceiver() {
  const spans: CapturedSpan[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    if (request.url === "/v1/traces") {
      spans.push(...decodeTraceRequest(Buffer.concat(chunks)));
    }
    response.writeHead(200, { "content-type": "application/x-protobuf" });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("OTLP receiver did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    spans,
  };
}

async function stopServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function startMockProvider(repoRoot: string) {
  const apiUrl = pathToFileURL(path.join(repoRoot, "extensions/qa-lab/api.ts")).href;
  const source = [
    'import { Command } from "commander";',
    `import { registerQaLabCli } from ${JSON.stringify(apiUrl)};`,
    "const program = new Command();",
    "registerQaLabCli(program);",
    'await program.parseAsync(["node", "qa-provider", "qa", "mock-openai", "--host", "127.0.0.1", "--port", "0"]);',
  ].join("\n");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const match = output.match(/QA mock OpenAI: (http:\/\/127\.0\.0\.1:\d+)/u);
    if (match?.[1]) {
      return { baseUrl: match[1], child };
    }
    if (child.exitCode !== null) {
      throw new Error(`QA mock provider exited early (${child.exitCode}): ${output}`);
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for QA mock provider: ${output}`);
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), sleep(5_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await sleep(100);
  }
  throw new Error("timed out waiting for QA runtime evidence");
}

describe("diagnostics-otel gateway runtime", () => {
  test("exports linked success and failed-tool recovery spans from a real qa-channel run", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../../..");
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    const receiver = await startOtlpReceiver();
    const mock = await startMockProvider(repoRoot);
    const transport = {
      requiredPluginIds: ["qa-channel"],
      createGatewayConfig: ({ baseUrl }: { baseUrl: string }) => ({
        channels: {
          "qa-channel": {
            enabled: true,
            baseUrl,
            botUserId: "openclaw",
            botDisplayName: "OpenClaw QA",
            allowFrom: ["*"],
            pollTimeoutMs: 250,
          },
        },
        messages: {
          visibleReplies: "automatic",
          groupChat: {
            mentionPatterns: ["\\b@?openclaw\\b"],
            visibleReplies: "automatic",
          },
        },
      }),
    };
    const gateway = await startQaGatewayChild({
      repoRoot,
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transport,
      transportBaseUrl: bus.baseUrl,
      enabledPluginIds: ["diagnostics-otel"],
      controlUiEnabled: false,
      mutateConfig: (cfg) => ({
        ...cfg,
        tools: {
          ...cfg.tools,
          codeMode: {
            ...cfg.tools?.codeMode,
            enabled: true,
          },
        },
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            endpoint: receiver.baseUrl,
            protocol: "http/protobuf",
            traces: true,
            metrics: false,
            logs: false,
            sampleRate: 1,
            flushIntervalMs: 1000,
            captureContent: false,
          },
        },
      }),
    });

    try {
      const conversation = { id: "qa-operator", kind: "direct" as const };
      const send = async (text: string) => {
        const cursor = state.getSnapshot().messages.length;
        state.addInboundMessage({
          conversation,
          senderId: "qa-user",
          senderName: "QA User",
          text,
        });
        return await waitFor(() =>
          state
            .getSnapshot()
            .messages.slice(cursor)
            .find(
              (message) =>
                message.direction === "outbound" && message.conversation.id === conversation.id,
            ),
        );
      };

      const successful = await send(
        "Tool progress QA check: use the read tool exactly once on `QA_KICKOFF_TASK.md` before answering. After that read completes, reply with only this exact marker and no other text: `OTEL-GATEWAY-SUCCESS-OK`.",
      );
      expect(successful.text).toContain("OTEL-GATEWAY-SUCCESS-OK");

      const requestCursor = (await fetch(`${mock.baseUrl}/debug/request-cursor`).then((response) =>
        response.json(),
      )) as { cursor: number };
      const recovered = await send(
        "Failed tool terminal recovery QA check: read the missing workspace file, then respond with exact marker: `QA-FAILED-TOOL-FINALIZED-OK`.",
      );
      expect(recovered.text).toContain("The requested file could not be read: ENOENT.");
      expect(recovered.text).toContain("QA-FAILED-TOOL-FINALIZED-OK");

      const scenarioRequests = (await fetch(
        `${mock.baseUrl}/debug/requests?after=${requestCursor.cursor}`,
      ).then((response) => response.json())) as Array<{
        allInputText?: string;
        body?: { input?: Array<Record<string, unknown>>; tools?: unknown[] };
        plannedToolName?: string;
        plannedWireToolName?: string;
        toolOutputCallId?: string;
      }>;
      const readPlans = scenarioRequests.filter((request) => request.plannedToolName === "read");
      const finalizations = scenarioRequests.filter((request) =>
        String(request.allInputText ?? "").includes("Continue from the settled tool result"),
      );
      expect(readPlans).toHaveLength(1);
      expect(readPlans[0]?.plannedWireToolName).toBe("exec");
      expect(finalizations).toHaveLength(1);
      expect(finalizations[0]?.body?.tools ?? []).toHaveLength(0);
      expect(finalizations[0]?.allInputText).toContain(
        "state that failure plainly and do not claim it succeeded",
      );
      const finalizationInput = finalizations[0]?.body?.input ?? [];
      const failedExecCalls = finalizationInput.filter(
        (item) =>
          item.type === "function_call" &&
          item.name === "exec" &&
          String(item.arguments ?? "").includes("qa-failed-terminal-missing-file.txt"),
      );
      const failedExecOutputs = finalizationInput.filter(
        (item) =>
          item.type === "function_call_output" &&
          item.call_id === failedExecCalls[0]?.call_id &&
          /ENOENT|no such file/iu.test(String(item.output ?? "")),
      );
      expect(failedExecCalls).toHaveLength(1);
      expect(failedExecOutputs).toHaveLength(1);
      expect(finalizations[0]?.toolOutputCallId).toBe(failedExecCalls[0]?.call_id);

      const failureEvidence = await waitFor(() => {
        const toolError = receiver.spans.find(
          (span) =>
            span.name === "openclaw.tool.execution" &&
            span.statusCode === 2 &&
            span.attributes["openclaw.toolName"] === "exec" &&
            span.attributes["openclaw.errorCategory"] === "tool_result_error",
        );
        if (!toolError?.traceId) {
          return undefined;
        }
        const sameTrace = receiver.spans.filter((span) => span.traceId === toolError.traceId);
        const run = sameTrace.find((span) => span.name === "openclaw.run");
        const harness = sameTrace.find((span) => span.name === "openclaw.harness.run");
        const modelCalls = sameTrace.filter((span) => span.name === "openclaw.model.call");
        const delivery = sameTrace.find(
          (span) =>
            span.name === "openclaw.message.delivery" &&
            span.attributes["openclaw.channel"] === "qa-channel" &&
            span.attributes["openclaw.outcome"] === "completed" &&
            span.statusCode !== 2,
        );
        return run && harness && modelCalls.length >= 2 && delivery
          ? { delivery, harness, modelCalls, run, sameTrace, toolError }
          : undefined;
      }, 45_000);

      expect(failureEvidence.toolError.parentSpanId).toBeTruthy();
      expect(failureEvidence.harness.parentSpanId).toBeTruthy();
      expect(failureEvidence.modelCalls.every((span) => span.parentSpanId)).toBe(true);
      expect(
        failureEvidence.sameTrace.filter((span) => span.name === "openclaw.run").length,
      ).toBeGreaterThanOrEqual(2);
      expect(failureEvidence.run.spanId).toBeTruthy();
      expect(failureEvidence.delivery.parentSpanId).toBeTruthy();

      const successEvidence = receiver.spans.find(
        (span) =>
          span.name === "openclaw.tool.execution" &&
          span.statusCode !== 2 &&
          span.attributes["openclaw.toolName"] === "exec" &&
          span.traceId !== failureEvidence.toolError.traceId,
      );
      expect(successEvidence).toBeTruthy();
      const successTrace = receiver.spans.filter(
        (span) => span.traceId === successEvidence?.traceId,
      );
      expect(successTrace.some((span) => span.name === "openclaw.run")).toBe(true);
      expect(
        successTrace.some(
          (span) => span.name === "openclaw.harness.run" && Boolean(span.parentSpanId),
        ),
      ).toBe(true);
      expect(
        successTrace.some(
          (span) => span.name === "openclaw.model.call" && Boolean(span.parentSpanId),
        ),
      ).toBe(true);
      expect(
        successTrace.some(
          (span) =>
            span.name === "openclaw.message.delivery" &&
            span.attributes["openclaw.channel"] === "qa-channel" &&
            span.attributes["openclaw.outcome"] === "completed",
        ),
      ).toBe(true);
    } finally {
      await gateway.stop();
      await stopChild(mock.child);
      await stopServer(receiver.server);
      await bus.stop();
    }
  }, 120_000);
});
