import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runAgentLoop } from "../../../../packages/agent-core/src/agent-loop.js";
import type { AgentMessage, AgentTool } from "../../../../packages/agent-core/src/types.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../../test/helpers/openai-responses-sse.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../../config/sessions/test-helpers.js";
import { isTransientNetworkError } from "../../../infra/retryable-network-errors.js";
import type { Message, Model } from "../../../llm/types.js";
import {
  appendSessionTranscriptMessageByIdentity,
  readVisibleSessionTranscriptMessageEntries,
} from "../../../plugin-sdk/session-transcript-runtime.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { createResolvedEmbeddedRunnerModel } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import {
  createSettledFinalizationTestInput,
  createSettledProviderFailureAttempt,
} from "./settled-turn-finalization.test-support.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";

function toLlmMessages(items: AgentMessage[]): Message[] {
  return items.filter(
    (message): message is Message =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  );
}

const fixture = useTempSessionsFixture("settled-provider-error-loopback-");
let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
beforeEach(() => {
  admission = prepareSystemAgentRunAdmission({}, "run-settled", "main", "loopback-finalizer");
});
afterEach(() => admission.close());

it("executes the tool once and finalizes over HTTP after a transient 503", async () => {
  const requests: Array<{ tools?: unknown[] }> = [];
  const server = createServer((request, response) => {
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      if (requests.length === 2) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "upstream connect error: connection refused",
              type: "server_error",
            },
          }),
        );
        return;
      }
      if (requests.length !== 1) {
        writeOpenAiResponsesText(response, {
          text: "Note saved once.",
          messageId: "msg_final",
          responseId: "resp_final",
        });
        return;
      }
      const item = {
        type: "function_call",
        id: "fc_write",
        call_id: "call_write",
        name: "write",
        arguments: "{}",
        status: "completed",
      };
      writeOpenAiResponsesSse(response, [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress" },
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "resp_" + requests.length,
            status: "completed",
            output: [item],
            usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
          },
        },
      ]);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing loopback address");
    }
    const resolved = createResolvedEmbeddedRunnerModel("loopback-provider", "test-model", {
      baseUrl: "http://127.0.0.1:" + address.port + "/v1",
    });
    const model: Model = {
      ...resolved.model,
      input: ["text"],
      contextWindow: 8192,
      maxTokens: 256,
    };
    const target = {
      agentId: "main",
      sessionId: "session-settled",
      sessionKey: "agent:main:settled",
      storePath: path.join(fs.realpathSync(fixture.sessionsDir()), "sessions.json"),
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const persist = (message: AgentMessage) =>
      appendSessionTranscriptMessageByIdentity({ ...target, config: {}, message });
    const note = path.join(fixture.sessionsDir(), "note.txt");
    const execute = vi.fn(async () => {
      fs.appendFileSync(note, "saved\n");
      return { content: [{ type: "text" as const, text: "Note saved once" }], details: {} };
    });
    const tool: AgentTool = {
      name: "write",
      label: "Write",
      description: "Save a note",
      parameters: Type.Object({}),
      execute,
    };
    const stream = createOpenAIResponsesTransportStreamFn();
    const itemLifecycle = { startedCount: 0, completedCount: 0, activeCount: 0 };
    const messages = await runAgentLoop(
      [{ role: "user", content: "Save the note, then summarize.", timestamp: 1 }],
      { systemPrompt: "Save once.", messages: [], tools: [tool] },
      {
        model,
        apiKey: "synthetic-loopback-key",
        convertToLlm: toLlmMessages,
      },
      async (event) => {
        if (event.type === "tool_execution_start") {
          itemLifecycle.startedCount++;
          itemLifecycle.activeCount++;
        }
        if (event.type === "tool_execution_end") {
          itemLifecycle.completedCount++;
          itemLifecycle.activeCount--;
        }
        if (event.type === "message_end") {
          await persist(event.message);
        }
      },
      undefined,
      stream,
    );
    const assistant = messages.at(-1);
    if (assistant?.role !== "assistant") {
      throw new Error("Missing failed provider response");
    }
    expect(assistant.stopReason).toBe("error");
    const error = Object.assign(new Error(assistant.errorMessage), { code: assistant.errorCode });
    expect(isTransientNetworkError(error)).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(itemLifecycle).toEqual({ startedCount: 1, completedCount: 1, activeCount: 0 });
    const prefix = await readVisibleSessionTranscriptMessageEntries(target);
    expect(prefix.some((entry) => entry.message.role === "toolResult")).toBe(true);
    const attempt = createSettledProviderFailureAttempt({
      sessionIdUsed: target.sessionId,
      messagesSnapshot: messages,
      toolMetas: [
        { toolName: "write", toolCallId: "call_write", isError: false, replaySafe: false },
      ],
      itemLifecycle,
    });
    const input = createSettledFinalizationTestInput(attempt, await admission.admit("embedded"));
    input.terminalBase.runParams.trigger = "user";
    input.terminalBase.runParams.config = {};
    input.terminalBase.provider = model.provider;
    input.terminalBase.model = model.id;
    input.terminalBase.activeErrorContext = { provider: model.provider, model: model.id };
    Object.assign(input.finalization.preparedAttempt, resolved, {
      model,
      config: {},
      provider: "loopback-provider",
      modelId: model.id,
      resolvedApiKey: "synthetic-loopback-key",
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      authProfileStore: { version: 1, profiles: {} },
    });
    const finalize = vi.fn<NonNullable<typeof input.finalization.harness.finalizeSettledTurn>>(
      async ({ attempt: prepared, settledAttempt }) => {
        expect(prepared).toMatchObject({
          disableTools: true,
          skipPreparedUserTurnMessage: true,
          suppressNextUserMessagePersistence: true,
        });
        expect(settledAttempt).toBe(attempt);
        const response = await stream(
          model,
          {
            systemPrompt: prepared.prompt,
            messages: toLlmMessages(messages),
            tools: prepared.disableTools ? [] : [tool],
          },
          { apiKey: "synthetic-loopback-key", signal: prepared.abortSignal },
        );
        const answer = await response.result();
        await persist(answer);
        return { assistant: answer, assistantTranscriptOwned: true };
      },
    );
    input.finalization.harness.finalizeSettledTurn = finalize;
    const runAttempt = vi.fn();
    input.finalization.harness.runAttempt = runAttempt;
    const before = prepareEmbeddedRunTerminal({ ...input.terminalBase, ...input.initial });
    expect(before.payloadsWithToolMedia).toEqual([expect.objectContaining({ isError: true })]);
    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(result.finalizationOutcome).toBe("answered");
    expect(finalize).toHaveBeenCalledOnce();
    expect(runAttempt).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(fs.readFileSync(note, "utf8")).toBe("saved\n");
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.tools?.length ?? 0)).toEqual([1, 1, 0]);
    expect(result.prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({ text: "Note saved once." }),
    ]);
    expect(result.prepared.payloadsWithToolMedia?.[0]?.isError).not.toBe(true);
    const transcript = await readVisibleSessionTranscriptMessageEntries(target);
    expect(transcript.slice(0, prefix.length)).toEqual(prefix);
    expect(transcript).toHaveLength(prefix.length + 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
